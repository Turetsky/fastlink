import { getActiveTab } from '../util.js';
import { setTargetTab, clearTargetTab, resolveTargetTab } from './targetTab.js';

// ── SINGLE SOURCE OF TRUTH for "which tab does Claude act on?" ──────────────
// Every action/snapshot/overlay must resolve its tab through these, NOT through
// chrome.tabs.query({active:true}). The designated target tab (a concrete
// pinned id) wins whenever one is set & still alive; only when NO target is
// pinned do we fall back to the active tab. This is the core fix for the
// cloud-relay case: the user sits on the claude.ai tab while Claude drives
// another, so target tab ≠ active tab.

// Resolve the full tab OBJECT Claude should act on (pinned-if-alive, else
// active). Returns null if neither exists.
export async function getTargetTab() {
  return (await resolveTargetTab()) || (await getActiveTab()) || null;
}

// Resolve just the tab id Claude should act on. Returns undefined if none.
export async function getTargetTabId() {
  return (await getTargetTab())?.id;
}

// Fallback re-injection list for when the pre-injected page.js went stale.
// Only page.js — it's the one DOM tools need (window.__fastlink). The console/
// network hooks are deliberately NOT re-injected here: they wrap console/fetch,
// so re-running them could double-wrap (duplicated console/network capture).
// They re-run on their own via the manifest on any real document load.
const MAIN_WORLD_FILES = ['src/actions/page.js'];

export async function handleTabAction(action, args = {}) {
  if (action === 'fast_tab')    return openTab(args);
  if (action === 'fast_nav')    return navigateTab(args);
  if (action === 'fast_reload') return reloadTab(args);
  if (action === 'fast_list')   return listTabs();
  if (action === 'fast_close')  return closeTab(args);
  if (action === 'fast_switch') return switchTab(args);
  return { error: `Unknown tab action: ${action}` };
}

// Bring a tab's OWNING WINDOW to the foreground. `active:true` on tabs.create
// only makes the tab active WITHIN its window — it does NOT focus the window.
// So a default (foreground) fast_tab whose tab lands in a non-focused window is
// still backgrounded as far as captureVisibleTab is concerned (it only grabs the
// active tab of the focused window), which is exactly the reported screenshot
// failure. Focusing the window is what makes the new tab truly foreground &
// screenshottable. Window-focus is INDEPENDENT of the targetTab pin: pinning
// routes actions, focusing decides what's on-screen — we do both, separately.
async function focusTabWindow(tab) {
  try {
    if (tab?.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {}
}

async function openTab({ url, background }) {
  // active:true → foreground-within-window (the parameter default); we ALSO
  // focus the owning window below so "foreground" actually holds on-screen.
  const opts = { url, active: !background };
  try {
    const tab = await chrome.tabs.create(opts);
    // A tab Claude opens is a tab Claude means to drive — pin it so subsequent
    // actions target it even though the user's focus may be elsewhere. Pinning
    // and focusing are independent: the pin is set regardless of background.
    await setTargetTab(tab.id);
    // Default (foreground): focus the owning window so the tab is truly on-screen
    // and captureVisibleTab/screenshot work without a fast_switch first. When
    // background:true we deliberately leave focus alone (active:false above).
    if (!background) await focusTabWindow(tab);
    return { id: tab.id, url: tab.pendingUrl || tab.url, targetTab: tab.id };
  } catch (e) {
    if (!/no current window/i.test(e?.message || '')) throw e;
    // Cold-started SW with no current window: pick any normal window, else
    // create one.
    const [win] = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (win) {
      const tab = await chrome.tabs.create({ ...opts, windowId: win.id });
      await setTargetTab(tab.id);
      if (!background) await focusTabWindow(tab);
      return { id: tab.id, url: tab.pendingUrl || tab.url, targetTab: tab.id };
    }
    const created = await chrome.windows.create({ url, focused: !background });
    const tab = created.tabs?.[0];
    if (tab?.id !== undefined) await setTargetTab(tab.id);
    return { id: tab?.id, url, targetTab: tab?.id };
  }
}

// Resolve once the tab reaches load 'complete', capped so we never hang on a
// slow/never-loading page. Shared by fast_nav and fast_reload.
function waitForComplete(tabId, waitMs) {
  const cap = typeof waitMs === 'number' ? waitMs : 10000;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, cap);
  });
}

// True if the MAIN-world page.js self-attached window.__fastlink.run in the tab.
// This is the SAME liveness check the per-action bridge uses (its
// {__fastlinkMissing} sentinel fires when window.__fastlink.run is absent) — so
// the post-nav health-check and the per-action self-heal agree on "is the page
// channel live?".
async function probeContentScript(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: () => !!(window.__fastlink && window.__fastlink.run),
    });
    return result === true;
  } catch {
    return false;
  }
}

// Probe the MAIN-world page.js a few times with a short settle between tries.
// The declarative content-script injection re-attaches window.__fastlink on the
// new document, but it RACES fast_nav's return: right after load 'complete' the
// script may not have executed yet, so the first probe misses a script that's
// about to attach (and a snapshot taken then comes back empty / networkIdle
// falsely reports idle against the not-yet-live script). Returns true as soon as
// the channel responds.
async function probeUntilLive(tabId, tries = 3, gapMs = 150) {
  for (let i = 0; i < tries; i++) {
    if (await probeContentScript(tabId)) return true;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  return false;
}

async function navigateTab({ url, waitMs }) {
  const tab = await getTargetTab();
  if (!tab) return { error: 'No active tab' };
  await chrome.tabs.update(tab.id, { url });
  // Wait for the navigation to actually finish — without this, a subsequent
  // step in fast_batch lands while Chrome is mid-tear-down of the old page,
  // and our content script's window.__fastlink may be missing or destroyed.
  // Cap at 10s by default to avoid hanging on slow/never-loading pages.
  await waitForComplete(tab.id, waitMs);
  // HEALTH-CHECK the page channel before returning. The pre-injected page.js can
  // be (a) not-yet-attached because the declarative injection races our return,
  // or (b) stale/missing because the extension was reloaded after the tab opened
  // (snapshot empty, networkIdle falsely idle, screenshot readback fails). Probe
  // with a short settle to absorb (a); if it's still not live, re-inject page.js
  // in the same MAIN world as the manifest and re-probe ONCE to fix (b).
  let contentScript = (await probeUntilLive(tab.id)) ? 'fresh' : 'stale';
  if (contentScript === 'stale') {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN', files: MAIN_WORLD_FILES,
      });
      if (await probeContentScript(tab.id)) contentScript = 'reinjected';
    } catch {}
  }
  // Still not live (restricted chrome:// URL, crashed renderer, or inject
  // blocked) → surface 'stale' WITH a clear, machine-readable hint so the caller
  // doesn't silently chase empty snapshots; fast_reload is the recovery path.
  if (contentScript === 'stale') {
    return {
      id: tab.id, url, contentScript,
      hint: 'FastLink\'s content script is not live in the navigated tab — snapshot/click/wait may return empty or falsely idle. Call fast_reload to recover. (Restricted chrome:// / extension-gallery URLs cannot be driven.)',
    };
  }
  return { id: tab.id, url, contentScript };
}

async function reloadTab({ waitMs }) {
  const tab = await getTargetTab();
  if (!tab) return { error: 'No active tab' };
  await chrome.tabs.reload(tab.id, { bypassCache: true });
  await waitForComplete(tab.id, waitMs);
  return { id: tab.id, url: tab.url, reloaded: true };
}

async function listTabs() {
  let tabs = await chrome.tabs.query({ currentWindow: true });
  if (tabs.length === 0) tabs = await chrome.tabs.query({ windowType: 'normal' });
  const pinnedId = (await resolveTargetTab())?.id;
  return tabs.map(t => ({
    id: t.id, url: t.url, title: t.title, active: t.active,
    ...(t.id === pinnedId ? { targetTab: true } : {}),
  }));
}

async function findTab({ tabId, match }) {
  if (tabId) {
    try { return await chrome.tabs.get(tabId); } catch {}
  }
  if (match) {
    const m = String(match).toLowerCase();
    const tabs = await chrome.tabs.query({});
    return tabs.find(t => (t.url || '').toLowerCase().includes(m) || (t.title || '').toLowerCase().includes(m));
  }
  return null;
}

async function closeTab(args) {
  const target = await findTab(args);
  if (!target) return { error: 'No matching tab to close' };
  await chrome.tabs.remove(target.id);
  return { closed: { id: target.id, url: target.url, title: target.title } };
}

async function switchTab(args = {}) {
  // Explicit release: drop the pin so actions resolve the active tab again.
  if (args.clear || args.release || args.unpin) {
    await clearTargetTab();
    return { cleared: true };
  }
  const target = await findTab(args);
  if (!target) return { error: 'No matching tab found. Try fast_list to see available tabs.' };
  // PIN the resolved tabId. This is the core fix: a URL-substring switch
  // resolves to a CONCRETE id and pins it, so it holds even if focus later
  // snaps back to another tab (e.g. the claude.ai chat tab). Pinning happens
  // before the focus change so the pin is set even if focus is rejected.
  await setTargetTab(target.id);
  // Bringing the tab to the foreground is best-effort — if the user clicks
  // away, the pin (not focus) is what routes subsequent actions.
  try {
    await chrome.tabs.update(target.id, { active: true });
    if (target.windowId !== undefined) await chrome.windows.update(target.windowId, { focused: true });
  } catch {}
  return { id: target.id, url: target.url, title: target.title, targetTab: target.id };
}
