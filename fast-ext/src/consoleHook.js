// MAIN-world content script. Wraps console + window error/rejection handlers
// and dispatches a custom event. The ISOLATED-world listener forwards it
// to the service worker (chrome.* is unreachable from MAIN).

(() => {
  if (window.__fb_console_hooked) return;
  window.__fb_console_hooked = true;

  const LEVELS = ['log', 'warn', 'error', 'info'];
  const orig = {};
  for (const lvl of LEVELS) orig[lvl] = console[lvl].bind(console);

  const stringify = (v) => {
    if (v == null) return String(v);
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v instanceof Error) return v.stack || v.message || String(v);
    try { return JSON.stringify(v); } catch { return String(v); }
  };

  const emit = (level, text) => {
    window.dispatchEvent(new CustomEvent('__fb_console', { detail: { level, text, ts: Date.now() } }));
  };

  for (const lvl of LEVELS) {
    console[lvl] = (...args) => {
      orig[lvl](...args);
      emit(lvl, args.map(stringify).join(' ').slice(0, 2000));
    };
  }

  window.addEventListener('error', (e) => {
    emit('error', `${e.message || 'error'} @ ${e.filename || '?'}:${e.lineno || 0}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    emit('error', 'Unhandled rejection: ' + (r?.stack ? r.stack : stringify(r)));
  });
})();
