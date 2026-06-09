// Designated target tab.
//
// Problem: in the cloud-relay model the user watches the claude.ai chat tab
// while Claude drives ANOTHER tab. If actions resolve their tab via
// chrome.tabs.query({active:true}), the moment focus snaps back to claude.ai
// (which it does, repeatedly) every snapshot/action reads the WRONG tab.
//
// Fix: once Claude targets a tab (by id OR url match), we PIN that concrete
// tabId here. All subsequent snapshot/actions route to THAT id via the
// chrome.tabs APIs — never falling back to the active tab — until the pin is
// cleared or the tab is closed. The pin survives the active tab changing AND
// service-worker restarts (mirrored into chrome.storage.session).

const SESSION_KEY = 'fastlink.targetTabId';

let cached = null;        // in-memory mirror: number | null
let hydrated = false;     // have we read storage.session this SW lifetime?

// Pull the pin out of storage.session once per service-worker lifetime. The SW
// can be torn down between actions; session storage persists for the whole
// browser session, so the pin holds across those restarts.
async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const o = await chrome.storage.session.get(SESSION_KEY);
    const v = o?.[SESSION_KEY];
    if (typeof v === 'number') cached = v;
  } catch {}
}

// Async-safe read of the pinned id (hydrates first). Returns number | null.
// Does NOT validate the tab still exists — use resolveTargetTab() for that.
export async function getTargetTabId() {
  await hydrate();
  return cached;
}

// Synchronous best-effort read for hot paths that already ran an async hook
// this turn. May return null on a cold SW before hydrate() has run — callers
// that need correctness must await getTargetTabId()/resolveTargetTab().
export function peekTargetTabId() {
  return cached;
}

export async function setTargetTab(tabId) {
  cached = typeof tabId === 'number' ? tabId : null;
  hydrated = true;
  try { await chrome.storage.session.set({ [SESSION_KEY]: cached }); } catch {}
  return cached;
}

export async function clearTargetTab() {
  cached = null;
  hydrated = true;
  try { await chrome.storage.session.remove(SESSION_KEY); } catch {}
}

// Resolve the pin to a live tab object. If the pinned tab was closed, the pin
// is cleared and null is returned so callers fall back to the active tab.
// Returns the chrome.tabs.Tab, or null when no/stale pin.
export async function resolveTargetTab() {
  await hydrate();
  if (cached == null) return null;
  try {
    return await chrome.tabs.get(cached);
  } catch {
    await clearTargetTab();   // pinned tab no longer exists
    return null;
  }
}

// Auto-clear the pin when the pinned tab is closed, so we don't keep routing to
// a dead id. Registered at module load (SW init), since this module is in the
// import graph of background.js → index.js → tab.js.
try {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (cached != null && tabId === cached) clearTargetTab();
  });
} catch {}

// Warm the cache eagerly on SW start (fire-and-forget).
hydrate();
