// Turns a raw model-generated HTML document into a SAFE, fully self-referential
// page where EVERY link routes back through the simulator. This is what makes the
// internet infinite: click any link and a fresh page is generated for its target.
import { parse } from 'node-html-parser';
import { canonicalizeUrl } from './urlkey';

export interface Rewritten { body: string; title: string; outlinks: string[]; }

const INERT = /^(mailto:|tel:|javascript:|data:|#)/i;

/** Sanitize stray prefixes the model sometimes emits before the document. */
export function sanitizeDoc(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '');
  // Drop anything before the first '<' (e.g. a stray "html: " label).
  const lt = s.indexOf('<');
  if (lt > 0) s = s.slice(lt);
  return s;
}

/**
 * Rewrite all links/forms/images. `baseUrl` is the canonical URL of THIS page,
 * used to resolve relative links to absolute (still-simulated) targets.
 */
export function rewriteHtml(raw: string, baseUrl: string): Rewritten {
  const doc = sanitizeDoc(raw);
  // If the model returned plain text with no markup (e.g. a truncated apology),
  // refuse it — otherwise it would be parsed as a bare text node and cached forever.
  if (doc.indexOf('<') === -1) throw new Error('the server returned no HTML');
  const root = parse(doc, {
    // keep <style> contents (the whole point of fidelity); drop <script> bodies.
    blockTextElements: { script: false, noscript: false, style: true, pre: true, code: true },
  });

  const outlinks: string[] = [];

  // 1) Links -> /view?url=...&from=...&ctx=anchor-text. target=_top so a click
  //    inside the sandboxed iframe navigates the whole app to the next page.
  for (const a of root.querySelectorAll('a')) {
    const href = (a.getAttribute('href') || '').trim();
    if (!href || INERT.test(href)) { a.setAttribute('href', '#'); continue; }
    let abs: string;
    try { abs = canonicalizeUrl(href, baseUrl); } catch { a.setAttribute('href', '#'); continue; }
    if (INERT.test(abs)) { a.setAttribute('href', '#'); continue; }
    const ctx = (a.text || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const target = `/view?url=${encodeURIComponent(abs)}&from=${encodeURIComponent(baseUrl)}&ctx=${encodeURIComponent(ctx)}`;
    a.setAttribute('href', target);
    a.setAttribute('target', '_top');
    a.setAttribute('data-real-href', abs);
    outlinks.push(abs);
  }

  // 2) Forms -> a search form points at /search; everything else is neutralized.
  for (const f of root.querySelectorAll('form')) {
    const action = (f.getAttribute('action') || '').toLowerCase();
    const looksSearch = action.includes('search') || f.querySelector('input[name="q"], input[type="search"], [role="search"]');
    if (looksSearch) {
      f.setAttribute('action', '/search');
      f.setAttribute('method', 'GET');
      f.setAttribute('target', '_top');
      const input = f.querySelector('input[type="search"], input[type="text"], input:not([type])');
      if (input) input.setAttribute('name', 'q');
    } else {
      f.setAttribute('action', '#');
      f.setAttribute('onsubmit', 'return false');
    }
  }

  // 3) Images -> inline gray SVG placeholder labeled with the alt text. No real fetches.
  for (const img of root.querySelectorAll('img')) {
    const alt = (img.getAttribute('alt') || 'image').replace(/\s+/g, ' ').trim().slice(0, 40);
    img.setAttribute('src', placeholder(alt));
    img.removeAttribute('srcset');
    img.removeAttribute('loading');
  }
  for (const s of root.querySelectorAll('source')) s.remove();

  // 4) Strip scripts and external stylesheets/icons (keep inline <style>).
  for (const s of root.querySelectorAll('script')) s.remove();
  for (const l of root.querySelectorAll('link')) {
    const rel = (l.getAttribute('rel') || '').toLowerCase();
    if (rel.includes('stylesheet') || rel.includes('icon') || rel.includes('preload')) l.remove();
  }

  // 5) Strip every inline event handler (on*) and executable URL schemes on
  //    every attribute the browser will fetch. The iframe sandbox in renderPage
  //    omits allow-scripts, but /raw served directly to a non-sandboxed tab
  //    would otherwise execute these. CSP at the /raw response is the other
  //    half of this defense.
  //    Note: img src is set to a data:image/svg+xml placeholder in step 3 above,
  //    so we only strip the actually-dangerous schemes here — not all data: URIs.
  const EXEC_URL = /^(javascript:|vbscript:|data:text\/html|data:application\/(xml|xhtml))/i;
  const URL_ATTRS = ['src', 'srcdoc', 'action', 'formaction', 'background', 'poster', 'data', 'xlink:href'];
  for (const el of root.querySelectorAll('*')) {
    for (const name of Object.keys(el.attributes || {})) {
      if (/^on/i.test(name)) el.removeAttribute(name);
    }
    for (const attr of URL_ATTRS) {
      const v = el.getAttribute(attr);
      if (v && EXEC_URL.test(v.trim())) el.removeAttribute(attr);
    }
  }

  const title = (root.querySelector('title')?.text || '').trim() || 'Untitled';
  return { body: root.toString(), title, outlinks };
}

function placeholder(label: string): string {
  const esc = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="338"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e9edf2"/><stop offset="1" stop-color="#d3dae3"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="50%" font-family="system-ui,sans-serif" font-size="22" fill="#8a97a8" text-anchor="middle" dominant-baseline="middle">${esc}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
