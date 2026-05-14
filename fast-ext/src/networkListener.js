// Bridges the MAIN-world network hook to the service worker.

window.addEventListener('__fb_network_body', (e) => {
  try { chrome.runtime.sendMessage({ type: 'fb_network_body', entry: e.detail }); } catch {}
});
