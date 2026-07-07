import { captureViewport, captureViaDebugger, getActiveTab } from '../util.js';

// fast_screenshot answers "what is on the user's screen RIGHT NOW", so by DEFAULT
// it captures the user's ACTUAL foreground tab — the active tab of the last-focused
// window — NOT the pinned automation target.
//
// LIVE BUG (the reason this changed): capture used to route through
// captureViewport(), which honors the pinned target tab (resolveTargetTab). When
// the target was pinned to an old tab from an earlier fast_tab and the user had
// since moved to a different tab (e.g. the extension Settings page), "screenshot
// the current screen" captured the STALE pinned background tab instead of what the
// user was looking at. A screenshot is inherently about what is visible NOW.
//
// Two preserved escape hatches:
//   • Companion screenshots — the `screenshot:true` flag attached to a DOM action,
//     which ran on the PINNED/driven tab (e.g. in cloud-relay mode where Claude
//     drives a backgrounded tab while the user sits on claude.ai) — pass
//     preferTarget:true to KEEP the pin-aware capture, so they still show the tab
//     the action drove, not the user's foreground tab.
//   • An explicit numeric `tabId` always targets that exact tab.
export async function takeScreenshot(args = {}) {
  try {
    // Companion screenshots stay pin-aware (show the tab the action actually drove).
    if (args.preferTarget && typeof args.tabId !== 'number') {
      return await captureViewport(args);
    }
    return await captureForeground(args);
  } catch (e) {
    return { error: e?.message || String(e), hint: e?.hint };
  }
}

// Resolve the tab to capture: an explicit tabId override, else the user's REAL
// foreground tab (active tab of the last-focused window). Mirrors getActiveTab()'s
// MV3 cold-start fallback (a freshly-woken worker has no "last focused window" yet)
// but DELIBERATELY does NOT consult the pinned target — that is the whole point.
async function resolveForegroundTab(args) {
  if (typeof args.tabId === 'number') {
    try { return await chrome.tabs.get(args.tabId); } catch { /* fall through to foreground */ }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) return tab;
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'], populate: true });
  for (const w of wins) { const t = w.tabs?.find((t) => t.active); if (t) return t; }
  return undefined;
}

async function captureForeground(args = {}) {
  const format = (args.format || 'png').toLowerCase();
  const capOpts = { format };
  if (format === 'jpeg' && typeof args.quality === 'number') capOpts.quality = args.quality;
  const fresh = args.fresh === true || args.freshCapture === true;

  const tab = await resolveForegroundTab(args);
  if (!tab || typeof tab.windowId !== 'number') {
    const err = new Error('no foreground tab to screenshot');
    err.hint = 'no active/last-focused window resolved; focus a Chrome window and retry.';
    throw err;
  }

  // FRESH capture: chrome.tabs.captureVisibleTab can hand back a STALE composited
  // frame (live bug: 3 byte-identical captures across focus changes), because it
  // reads the GPU compositor's last frame, not necessarily a new paint. CDP
  // Page.captureScreenshot reads the live window surface, so it returns a current
  // frame. Use it FIRST when fresh is requested AND the foreground tab is the one
  // CDP would target (getActiveTab honors the pin — don't let a backgrounded pin
  // divert the capture to the wrong tab). Fall through to the normal path on any
  // failure (e.g. advanced control off).
  if (fresh) {
    try {
      const active = await getActiveTab();
      if (active?.id === tab.id) {
        const dataUrl = await captureViaDebugger(capOpts);
        if (dataUrl) return { dataUrl, format, fresh: true };
      }
    } catch (_) { /* fall through to captureVisibleTab */ }
  }

  // captureVisibleTab is PIXEL-based, so it captures restricted pages too — the
  // chrome-extension:// Settings/options page (the exact tab in the live bug),
  // chrome:// pages, the web store — where DOM scripting is blocked. Scope it to
  // the foreground tab's WINDOW so a multi-window setup grabs the right screen.
  // The API enforces ~2 calls/sec, so the retry is spaced to stay under the quota.
  let lastErr;
  for (let i = 0; i < 2; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 750));
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, capOpts);
      if (dataUrl) return { dataUrl, format };
      lastErr = new Error('captureVisibleTab returned empty');
    } catch (e) { lastErr = e; }
  }

  // GPU compositor wedge ("image readback failed"): try the quota-free CDP path —
  // but ONLY when the foreground tab is the one captureViaDebugger would target.
  // captureViaDebugger resolves its tab via getActiveTab(), which HONORS the pin;
  // if a backgrounded pin is diverting getActiveTab to a different tab, using it
  // would capture the WRONG (pinned) page — the very bug being fixed — so skip CDP
  // in that case. The foreground tab is on-screen anyway, so a wedge is unlikely
  // and the spaced retry above is the right recovery.
  try {
    const active = await getActiveTab();
    if (active?.id === tab.id) {
      const dataUrl = await captureViaDebugger(capOpts);
      if (dataUrl) return { dataUrl, format };
    }
  } catch (e) { lastErr = e; }

  const err = new Error(
    `screenshot of the foreground tab failed (${lastErr?.message || lastErr}). ` +
    `The GPU compositor may be intermittently wedged — a retry in a few seconds may succeed.`
  );
  err.hint = 'foreground-tab capture failed (possible intermittent GPU wedge); retry in a few seconds.';
  throw err;
}
