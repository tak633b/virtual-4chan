// All prompt construction lives here. Pure functions: (params) -> {messages, prefill}.
// virtual-4chan variant: the simulated universe is a 4chan-flavored anonymous
// imageboard, generated on the fly by the world model.
import { KNOWLEDGE_CUTOFF } from './config';
import type { ChatMessage } from './llm';

export interface SerpResult { title: string; link: string; domain: string; snippet: string; position: number; }

const RE_THREAD = /\/[a-z0-9]+\/thread\/\d+/;
const RE_CATALOG = /^\/[a-z0-9]+\/?(catalog\/?)?$/;
const RE_BOARD_HOST = /(^|\.)(4chan|4channel)\.org$/;
const RE_ARCHIVE_HOST = /(warosu|archived\.moe|desuarchive|4plebs)/;

/** URL → page-genre hint embedded into the page prompt. */
export function classifyUrl(url: string): string {
  let host = '', path = '';
  try { const u = new URL(url); host = u.hostname.toLowerCase(); path = u.pathname.toLowerCase(); } catch { /* */ }
  const isChan = RE_BOARD_HOST.test(host);

  if (isChan && RE_THREAD.test(path)) {
    return 'a 4chan thread page: the OP post at the top with an image placeholder, then a vertical list of reply posts. Each post header line: "Anonymous <sometimes (ID: 8 hex)> <MM/DD/YY(Day)HH:MM:SS> No.<8-or-9-digit-id> ▶". Body may include >greentext lines, >>postNo reply anchors (rendered as quotelinks), the occasional kek/based/cope, and image placeholders inside reply posts. The thread feels like a real /board/ thread in voice: /g/ is technical-but-snarky, /v/ is video-game flamewars, /pol/ is political (keep it tame — no slurs), /lit/ is literary, /mu/ is music recs, /a/ is anime, /sci/ is science Q&A, /ck/ is cooking, /fit/ is fitness. End with a (disabled) reply form and a row of links to other recent threads on the same board.';
  }
  if (isChan && RE_CATALOG.test(path)) {
    return 'a 4chan board catalog page: a grid (12-24 cards) of active threads on this board. Each card shows an image-placeholder thumbnail, the OP first sentence as the thread blurb, "R: <n> / I: <n>" reply/image counts, and a "No.<id>" link to the thread (/<board>/thread/<id>). Board header has the board code in big letters (e.g. "/g/ - Technology") plus the rules line. Bottom links to other boards and the home.';
  }
  if (isChan && (path === '/' || path === '')) {
    return 'the 4chan index page: a directory of all boards grouped by category (Japanese Culture, Video Games, Interests, Creative, Adult, Other, Misc). Each board is "/<code>/ - <name>" as a link.';
  }
  if (RE_ARCHIVE_HOST.test(host)) {
    return 'a 4chan archive page (warosu/archived.moe/desuarchive style): a list of archived threads with search filters, post bodies preserved exactly as on 4chan including greentext and >>quotelinks';
  }
  if (host.includes('wikipedia')) return 'a Wikipedia article (infobox on the right, table of contents, references at the bottom)';
  if (host.includes('reddit')) return 'a Reddit thread (OP post then nested comments with vote counts)';
  if (host.includes('twitter') || host.includes('x.com')) return 'a Twitter/X profile or post timeline';
  if (host.includes('youtube')) return 'a YouTube video watch page (video placeholder, title, channel, view count, description, sidebar of suggested videos)';
  if (host.includes('github')) return 'a GitHub repo page (header, file list, rendered README, sidebar)';
  if (host.includes('news') || /\/\d{4}\/\d{2}\//.test(path)) return 'a news article (headline, byline, dateline, body, related-articles sidebar)';
  if (path === '/' || path === '') return 'the homepage of this site';
  return 'a typical content page for this site';
}

// SERP is framed as the chan archive search (warosu/archived.moe style): given a query,
// return matching archived threads across boards.
const SERP_SYSTEM = `You are a 4chan archive search engine (warosu / archived.moe style). For a query, return matching archived threads from across the boards. Your knowledge cutoff is ${KNOWLEDGE_CUTOFF}.

Return ONLY a JSON object, no prose, no markdown fences. Shape:
{"results":[{"position":1,"title":"<thread OP first sentence>","link":"https://boards.4chan.org/g/thread/12345678","domain":"/g/ - Technology","snippet":"<excerpt of an OP or notable reply, with <b>query terms</b> wrapped>"}, ...], "related":["<related thread title>", ...]}

Rules:
- 9 results across realistic boards (/g/ /v/ /a/ /pol/ /lit/ /sci/ /mu/ /co/ /tv/ /int/ /his/ /sp/ /fit/ /ck/ /x/ /biz/ /diy/ /trv/).
- Link host is boards.4chan.org or an archive (archived.moe, warosu.org, desuarchive.org).
- Domain is "/<code>/ - <Board Name>".
- Title is the thread's OP first sentence — feels like a real 4chan thread (greentext-style stories, opinion threads, "anyone else…", "what does /board/ think of…", recommendation requests, blogpost OPs).
- Snippet is an excerpt that contains the query terms wrapped in <b> tags. Voice matches the board.
- No slurs, no calls to violence, no real-person harassment. Substitute "anon" / "NPC" / softened jargon when channel-typical jargon is needed; keep it readable, in the spirit of the board.`;

export function serpMessages(query: string): { messages: ChatMessage[]; prefill: string } {
  return {
    messages: [
      { role: 'system', content: SERP_SYSTEM },
      { role: 'user', content: `archive_search(query="${query}")` },
    ],
    prefill: '{"results":[',
  };
}

const PAGE_SYSTEM = `You are a Web World Model rendering a 4chan-flavored anonymous imageboard universe. Given a URL and a navigation action, predict the next browser state and emit it as a complete HTML document. Your knowledge cutoff is ${KNOWLEDGE_CUTOFF}.

Output ONLY one complete, self-contained HTML5 document for the destination URL. Your very first characters MUST be <!DOCTYPE html>. No markdown, no code fences, no commentary, no "html:" prefix.

[Thread page — /<board>/thread/<id>/]
- Header bar: board code + name (e.g. "/g/ - Technology"), navigation to catalog & index.
- OP post (first .post.op): a div with the post header line, an image placeholder block (descriptive alt text), then the OP body.
  Header format: "Anonymous <Subject (optional, bold)> <MM/DD/YY(Day)HH:MM:SS> No.<8-9 digit number> ▶"
  /pol/ /int/ /sp/ posts also show an (ID: 8 hex) — add it on those boards.
- Replies: 25-80 .post.reply divs in chronological order. Each has the same header style, optional inline image placeholder, and a body.
- Body content:
  - <span class="greentext">>lines starting with ></span>
  - <a class="quotelink" href="#p<id>">>>postNo</a> reply anchors (use real post numbers from the thread)
  - Plain text otherwise; the occasional "kek", "based", "cope", "ngmi", "anon", board-specific in-jokes
- Board voice (match it):
  - /g/ technical, snarky, OS wars, RTX vs AMD, Terry Davis references, "recommend X for Y"
  - /v/ video-game flamewars, console wars, e-celeb drama
  - /a/ anime opinions, seasonal anime, manga spoilers with <span class="spoiler"> tags
  - /pol/ political opinions — KEEP IT TAME, no slurs, no real-person attacks, focus on policy and meta-discourse
  - /lit/ book recs and pretentious literary takes, philosophy
  - /mu/ album recs, genre snobbery
  - /sci/ science Q&A, "is X theory correct", math threads, IQ posting
  - /fit/ gym, routines, mogging, dyel
  - /ck/ recipes, cooking advice
  - /biz/ crypto pumping, real-estate cope
- Style:
  - Body background #f0e0d6 (yotsuba warm beige). Header brand color #800.
  - Post background slightly lighter; .post.op uses .reply background.
  - Greentext color #789922. Quotelinks color #d00 with dotted underline on hover.
  - Date/header line muted; "Anonymous" name color #117743 and bold.
  - Font: Arial, Helvetica, sans-serif, ~13px, tight line-height.
- End with a (disabled) reply form and a list of other recent /<board>/ threads (5-10 links).

[Catalog page — /<board>/ or /<board>/catalog/]
- Header: big "/<board>/ - <Name>" + rules line.
- Grid of 12-24 cards: each card has an image-placeholder thumbnail, "No.<id>" link, the OP first sentence (~12 words) as the blurb, "R: <n> / I: <n>" reply/image counts.
- Cards link to /<board>/thread/<id>.
- Threads varied: OP-image threads, greentext stories, "ITT we …", question threads, recommendation threads, drama threads.

[Index page — boards.4chan.org/]
- Header brand "yotsuba but virtual".
- Grouped board list (Japanese Culture, Video Games, Interests, Creative, Other, Misc) — each board "/<code>/ - <Name>" as a link to /<code>/.

[Other pages]
- Wikipedia, news, twitter, reddit — render as plausible Web of that style.

[Common rules]
- All CSS inline in one <style> in <head>. No external CSS or fonts.
- NO <script> tags.
- Include 8-14 <a href="..."> in-content links: a mix of same-host (other threads / boards / catalog) and plausible external links (wikipedia, archive sites, twitter, github, news).
- Images: <img> placeholders with descriptive alt text — they will be replaced.
- NO slurs, NO calls to violence, NO doxxing of real people. When typical chan slang would punch sideways, soften to anon/NPC/normie. Keep the wit and voice; lose the hate.`;

export function pageMessages(
  url: string,
  ctx: string | undefined,
  from: string | undefined,
  seed: number,
): { messages: ChatMessage[]; prefill: string } {
  const genre = classifyUrl(url);
  const action = ctx ? `click(link="${ctx}")` : 'navigate(address bar)';
  const coherence = ctx && from
    ? `\nKeep this page consistent with the link that led here (anchor "${ctx}" on ${from}); if same site, reuse the brand/header/footer.`
    : '';
  return {
    messages: [
      { role: 'system', content: PAGE_SYSTEM },
      {
        role: 'user',
        content:
          `Current location: ${from || '(direct navigation)'}\n` +
          `Action: ${action}\n` +
          `Destination URL: ${url}\n` +
          `Page type: ${genre}\n` +
          `World seed: ${seed} (this URL renders the same way every time).${coherence}\n\n` +
          `Predict the full HTML of the page that loads at the destination URL.`,
      },
    ],
    prefill: '<!DOCTYPE html>\n<html lang="en">',
  };
}

// ---- tolerant SERP JSON extraction -----------------------------------------
// The model is prefilled with '{"results":[' and may stop mid-array (token cap)
// or wrap in junk. Recover as many complete result objects as possible.
export function parseSerp(raw: string): { results: SerpResult[]; related: string[] } {
  let text = raw.trim();
  const brace = text.indexOf('{');
  if (brace > 0) text = text.slice(brace);
  text = text.replace(/```json|```/g, '').trim();

  const tryFull = safeJson(text);
  if (tryFull && Array.isArray(tryFull.results)) {
    return { results: coerce(tryFull.results), related: arr(tryFull.related) };
  }
  const results: SerpResult[] = [];
  const objRe = /\{[^{}]*\}/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(text))) {
    const o = safeJson(m[0]);
    if (o && (o.title || o.link)) results.push(...coerce([o]));
  }
  let related: string[] = [];
  const relM = text.match(/"related"\s*:\s*\[([^\]]*)\]/);
  if (relM && relM[1]) related = relM[1].split(',').map((s) => s.replace(/^[\s"]+|[\s"]+$/g, '')).filter(Boolean);
  return { results, related };
}

// LLM output is unstructured — these helpers operate on arbitrary parsed JSON.
function safeJson(s: string): any { try { return JSON.parse(s); } catch { return null; } }
function arr(x: any): string[] { return Array.isArray(x) ? x.filter((s: unknown) => typeof s === 'string') : []; }
function coerce(items: any[]): SerpResult[] {
  return items
    .filter((o) => o && (o.title || o.link))
    .map((o, i) => ({
      title: String(o.title || o.domain || 'Untitled'),
      link: normLink(String(o.link || o.url || '')),
      domain: String(o.domain || hostOf(o.link) || 'Web'),
      snippet: String(o.snippet || o.description || ''),
      position: Number.isFinite(o.position) ? Number(o.position) : i + 1,
    }))
    .filter((r) => isRealUrl(r.link));
}
function normLink(link: string): string {
  const t = link.trim();
  if (!t) return '';
  return /^[a-z]+:\/\//i.test(t) ? t : `https://${t.replace(/^\/+/, '')}`;
}
function isRealUrl(link: string): boolean {
  try { const u = new URL(link); return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.'); }
  catch { return false; }
}
function hostOf(link: any): string { try { return new URL(String(link)).hostname; } catch { return ''; } }
