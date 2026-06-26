// Renders validated SERP results into our OWN Google-style markup. Because the
// markup is ours (not the model's), every result link is guaranteed clean and
// already routed through /view.
import type { SerpResult } from './prompts';
import { canonicalizeUrl, seedFor, pageKey } from './urlkey';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Allow only <b> through from model snippets (it highlights query terms); escape the rest.
function snippetHtml(s: string): string {
  return esc(s).replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>');
}

function breadcrumb(link: string): string {
  try {
    const u = new URL(link);
    const segs = u.pathname.split('/').filter(Boolean).slice(0, 3);
    return esc([u.hostname.replace(/^www\./, ''), ...segs].join(' › '));
  } catch { return esc(link); }
}

export function renderSerp(query: string, results: SerpResult[], related: string[]): string {
  const seconds = (0.18 + (seedFor(query) % 60) / 100).toFixed(2);
  const cards = results
    .sort((a, b) => a.position - b.position)
    .map((r) => {
      const abs = canonicalizeUrl(r.link);
      const href = `/view?url=${encodeURIComponent(abs)}&from=${encodeURIComponent('search:' + query)}&ctx=${encodeURIComponent(r.title)}`;
      return `<div class="g-result">
        <div class="g-crumb"><span class="g-domain">${esc(r.domain)}</span><cite>${breadcrumb(abs)}</cite></div>
        <a class="g-title" href="${href}"><h3>${esc(r.title)}</h3></a>
        <div class="g-snippet">${snippetHtml(r.snippet)}</div>
      </div>`;
    })
    .join('\n');

  const chips = related
    .slice(0, 8)
    .map((q) => `<a class="g-chip" href="/search?q=${encodeURIComponent(q)}">${esc(q)}</a>`)
    .join('');

  return `<div class="g-serp">
    <div class="g-stats">About ${(results.length * 1_000_000 + (seedFor(query) % 900000)).toLocaleString()} results (${seconds} seconds) — every result hallucinated by the model</div>
    ${cards || '<p style="color:#5f6368">No results materialized. Try another query.</p>'}
    ${related.length ? `<div class="g-related"><h4>Related searches</h4><div class="g-chips">${chips}</div></div>` : ''}
  </div>`;
}

// re-export so server can build a page key from a SERP link if ever needed
export { pageKey };
