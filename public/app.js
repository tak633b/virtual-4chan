// Client controller for the fake browser. No framework, no build.
(() => {
  const BOOT = window.__BOOT || { mode: 'home', cached: true };

  // --- omnibox: decide URL vs. search query ---------------------------------
  function looksLikeUrl(s) {
    const t = s.trim();
    if (!t || /\s/.test(t)) return false;
    if (/^[a-z]+:\/\//i.test(t)) return true;
    if (/^localhost(:\d+)?(\/|$)/i.test(t)) return true;
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$|\?)/i.test(t);
  }
  function go(value) {
    const v = value.trim();
    if (!v) return;
    if (looksLikeUrl(v)) location.href = '/view?url=' + encodeURIComponent(v);
    else location.href = '/search?q=' + encodeURIComponent(v);
  }

  const omnibox = document.getElementById('omnibox');
  if (omnibox) omnibox.addEventListener('submit', (e) => { e.preventDefault(); go(document.getElementById('address').value); });
  const homebox = document.getElementById('homebox');
  if (homebox) homebox.addEventListener('submit', (e) => { e.preventDefault(); go(document.getElementById('homeinput').value); });

  // --- chrome nav buttons ---------------------------------------------------
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  on('back', () => history.back());
  on('fwd', () => history.forward());
  on('reload', () => location.reload());
  on('home', () => (location.href = '/'));

  // --- overlay helpers ------------------------------------------------------
  const overlay = document.getElementById('overlay');
  const statusEl = document.getElementById('status');
  const barEl = document.getElementById('bar');
  const sourceEl = document.getElementById('source');
  const showOverlay = () => { if (overlay) overlay.hidden = false; };
  const hideOverlay = () => { if (overlay) overlay.hidden = true; };
  function setStatus(msg, progress) {
    if (statusEl && msg) statusEl.textContent = msg;
    if (barEl && typeof progress === 'number') barEl.style.width = progress + '%';
  }
  let srcBuf = '';
  function appendSource(t) {
    if (!sourceEl) return;
    srcBuf += t;
    if (srcBuf.length > 8000) srcBuf = srcBuf.slice(-8000);
    sourceEl.textContent = srcBuf;
    sourceEl.scrollTop = sourceEl.scrollHeight;
  }

  // --- stream consumer ------------------------------------------------------
  function stream(url, { onStatus, onChunk, onDone, onError }) {
    srcBuf = '';
    if (sourceEl) sourceEl.textContent = '';
    const es = new EventSource(url);
    let finished = false;
    es.addEventListener('status', (e) => onStatus(JSON.parse(e.data)));
    es.addEventListener('chunk', (e) => onChunk(JSON.parse(e.data)));
    es.addEventListener('done', (e) => { finished = true; es.close(); onDone(JSON.parse(e.data)); });
    es.addEventListener('error', (e) => {
      if (e.data) { finished = true; es.close(); onError(JSON.parse(e.data)); }
    });
    es.onerror = () => { if (!finished) { es.close(); onError({ message: 'connection to the origin server was lost' }); } };
  }

  // --- mode: SERP -----------------------------------------------------------
  if (BOOT.mode === 'serp' && !BOOT.cached) {
    showOverlay();
    setStatus('Searching the simulated web…', 4);
    stream('/stream/search?q=' + encodeURIComponent(BOOT.q || ''), {
      onStatus: (d) => setStatus(d.message, d.progress),
      onChunk: (d) => appendSource(d.text),
      onDone: (d) => {
        const root = document.getElementById('serp-root');
        if (root && d.html) root.innerHTML = d.html;
        hideOverlay();
      },
      onError: (d) => { setStatus('Search failed: ' + (d.message || ''), 100); setTimeout(hideOverlay, 1500); },
    });
  }

  // --- mode: PAGE -----------------------------------------------------------
  if (BOOT.mode === 'page' && !BOOT.cached) {
    showOverlay();
    setStatus('Resolving ' + hostOf(BOOT.url), 3);
    const frame = document.getElementById('page-frame');
    const qs = '/stream/page?url=' + encodeURIComponent(BOOT.url || '') +
      (BOOT.from ? '&from=' + encodeURIComponent(BOOT.from) : '') +
      (BOOT.ctx ? '&ctx=' + encodeURIComponent(BOOT.ctx) : '');
    stream(qs, {
      onStatus: (d) => setStatus(d.message, d.progress),
      onChunk: (d) => appendSource(d.text),
      onDone: (d) => {
        if (d.title) document.title = d.title;
        if (frame) {
          frame.addEventListener('load', () => hideOverlay(), { once: true });
          frame.src = '/raw?url=' + encodeURIComponent(BOOT.url || '');
          setTimeout(hideOverlay, 1200); // safety net
        } else hideOverlay();
      },
      onError: (d) => { setStatus('This page could not be reached: ' + (d.message || ''), 100); setTimeout(hideOverlay, 1800); },
    });
  }

  function hostOf(u) { try { return new URL(u).hostname + '…'; } catch { return 'the server…'; } }
})();
