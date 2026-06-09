import { getTargetTab } from './tab.js';
import { pendingNetCount } from '../buffers.js';

// Absolute ceiling on ANY fast_wait, regardless of caller-supplied timeoutMs.
// True network idle almost never happens on modern ad/tracker-heavy pages — a
// long-lived analytics beacon / websocket / poll keeps pending > 0 forever — so
// a wait must NEVER hang the broker. It caps out and resolves with a flag.
const HARD_CAP_MS = 15000;

const capTimeout = (args) =>
  Math.min(typeof args.timeoutMs === 'number' ? args.timeoutMs : 10000, HARD_CAP_MS);

// Wait for the document to finish loading (tab status 'complete'), read straight
// off the tab — no page injection, works on any tab. PREFER this over network
// idle: it fires on virtually every navigation, whereas true network idle on a
// busy site frequently never does. Best-effort: resolves with a flag at the cap,
// never throws / hangs.
export async function waitForDomReady(args = {}) {
  let tab = await getTargetTab();
  if (!tab) return { error: 'No active tab' };
  const timeoutMs = capTimeout(args);
  const pollMs = 100;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (tab && tab.status === 'complete') {
      return { ready: true, mode: 'domready', waitedMs: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, pollMs));
    tab = await getTargetTab();           // re-read status each poll
    if (!tab) break;
  }
  return {
    ready: tab?.status === 'complete' || false,
    mode: 'domready', timedOut: true, waitedMs: Date.now() - start,
  };
}

// Wait until in-flight network requests (tracked via webRequest, so includes
// fetch, XHR, image, beacon) drop to 0 and stay there for `idleMs`. BEST-EFFORT:
// network idle is a nice-to-have, not a guarantee. On a page with a persistent
// request it never settles, so at the (hard-capped) timeout we resolve with a
// flag — NOT an error — so the caller can just proceed. Routes to domready when
// asked (so a single fast_wait entry point covers both modes).
export async function waitForNetworkIdle(args = {}) {
  if (args.domready && !args.networkIdle) return waitForDomReady(args);

  const tab = await getTargetTab();
  if (!tab) return { error: 'No active tab' };
  const timeoutMs = capTimeout(args);
  const idleMs    = typeof args.idleMs === 'number' ? args.idleMs : 500;
  const pollMs    = 100;
  const start     = Date.now();
  let idleSince   = null;
  let minPending  = Infinity;

  while (Date.now() - start < timeoutMs) {
    const n = pendingNetCount(tab.id);
    if (n < minPending) minPending = n;
    if (n === 0) {
      if (idleSince == null) idleSince = Date.now();
      if (Date.now() - idleSince >= idleMs) {
        return { idle: true, mode: 'networkIdle', waitedMs: Date.now() - start, idleMs };
      }
    } else {
      idleSince = null;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  // Cap reached. NOT an error — a lingering request (ads, analytics, websocket)
  // just never lets the page reach true idle. Return what we saw so the caller
  // proceeds instead of treating this as a failure / retrying forever.
  const pending = pendingNetCount(tab.id);
  return {
    idle: false, mode: 'networkIdle', timedOut: true,
    waitedMs: Date.now() - start,
    pending,
    minPending: Number.isFinite(minPending) ? minPending : pending,
    note: 'network never reached idle within the cap (a long-lived request is likely keeping it busy); proceeding is usually fine — prefer domready:true on ad/tracker-heavy pages.',
  };
}
