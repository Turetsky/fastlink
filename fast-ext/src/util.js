import { resolveTargetTab } from './actions/targetTab.js';
// Static import of cdp (was `await import('./actions/input.js')` at call time):
// dynamic import() is disallowed in the MV3 service-worker global scope and threw
// "import() is disallowed on ServiceWorkerGlobalScope", which broke the CDP
// screenshot fallback (e.g. capturing a backgrounded pinned tab). The
// input.js ↔ util.js cycle is safe: cdp is only referenced inside
// captureViaDebugger (call time), after both modules finish initializing.
import { cdp } from './actions/input.js';

export const getActiveTab = async () => {
  // Honor the designated target pin first, so every chokepoint that resolves a
  // tab through getActiveTab (screenshot, CDP capture, network, waitIdle,
  // buffers, marks, vision) drives the tab Claude pinned — not whatever tab the
  // user's focus has snapped back to. resolveTargetTab returns null (and
  // self-clears a stale pin) when nothing live is pinned, so we fall through to
  // the normal active-tab logic. targetTab.js imports nothing from util.js → no
  // import cycle.
  const pinned = await resolveTargetTab();
  if (pinned) return pinned;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) return tab;
  // MV3 cold-start: a freshly-woken service worker has no "last focused
  // window" until a focus/activate event fires in its lifetime. Fall back to
  // the active tab of the first normal window.
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'], populate: true });
  for (const w of wins) {
    const t = w.tabs?.find(t => t.active);
    if (t) return t;
  }
  return undefined;
};

export const isInjectableUrl = (url) => /^https?:|^file:/.test(url || '');

export async function getInjectableTab() {
  const tab = await getActiveTab();
  if (!tab) return { error: 'No active tab' };
  if (!isInjectableUrl(tab.url)) return { error: `Restricted URL: ${tab.url}` };
  return { tab };
}

export async function injectInTab({ world = 'MAIN', func, args = [] }) {
  const got = await getInjectableTab();
  if (got.error) return got;
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: got.tab.id }, world, func, args,
  });
  return { tab: got.tab, result };
}

// chrome.tabs.captureVisibleTab copies the rendered surface out of the GPU
// compositor and intermittently throws "image readback failed" when that
// process stalls/wedges (page renders fine, DOM fine, only the bitmap copy
// fails). It ALSO enforces a ~2 calls/sec quota (MAX_CAPTURE_VISIBLE_TAB_
// CALLS_PER_SECOND) — so fast retries make things WORSE, tripping the quota and
// prepending a misleading quota string to the GPU error. So: at most 2 attempts,
// spaced ≥750ms to stay under the quota. Returns a DEVICE-px dataUrl (CSS px ×
// dpr), so callers that map coordinates by dpr stay correct. Throws on failure.
export async function captureVisibleRetry(capOpts = { format: 'png' }, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 750)); // stay under the per-second quota
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(undefined, capOpts);
      if (dataUrl) return dataUrl;
      lastErr = new Error('captureVisibleTab returned empty');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('captureVisibleTab failed');
}

// Capture via CDP Page.captureScreenshot — NOT subject to the captureVisibleTab
// per-second quota, and able to read from the window surface (fromSurface:false)
// rather than the GPU compositor. CRITICAL: it reuses the SHARED persistent
// debugger session from input.js (via cdp()), instead of its own attach/detach.
// The old version attached/detached itself, which (a) collided with input.js's
// always-on session → "already attached" throw (this is why the fallback was
// "also failing"), and (b) toggled the "FastLink is debugging this browser"
// banner, shifting the viewport and breaking coordinate clicks. The shared
// session is already attached during any automation session, so this adds no
// new banner and no quota cost.
export async function captureViaDebugger(capOpts = { format: 'png' }) {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error('no active tab for debugger capture');
  const format = capOpts.format === 'jpeg' ? 'jpeg' : 'png';
  const base = { format, captureBeyondViewport: false };
  if (format === 'jpeg' && typeof capOpts.quality === 'number') base.quality = capOpts.quality;
  // Try the window/screen path first (most likely to survive a wedged GPU
  // compositor), then the surface path.
  let lastErr;
  for (const fromSurface of [false, true]) {
    try {
      const res = await cdp(tab.id, 'Page.captureScreenshot', { ...base, fromSurface });
      if (res?.data) return `data:image/${format};base64,${res.data}`;
      lastErr = new Error('Page.captureScreenshot returned no data');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Page.captureScreenshot failed');
}

// Is a pinned target tab currently OFF-SCREEN? chrome.tabs.captureVisibleTab
// only ever grabs the active tab of the focused window — so in the cloud-relay
// case (user sits on the claude.ai tab while Claude drives a pinned tab in the
// background) it returns the WRONG tab's pixels. CDP Page.captureScreenshot
// targets a concrete tabId and reads a non-focused tab, so capture must route
// through it whenever the pin isn't the on-screen tab. Returns the pinned Tab in
// that case, else null (no pin, or the pinned tab IS the visible one → the fast
// captureVisibleTab path is correct).
export async function pinnedBackgroundTab() {
  let pinned;
  try { pinned = await resolveTargetTab(); } catch { pinned = null; }
  if (!pinned) return null;
  // The tab captureVisibleTab(undefined) would actually grab: active tab of the
  // last-focused window. Compare by id so a pinned tab that is "active" in its
  // own non-focused window still counts as backgrounded.
  let visibleId;
  try {
    const [vis] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    visibleId = vis?.id;
  } catch {}
  return pinned.id === visibleId ? null : pinned;
}

// Pin-aware drop-in for captureVisibleRetry: when Claude's pinned target tab is
// backgrounded, captureVisibleTab would capture the wrong (on-screen) tab, so
// capture the pinned tab via CDP instead (getActiveTab() inside captureViaDebugger
// resolves to the pin). Otherwise use the normal quota-aware visible-tab path.
// Returns a DEVICE-px dataUrl string, same contract as captureVisibleRetry, so
// the dpr-based coordinate math in marks/vision is unchanged.
export async function captureVisiblePinAware(capOpts = { format: 'png' }) {
  const bg = await pinnedBackgroundTab();
  if (bg) return captureViaDebugger(capOpts);
  return captureVisibleRetry(capOpts);
}

// Robust viewport capture for callers that only need pixels (not dpr-accurate
// coordinate mapping, e.g. fast_screenshot). Order matters because the GPU
// wedge is INTERMITTENT and captureVisibleTab is quota-limited:
//   1. one captureVisibleTab — fast, no banner, works when the GPU is healthy
//   2. CDP Page.captureScreenshot — dodges the quota and the wedged compositor
//   3. one more captureVisibleTab, quota-safely spaced, to catch a transient
//      wedge that just cleared
// On total failure, throws an error carrying an actionable .hint.
export async function captureViewport(opts = {}) {
  const format = (opts.format || 'png').toLowerCase();
  const capOpts = { format };
  if (format === 'jpeg' && typeof opts.quality === 'number') capOpts.quality = opts.quality;

  // 0. Pinned-tab-backgrounded path. captureVisibleTab would grab the wrong
  //    (on-screen) tab, so go straight to CDP — which targets the pin by id and
  //    can read a non-focused tab — and do NOT fall back to a visible-tab
  //    capture that would return the WRONG page's pixels.
  const bg = await pinnedBackgroundTab().catch(() => null);
  if (bg) {
    try {
      return { dataUrl: await captureViaDebugger(capOpts), format };
    } catch (e) {
      const err = new Error(
        `capture of the pinned background tab via CDP failed (${e?.message || e}). ` +
        `The pinned tab isn't the on-screen tab, so a visible-tab capture would grab the ` +
        `wrong page — retry in a moment, or fast_switch focus onto the tab.`
      );
      err.hint = 'pinned tab is backgrounded and CDP capture failed; retry or bring the tab to the foreground.';
      throw err;
    }
  }

  // 1. Fast path (no pin, or the pinned tab is the visible one).
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, capOpts);
    if (dataUrl) return { dataUrl, format };
  } catch (_) { /* GPU wedge or quota — fall through */ }

  // 2. CDP path (quota-free, shared debugger session).
  let cdpErr;
  try {
    return { dataUrl: await captureViaDebugger(capOpts), format };
  } catch (e) {
    cdpErr = e;
  }

  // 3. One more captureVisibleTab, spaced to respect the quota.
  try {
    await new Promise((r) => setTimeout(r, 750));
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, capOpts);
    if (dataUrl) return { dataUrl, format };
  } catch (_) { /* fall through to the hint */ }

  const err = new Error(
    `image readback failed — the GPU compositor is wedged and the CDP fallback also failed` +
    (cdpErr?.message ? ` (${cdpErr.message})` : '') +
    `. The wedge is intermittent: a retry in a few seconds may succeed. To fix it for good, ` +
    `fully quit + reopen Chrome, or relaunch Chrome with --disable-gpu.`
  );
  err.hint = 'GPU readback wedged (intermittent — retrying in a few seconds may work); quit+reopen Chrome or relaunch with --disable-gpu for a permanent fix.';
  throw err;
}

export const pushRing = (map, key, entry, max) => {
  if (!key) return;
  let buf = map.get(key);
  if (!buf) { buf = []; map.set(key, buf); }
  buf.push(entry);
  if (buf.length > max) buf.splice(0, buf.length - max);
};
