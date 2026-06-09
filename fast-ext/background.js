import { startConnection, sendEvent }           from './src/connection.js';
import { startRelayConnection, sendRelayEvent, stopRelay }  from './src/relayClient.js';
import { startBufferListeners }                  from './src/buffers.js';
import { dispatchAction }                         from './src/actions/index.js';

startBufferListeners();

// FastLink runs TWO independent transports at once, both driving the SAME tab:
//   • local broker (connection.js)  — ws://127.0.0.1 broker; how Claude Code /
//     Desktop drive the tab. Default ON.
//   • cloud relay  (relayClient.js) — outbound WSS to the multi-tenant relay;
//     how claude.ai on the web drives the tab. ON when paired.
// They were previously mutually exclusive, so switching to the relay killed the
// CLI's broker. Now both run together: a command from EITHER transport executes
// via the shared dispatchAction, and each transport replies on its own socket,
// so the right caller gets the result. Each can still be disabled individually.

// ---------------------------------------------------------------------------
// Shared toolbar icon + popup-state reconciliation.
// With two transports live, neither may own the icon or the `fastlinkConn`
// storage key directly (they'd clobber each other). Instead each REPORTS its
// state here; background reconciles a single combined icon and a single
// fastlinkConn object: { local, relay } (each null when that transport is off).
// ---------------------------------------------------------------------------
const ICONS = {
  green:  { 16: 'icons/icon-green-16.png',  32: 'icons/icon-green-32.png',  48: 'icons/icon-green-48.png',  128: 'icons/icon-green-128.png' },
  yellow: { 16: 'icons/icon-yellow-16.png', 32: 'icons/icon-yellow-32.png', 48: 'icons/icon-yellow-48.png', 128: 'icons/icon-yellow-128.png' },
  red:    { 16: 'icons/icon-red-16.png',    32: 'icons/icon-red-32.png',    48: 'icons/icon-red-48.png',    128: 'icons/icon-red-128.png' },
};
const RANK = { red: 0, yellow: 1, green: 2 };

// Latest reported state per transport; null = that transport is not enabled.
const connState = { local: null, relay: null };

function reportLocal(payload) { connState.local = { enabled: true, ...payload }; reconcile(); }
function reportRelay(payload) { connState.relay = { enabled: true, ...payload }; reconcile(); }

// Map a transport's state to an icon color. Local keeps its 2+→green / 1→yellow
// MCP-client rule; relay is green when the WSS is up.
function colorFor(kind, s) {
  if (!s) return null;
  if (s.state === 'connecting') return 'yellow';
  if (kind === 'local') {
    if (s.state === 'connected') return s.clients >= 2 ? 'green' : 'yellow';
    return 'red';
  }
  return s.state === 'connected' ? 'green' : 'red';   // relay: disconnected/auth → red
}

function buildTitle() {
  const parts = [];
  if (connState.local) {
    const s = connState.local;
    parts.push('broker: ' + (s.state === 'connected' ? `${s.clients} client${s.clients === 1 ? '' : 's'}` : s.state));
  }
  if (connState.relay) parts.push(`relay: ${connState.relay.state}`);
  return parts.length ? `FastLink — ${parts.join(' · ')}` : 'FastLink — no transport enabled';
}

// Combined icon = the best (greenest) state across enabled transports, so if
// EITHER transport is healthy the icon is green.
function reconcile() {
  const colors = [colorFor('local', connState.local), colorFor('relay', connState.relay)].filter(Boolean);
  const best = colors.length ? colors.reduce((a, b) => (RANK[b] > RANK[a] ? b : a)) : 'red';
  try { chrome.action.setIcon({ path: ICONS[best] }); } catch {}
  try { chrome.action.setTitle({ title: buildTitle() }); } catch {}
  try { chrome.storage.local.set({ fastlinkConn: { local: connState.local, relay: connState.relay } }); } catch {}
}

// ---------------------------------------------------------------------------
// Transports + persistent event wiring.
// ---------------------------------------------------------------------------
const transports = [];          // active transport hook objects (onAlarm/wake/…)
const senders = [];             // active event senders (sendEvent / sendRelayEvent)
let emitNavigated = () => {};    // fan-out 'navigated' event to all active senders
let localStarted = false;
let relayStarted = false;

function rebuildEmit() {
  emitNavigated = (p) => senders.forEach((s) => { try { s(p); } catch {} });
}

// Start the local broker transport once. Idempotent.
function startLocal() {
  if (localStarted) return;
  localStarted = true;
  transports.push(startConnection(dispatchAction, { onState: reportLocal }));
  senders.push(sendEvent);
  rebuildEmit();
}

// Start the cloud-relay transport once, from the given config. Idempotent —
// safe to call again after a fresh pairing (onboarding) to bring the relay up
// LIVE without an extension reload. No-op if not configured.
function startRelay(c) {
  if (relayStarted) return;
  if (!(c?.deviceToken && (c.relayWssUrl || c.relayBase))) return;
  relayStarted = true;
  const wssUrl = c.relayWssUrl || `${String(c.relayBase).replace(/^http/, 'ws')}/ext`;
  transports.push(startRelayConnection(dispatchAction, { wssUrl, deviceToken: c.deviceToken, onState: reportRelay }));
  senders.push(sendRelayEvent);
  rebuildEmit();
}

// Persistent event listeners MUST be registered synchronously at the top level
// so a fired alarm / window event can revive the service worker after MV3 kills
// it. They fan out to EVERY active transport. They no-op until the async config
// read below populates `transports`; each transport also attempts an immediate
// connect on start, so no wake is lost.
chrome.alarms.onAlarm.addListener((a)       => transports.forEach((t) => t.onAlarm?.(a)));
chrome.windows.onCreated.addListener(()     => transports.forEach((t) => t.onWindowCreated?.()));
chrome.windows.onRemoved.addListener(()     => transports.forEach((t) => t.onWindowRemoved?.()));

// MV3 service workers are ephemeral — Chrome kills them after ~30s idle and
// revives them on events. Whenever the worker (re)starts, each transport re-arms
// its keepalive alarm and reconnects. onStartup fires on browser launch;
// onInstalled on install/update/reload. The top-level config read below also
// reconnects on every fresh evaluation — defense-in-depth that also covers a
// transport chosen on a prior, now-dead worker.
chrome.runtime.onStartup.addListener(()   => transports.forEach((t) => t.wake?.()));
chrome.runtime.onInstalled.addListener(() => transports.forEach((t) => t.wake?.()));

// Tell every active transport when the active tab finishes loading, so the scout
// can pre-warm its page map before Claude ever asks. Fires once per full load
// (SPA route changes don't trigger onUpdated 'complete').
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab || !tab.active || !/^https?:/.test(tab.url || '')) return;
  emitNavigated({ event: 'navigated', url: tab.url, tabId });
});

// The toolbar action now opens popup.html (manifest action.default_popup), which
// shows per-transport status and a "Reload extension" button. This onClicked
// listener does NOT fire while a default_popup is set; it stays only as a
// fallback in case the popup is ever removed. Reloading picks up code edits and
// a transport toggle made in the options page; content scripts in already-open
// tabs still need a tab refresh to pick up the new injection.
chrome.action.onClicked.addListener(() => chrome.runtime.reload());

// Choose transports from stored config. BOTH run by default once configured:
//   • local  — on unless localEnabled === false.
//   • relay  — on when paired (deviceToken + relay URL) unless relayEnabled ===
//              false, or the legacy fastlinkMode === 'local' (back-compat with
//              the old "Use local broker" button, which only flipped that flag).
chrome.storage.local.get(
  ['fastlinkMode', 'localEnabled', 'relayEnabled', 'deviceToken', 'relayWssUrl', 'relayBase'],
).then((c) => {
  const localEnabled    = c.localEnabled !== false;
  const relayConfigured = !!(c.deviceToken && (c.relayWssUrl || c.relayBase));
  const relayEnabled    = relayConfigured && c.relayEnabled !== false && c.fastlinkMode !== 'local';

  if (localEnabled) startLocal();
  if (relayEnabled) startRelay(c);

  reconcile();   // write the initial combined state (covers the both-disabled case)
});

// ---------------------------------------------------------------------------
// Onboarding + live re-pair (no reload).
// ---------------------------------------------------------------------------
// First run: open the onboarding page on fresh install (NOT on update/reload),
// so a brand-new user lands on the one-click "Sign in & connect" flow. Gated to
// reason 'install' so reloads during development don't spawn tabs.
chrome.runtime.onInstalled.addListener((details) => {
  if (details?.reason !== 'install') return;
  try { chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') }); } catch {}
});

// The onboarding/options page pairs the relay (web-auth or manual code) and then
// messages us to bring the relay transport up LIVE — no chrome.runtime.reload(),
// so the open onboarding tab survives to show the "connected" + "add to claude.ai"
// steps. Registered synchronously at top level (MV3) so it can wake a dead worker.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'fastlink:relay-paired') {
    const wasRunning = relayStarted;   // already dialing (possibly an older token)?
    chrome.storage.local.get(
      ['deviceToken', 'relayWssUrl', 'relayBase', 'relayEnabled', 'fastlinkMode'],
    ).then((c) => {
      if (c.relayEnabled !== false && c.fastlinkMode !== 'local') startRelay(c);
      reconcile();
      // wasRunning ⇒ this is a RE-pair; the live transport still holds the old
      // token (relayClient captures it at start), so the caller should reload to
      // pick up the new one. Fresh pairing (the onboarding path) starts live with
      // no reload, so the onboarding tab survives.
      sendResponse({ ok: true, relayStarted, needsReload: wasRunning });
    });
    return true;   // async sendResponse
  }

  // N2 kill-switch: "Stop driving" pause toggle. Sets the session flag (the
  // dispatchAction gate reads it) AND tells the relay so claude.ai gets a clear
  // "paused" signal rather than a silent local refusal.
  if (msg?.type === 'fastlink:driving-pause') {
    const paused = !!msg.paused;
    chrome.storage.session.set({ 'fastlink.drivingPaused': paused }).catch(() => {});
    try { sendRelayEvent({ event: paused ? 'driving_paused' : 'driving_resumed' }); } catch {}
    sendResponse({ ok: true, paused });
    return true;
  }

  // N2 kill-switch: "Disconnect relay" hard stop. claude.ai can't drive until
  // the user reconnects. Keeps the local broker (CLI) running.
  if (msg?.type === 'fastlink:relay-stop') {
    stopRelay();
    connState.relay = null;
    relayStarted = false;   // allow a later reconnect to re-dial
    chrome.storage.local.set({ relayEnabled: false }).catch(() => {});
    reconcile();
    sendResponse({ ok: true });
    return true;
  }

  // Re-enable the relay after a hard disconnect. A reload re-evaluates
  // relayClient (clearing its `stopped` flag) and re-reads config — the clean
  // way back from stopRelay(). Acceptable here since it's an explicit user action.
  if (msg?.type === 'fastlink:relay-reconnect') {
    chrome.storage.local.set({ relayEnabled: true, fastlinkMode: 'relay' })
      .then(() => chrome.runtime.reload());
    sendResponse({ ok: true });
    return true;
  }
  return false;
});
