// The single choke point for the local model.
//
// Hard-won facts about qwen-agentworld-35b-a3b-oq4-mlx on LM Studio (all verified
// empirically against the live endpoint):
//   1. It is a reasoning model and IGNORES `reasoning_effort` / `enable_thinking`.
//      Left to its own devices it burns the entire token budget on chain-of-thought
//      and emits an EMPTY `content`.
//   2. The REAL kill-switch is an assistant PREFILL: append a final
//      {role:'assistant', content:'<think></think>...'} message. The model then
//      *continues* that text, producing 0 reasoning tokens and immediate content.
//   3. Chain-of-thought (when any) arrives on a separate `reasoning_content` delta
//      channel, never mixed into `content`.
//   4. It sometimes prefixes output with junk like "html: " — sanitized by callers.
//   5. It is single-flight: concurrent requests step on each other, so every call
//      is serialized through one mutex.
import { GEN_TIMEOUT_FAST } from './config';
import { getSettings } from './settings';

export type Role = 'system' | 'user' | 'assistant';
export interface ChatMessage { role: Role; content: string; }
// 'finish' carries the completion's finish_reason (e.g. 'stop' | 'length') as text,
// emitted once when the stream ends — lets callers detect token-limit truncation.
export type Delta = { kind: 'reasoning' | 'content' | 'finish'; text: string };

// ---- single-flight mutex: only one generation talks to the model at a time ----
let tail: Promise<void> = Promise.resolve();
function acquire(): Promise<() => void> {
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  const wait = tail.then(() => release);
  tail = next;
  return wait;
}

interface StreamOpts {
  messages: ChatMessage[];
  prefill: string;       // text the assistant is forced to continue from; '' = let it think
  maxTokens: number;
  seed?: number;
  temperature?: number;
  signal?: AbortSignal;
  timeoutMs?: number;    // hard ceiling for this generation (defaults to the fast budget)
}

/**
 * Stream a completion. Yields reasoning + content deltas as they arrive.
 * The FIRST 'content' delta is prefixed with `prefill` (prefill-stitch) so the
 * caller reconstructs the full document the model believes it is writing.
 */
export async function* streamChat(opts: StreamOpts): AsyncGenerator<Delta> {
  const release = await acquire();
  const { baseUrl, model, apiKey } = getSettings();
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener('abort', onAbort);
  const timeout = setTimeout(() => ac.abort(), opts.timeoutMs ?? GEN_TIMEOUT_FAST);
  let emittedPrefill = false;
  try {
    // A non-empty prefill is appended as an assistant turn the model continues from
    // (the reasoning kill-switch). An empty prefill = no suppression: the model thinks
    // first (reasoning_content) then emits the observation — the trained world-model idiom.
    const msgs = opts.prefill
      ? [...opts.messages, { role: 'assistant', content: opts.prefill }]
      : opts.messages;
    const body = {
      model,
      stream: true,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0.6,
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      messages: msgs,
    };
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`upstream ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }

    const decoder = new TextDecoder();
    let buf = '';
    let finish = '';
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      // SSE frames are separated by double newlines; lines start with "data: "
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { yield { kind: 'finish', text: finish || 'stop' }; return; }
        let json: any;
        try { json = JSON.parse(payload); } catch { continue; }
        const choice = json?.choices?.[0];
        if (choice?.finish_reason) finish = choice.finish_reason;
        const delta = choice?.delta;
        if (!delta) continue;
        const r = delta.reasoning_content;
        if (typeof r === 'string' && r) yield { kind: 'reasoning', text: r };
        const c = delta.content;
        if (typeof c === 'string' && c) {
          if (!emittedPrefill) { emittedPrefill = true; yield { kind: 'content', text: opts.prefill + c }; }
          else yield { kind: 'content', text: c };
        }
      }
    }
    // stream ended without an explicit [DONE]
    yield { kind: 'finish', text: finish || 'stop' };
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', onAbort);
    release();
  }
}

/** Collect a full completion (no streaming surface needed by the caller). */
export async function chatText(opts: StreamOpts): Promise<string> {
  let out = '';
  for await (const d of streamChat(opts)) if (d.kind === 'content') out += d.text;
  return out;
}

/** Is the configured endpoint reachable and is the model available? */
export async function pingModel(): Promise<{ ok: boolean; detail: string }> {
  const { baseUrl, model, apiKey } = getSettings();
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from ${baseUrl}` };
    const data: any = await res.json().catch(() => ({}));
    const ids: string[] = (data?.data || []).map((m: any) => m.id);
    if (ids.length === 0) return { ok: true, detail: 'endpoint reachable' };
    if (ids.includes(model)) return { ok: true, detail: 'loaded' };
    return { ok: false, detail: `'${model}' not found; available: ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? '…' : ''}` };
  } catch (e: any) {
    return { ok: false, detail: `${e?.message || 'unreachable'} (${baseUrl})` };
  }
}
