// Bridges the MAIN-world console hook to the service worker —
// chrome.runtime.* is unreachable from MAIN.

window.addEventListener('__fb_console', (e) => {
  try { chrome.runtime.sendMessage({ type: 'fb_console', entry: e.detail }); } catch {}
});
