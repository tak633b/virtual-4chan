// HTTP server: ties the whole simulated internet together.
import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { PORT, PAGE_TOKENS_FAST, PAGE_TOKENS_THINK, SERP_TOKENS, GEN_TIMEOUT_FAST, GEN_TIMEOUT_THINK } from './config';
import { canonicalizeUrl, pageKey, queryKey, seedFor } from './urlkey';
import { getPage, putPage, getSerp, putSerp, worldStats } from './cache';
import { streamChat, pingModel } from './llm';
import { getSettings, updateSettings, defaultSettings } from './settings';
import { serpMessages, pageMessages, parseSerp } from './prompts';
import { rewriteHtml } from './rewrite';
import { renderSerp as renderSerpHtml } from './serpview';
import { renderHome, renderSerp, renderPage, renderErrorBody, renderSettings } from './chrome';

const app = Fastify({ logger: false });

function hostOf(url: string): string { try { return new URL(url).hostname; } catch { return 'the server'; } }

// ---- static assets --------------------------------------------------------
const MIME: Record<string, string> = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
app.get('/public/*', async (req, reply) => {
  const rel = normalize((req.params as any)['*']).replace(/^(\.\.[/\\])+/, '');
  try {
    const buf = await readFile(join(process.cwd(), 'public', rel));
    reply.type(MIME[extname(rel)] || 'application/octet-stream').send(buf);
  } catch { reply.code(404).send('not found'); }
});

// ---- home -----------------------------------------------------------------
app.get('/', async (_req, reply) => reply.type('text/html').send(renderHome(worldStats())));

// ---- SERP shell (cache hit = instant; miss = skeleton then client streams) -
app.get('/search', async (req, reply) => {
  const q = String((req.query as any).q || '').trim();
  if (!q) return reply.redirect('/');
  const cached = getSerp(queryKey(q));
  reply.type('text/html').send(renderSerp({ query: q, cachedHtml: cached?.html }));
});

// ---- page shell -----------------------------------------------------------
app.get('/view', async (req, reply) => {
  const raw = String((req.query as any).url || '').trim();
  if (!raw) return reply.redirect('/');
  const canon = canonicalizeUrl(raw);
  const cached = getPage(pageKey(canon));
  reply.type('text/html').send(renderPage({
    fakeUrl: canon,
    from: (req.query as any).from,
    ctx: (req.query as any).ctx,
    cached: !!cached,
  }));
});

// ---- raw page body (served same-origin into the iframe) -------------------
app.get('/raw', async (req, reply) => {
  const rawUrl = String((req.query as any).url || '').trim();
  if (!rawUrl) return reply.code(400).type('text/html').send(renderErrorBody('No URL was specified.'));
  const canon = canonicalizeUrl(rawUrl);
  const rec = getPage(pageKey(canon));
  if (!rec) return reply.code(404).type('text/html').send(renderErrorBody('This page has not been generated yet.'));
  reply.type('text/html').send(rec.html);
});

// ---- health ---------------------------------------------------------------
app.get('/health', async () => ({ model: await pingModel(), world: worldStats() }));

// ---- settings (point the app at any OpenAI-compatible endpoint) ------------
app.get('/settings', async (_req, reply) => {
  reply.type('text/html').send(renderSettings(getSettings(), defaultSettings(), await pingModel()));
});
app.post('/settings', async (req, reply) => {
  const b = (req.body || {}) as Record<string, unknown>;
  const next = updateSettings({
    baseUrl: typeof b.baseUrl === 'string' ? b.baseUrl : undefined,
    model: typeof b.model === 'string' ? b.model : undefined,
    apiKey: typeof b.apiKey === 'string' ? b.apiKey : undefined,
    thinking: typeof b.thinking === 'boolean' ? b.thinking : undefined,
  });
  // Never echo the key back in clear text.
  reply.send({ ok: true, settings: { ...next, apiKey: next.apiKey ? '••••••' : '' }, ping: await pingModel() });
});

// ---- SSE helper -----------------------------------------------------------
function openSSE(reply: any) {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  raw.write(': open\n\n');
  let closed = false;
  raw.on('close', () => (closed = true));
  return {
    send(event: string, data: unknown) { if (!closed) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); },
    end() { if (!closed) raw.end(); },
    get closed() { return closed; },
    raw,
  };
}

// progress curve: reasoning fills 5->55, content fills 58->97
function progressFor(reasoningChars: number, contentChars: number, contentCap: number): number {
  if (contentChars > 0) return Math.min(97, 58 + Math.floor((contentChars / contentCap) * 39));
  return Math.min(55, 5 + Math.floor((reasoningChars / 3500) * 50));
}

// In-flight de-duplication. Set BEFORE the first await, so two concurrent
// requests for the same uncached key never both generate (closes the
// check-then-generate race): the second awaits the first, then serves the cache.
const inflightPage = new Map<string, Promise<void>>();
const inflightSerp = new Map<string, Promise<void>>();

// ---- streaming page generation --------------------------------------------
app.get('/stream/page', async (req, reply) => {
  const q = req.query as any;
  const rawUrl = String(q.url || '').trim();
  const s = openSSE(reply);
  if (!rawUrl) { s.send('error', { message: 'no URL specified' }); return s.end(); }
  const canon = canonicalizeUrl(rawUrl);
  const key = pageKey(canon);
  const ac = new AbortController();
  s.raw.on('close', () => ac.abort());

  const serveCached = (): boolean => {
    const r = getPage(key);
    if (r) { s.send('done', { kind: 'page', url: canon, title: r.title }); s.end(); return true; }
    return false;
  };
  if (serveCached()) return;
  if (inflightPage.has(key)) {
    s.send('status', { message: `Waiting for ${hostOf(canon)}…`, progress: 30 });
    try { await inflightPage.get(key); } catch { /* generator failed; fall through */ }
    if (serveCached()) return;
  }

  let releaseGate!: () => void;
  inflightPage.set(key, new Promise<void>((r) => (releaseGate = r)));

  const seed = seedFor(key);
  const built = pageMessages(canon, q.ctx ? String(q.ctx) : undefined, q.from ? String(q.from) : undefined, seed);
  const messages = built.messages;
  const thinking = getSettings().thinking;
  const prefill = thinking ? '' : built.prefill; // thinking: let it reason then emit
  const maxTokens = thinking ? PAGE_TOKENS_THINK : PAGE_TOKENS_FAST;
  const timeoutMs = thinking ? GEN_TIMEOUT_THINK : GEN_TIMEOUT_FAST;
  const temperature = 0.4 + (seed % 100) / 333; // stable, mild variety per URL

  let content = '', reasoning = '', lastTick = 0, finishReason = 'stop';
  const tick = (force = false) => {
    const now = Date.now();
    if (!force && now - lastTick < 220) return;
    lastTick = now;
    const phase = content ? `Receiving ${hostOf(canon)}…` : `Contacting ${hostOf(canon)}…`;
    s.send('status', { message: phase, progress: progressFor(reasoning.length, content.length, maxTokens * 3.2) });
  };

  s.send('status', { message: `Resolving ${hostOf(canon)}…`, progress: 3 });
  try {
    for await (const d of streamChat({ messages, prefill, maxTokens, seed, temperature, timeoutMs, signal: ac.signal })) {
      if (s.closed) return;
      if (d.kind === 'reasoning') { reasoning += d.text; tick(); }
      else if (d.kind === 'finish') { finishReason = d.text; }
      else { content += d.text; s.send('chunk', { text: d.text }); tick(); }
    }
    if (!content.trim()) throw new Error('the server returned an empty page');
    const { body, title, outlinks } = rewriteHtml(content, canon); // throws if the output contains no HTML
    // A page truncated at the END (common for rich pages at the token cap) still has its
    // body + links and is re-serialized into valid HTML by the parser — keep it. But a page
    // truncated inside <head>/<style> (the THINKING failure mode: reasoning ate the budget)
    // reaches no body and has ZERO links — that's a dead end, so reject it (retryable, uncached).
    if (outlinks.length === 0) {
      throw new Error(`the page came back with no links (finish_reason=${finishReason}; likely truncated before the body) — retry${finishReason === 'length' ? ', or use fast mode (THINKING=off)' : ''}`);
    }
    putPage(key, canon, title, body);
    s.send('status', { message: 'Rendering…', progress: 100 });
    s.send('done', { kind: 'page', url: canon, title });
  } catch (e: any) {
    // Never cache failures: errors must stay retryable (reload regenerates).
    if (!ac.signal.aborted) s.send('error', { message: e?.message || 'generation failed' });
  } finally {
    inflightPage.delete(key);
    releaseGate();
    s.end();
  }
});

// ---- streaming SERP generation --------------------------------------------
app.get('/stream/search', async (req, reply) => {
  const query = String((req.query as any).q || '').trim();
  const s = openSSE(reply);
  if (!query) { s.send('error', { message: 'no query specified' }); return s.end(); }
  const ac = new AbortController();
  s.raw.on('close', () => ac.abort());

  const key = queryKey(query);
  const serveCached = (): boolean => {
    const r = getSerp(key);
    if (r) { s.send('done', { kind: 'serp', html: r.html }); s.end(); return true; }
    return false;
  };
  if (serveCached()) return;
  if (inflightSerp.has(key)) {
    s.send('status', { message: 'Waiting for results…', progress: 30 });
    try { await inflightSerp.get(key); } catch { /* fall through */ }
    if (serveCached()) return;
  }

  let releaseGate!: () => void;
  inflightSerp.set(key, new Promise<void>((r) => (releaseGate = r)));

  // SERP always uses the JSON prefill anchor: structured output needs it to parse
  // reliably, and ranking/snippets benefit little from deep reasoning. (Thinking mode
  // applies to page generation, where coherence matters and HTML is forgiving.)
  const built = serpMessages(query);
  const messages = built.messages;
  const prefill = built.prefill;
  let content = '', reasoning = '', lastTick = 0;
  const tick = () => {
    const now = Date.now(); if (now - lastTick < 220) return; lastTick = now;
    s.send('status', { message: content ? 'Ranking results…' : 'Searching the simulated web…', progress: progressFor(reasoning.length, content.length, SERP_TOKENS * 3.5) });
  };
  s.send('status', { message: 'Searching the simulated web…', progress: 4 });
  try {
    for await (const d of streamChat({ messages, prefill, maxTokens: SERP_TOKENS, seed: seedFor(key), temperature: 0.7, timeoutMs: GEN_TIMEOUT_FAST, signal: ac.signal })) {
      if (s.closed) return;
      if (d.kind === 'reasoning') { reasoning += d.text; tick(); }
      else if (d.kind === 'finish') { /* parseSerp tolerates truncation */ }
      else { content += d.text; s.send('chunk', { text: d.text }); tick(); }
    }
    const { results, related } = parseSerp(content);
    if (results.length === 0) throw new Error('no results could be parsed from the model output');
    const html = renderSerpHtml(query, results, related);
    putSerp(key, query, html); // only cache a SERP that actually has results
    s.send('done', { kind: 'serp', html });
  } catch (e: any) {
    if (!ac.signal.aborted) s.send('error', { message: e?.message || 'search failed' });
  } finally {
    inflightSerp.delete(key);
    releaseGate();
    s.end();
  }
});

// ---- boot -----------------------------------------------------------------
const server = await app.listen({ port: PORT, host: '0.0.0.0' });
const status = await pingModel();
const cfg = getSettings();
console.log(`\n  🌐  LLM-as-Internet running at ${server}`);
console.log(`      endpoint: ${cfg.baseUrl}`);
console.log(`      model:    ${cfg.model} — ${status.ok ? 'ready' : 'NOT READY: ' + status.detail}`);
console.log(`      thinking: ${cfg.thinking ? 'ON (world-model reasoning; higher fidelity, slower)' : 'off (fast)'}  ·  change at ${server}/settings`);
console.log(`      world:    ${JSON.stringify(worldStats())}\n`);
