import { getActiveTab } from '../util.js';
import { pendingNetCount } from '../buffers.js';

// Wait until in-flight network requests (tracked via webRequest, so includes
// all kinds — fetch, XHR, image, beacon) drop to 0 and stay there for `idleMs`.
// SPA flows often need this instead of waiting for specific text.
export async function waitForNetworkIdle(args = {}) {
  const tab = await getActiveTab();
  if (!tab) return { error: 'No active tab' };
  const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 10000;
  const idleMs    = typeof args.idleMs    === 'number' ? args.idleMs    : 500;
  const pollMs    = 100;
  const start     = Date.now();
  let idleSince   = null;

  while (Date.now() - start < timeoutMs) {
    const n = pendingNetCount(tab.id);
    if (n === 0) {
      if (idleSince == null) idleSince = Date.now();
      if (Date.now() - idleSince >= idleMs) {
        return { idle: true, waitedMs: Date.now() - start, idleMs };
      }
    } else {
      idleSince = null;
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  return { error: `Network did not go idle within ${timeoutMs}ms`, pending: pendingNetCount(tab.id) };
}
