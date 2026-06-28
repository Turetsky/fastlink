import { startConnection, sendEvent }           from './src/connection.js';
import { startRelayConnection, sendRelayEvent, stopRelay }  from './src/relayClient.js';
import { startBufferListeners }                  from './src/buffers.js';
import { dispatchAction }                         from './src/actions/index.js';
import { isInjectableUrl }                        from './src/util.js';
import { checkForUpdate }                         from './src/updateCheck.js';

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
// Relay state changes (connect/disconnect) move the transcript gate, so recompute
// after reconciling the icon. A relay drop immediately flips the gate to inactive.
function reportRelay(payload) { connState.relay = { enabled: true, ...payload }; reconcile(); recomputeRelayActive(); }

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
// EITHER transport is healthy the icon is green. The ICON reflects CONNECTION
// state only; live command ACTIVITY is shown via the BADGE + a title suffix
// (see the activity section below), so the two never clobber each other.
function reconcile() {
  const colors = [colorFor('local', connState.local), colorFor('relay', connState.relay)].filter(Boolean);
  const best = colors.length ? colors.reduce((a, b) => (RANK[b] > RANK[a] ? b : a)) : 'red';
  try { chrome.action.setIcon({ path: ICONS[best] }); } catch {}
  renderTitle();   // connection title + live-activity suffix, composed
  try { chrome.storage.local.set({ fastlinkConn: { local: connState.local, relay: connState.relay } }); } catch {}
}

// ===========================================================================
// GLOBAL ACTIVITY INDICATOR
// ---------------------------------------------------------------------------
// claude.ai (web, via relay) or Claude Code (local broker) can be driving a tab
// the user isn't looking at. The in-page overlay (src/overlay.js) only renders
// on the DRIVEN tab, so it's invisible from any other tab. This makes "is Claude
// working / idle / stuck?" visible GLOBALLY on the toolbar (badge + title) and in
// the popup.
//
// Single chokepoint: trackedDispatch() wraps the SAME dispatchAction both
// transports already call, so EVERY inbound command (relay + broker) is recorded
// without touching src/actions/index.js. State lives in chrome.storage.session so
// a revived MV3 worker can rebuild the badge; in-flight entries from a dead worker
// are cleared on restart (their promises died with it).
// ===========================================================================
const ACTIVITY_KEY = 'fastlink.activity';   // chrome.storage.session
const NOTIFY_FLAG  = 'fastlinkNotify';      // chrome.storage.local (default off)
// Stuck thresholds are ACTION-AWARE. Normal multi-field and vision FORM fills
// legitimately run tens of seconds, so a single low threshold falsely flagged
// them "possibly stuck". Base is 30s; form/vision/long-running actions get ~50s
// grace. computeStuck(), maybeNotifyStuck() and buildActivitySummary() all look
// up the threshold per in-flight action via stuckThreshold(), never a global.
const STUCK_BASE_MS = 30000;                // default: in-flight longer than this → "stuck"
const STUCK_LONG_MS = 50000;                // form / vision / long actions get more grace
// HARD CAP, not a threshold: "stuck" is advisory (the promise may still settle),
// but past this an entry is presumed ORPHANED — its dispatchAction promise will
// never settle (hung CDP call, wedged capture, dead tab) — so tick() evicts it
// and the badge/title/panel return to idle instead of climbing forever. 3 min is
// far above any legitimate action (even LONG ones finish well under a minute).
// A late settlement after eviction is harmless: finish() only Map.deletes by id.
const STUCK_HARD_CAP_MS = 180000;
const STUCK_LONG_ACTIONS = new Set([
  'fast_fill_form', 'fast_fill_vision', 'fast_fill', 'fast_do',
  'fast_scout', 'fast_locate', 'fast_point',
]);
function stuckThreshold(action) {
  return STUCK_LONG_ACTIONS.has(action) ? STUCK_LONG_MS : STUCK_BASE_MS;
}
const TICK_MS      = 500;                   // spinner / live-title cadence
const SPINNER      = ['|', '/', '-', '\\']; // ASCII so the badge always renders
const BADGE_RUN    = '#3a66ff';             // brand indigo = working
const BADGE_STUCK  = '#e07b27';             // brand orange = possibly stuck

// ---- Relay-driving gate (transcript surfaces only) ------------------------
// The transcript pipeline (claude.ai scraper → side panel + active-tab overlay)
// must surface ONLY while claude.ai-web (the cloud RELAY transport) is actively
// driving THIS browser — not when only the local broker (Claude Code/Desktop)
// drives, and not when idle. We tag every tracked command with its transport
// (see trackedDispatch) and define "relay driving active" =
//   relay socket connected  AND  (a relay command is in flight  OR
//                                 a relay command finished within RECENCY).
// The gate boolean is persisted to storage.session so the side panel can read
// it and so a revived MV3 worker can rebuild it from the last relay timestamp.
const RELAY_RECENCY_MS = 25000;             // relay "driving" lingers this long after the last relay command
const RELAY_GATE_KEY   = 'fastlink.relayActive';   // chrome.storage.session — transcript gate

let __actSeq = 0;
const inflight = new Map();   // id -> { action, start, tabId }
let lastDone   = null;        // { action, ok, endedAt, duration }
let stuckActive = false;
let tickTimer  = null;
let spinFrame  = 0;
let burstStart = 0;           // when inflight went 0 -> >0 (for "done" notify)
let burstCount = 0;
const notifiedStuck = new Set();
let notifyEnabled = false;

// Relay-gate state (see RELAY_GATE_KEY above).
let lastRelayTs      = 0;       // ms of the last relay command start/finish
let lastTransport    = null;    // transport of the most recent command ('relay'|'local')
let relayActiveState = false;   // current gate value (relay is driving this browser)
let relayExpiryTimer = null;    // fires when the recency window closes → recompute

function oldestEntry() {
  let o = null;
  for (const e of inflight.values()) if (!o || e.start < o.start) o = e;
  return o;
}
function computeStuck() {
  const now = Date.now();
  for (const e of inflight.values()) if (now - e.start >= stuckThreshold(e.action)) return true;
  return false;
}

// Badge = live activity, independent of the connection ICON set by reconcile().
function applyBadge() {
  try {
    if (stuckActive) {
      chrome.action.setBadgeBackgroundColor({ color: BADGE_STUCK });
      chrome.action.setBadgeText({ text: '!' });
    } else if (inflight.size > 0) {
      chrome.action.setBadgeBackgroundColor({ color: BADGE_RUN });
      chrome.action.setBadgeText({ text: SPINNER[spinFrame % SPINNER.length] });
    } else {
      chrome.action.setBadgeText({ text: '' });   // idle → clear, leave icon alone
    }
  } catch {}
}

// Title = connection text (buildTitle) + a live activity suffix, composed.
function activityTitleSuffix() {
  if (inflight.size > 0) {
    const o = oldestEntry();
    const secs = Math.round((Date.now() - o.start) / 1000);
    const more = inflight.size > 1 ? ` +${inflight.size - 1}` : '';
    return stuckActive
      ? ` — possibly stuck on ${o.action} (${secs}s)${more}`
      : ` — ▶ ${o.action} (${secs}s)${more}…`;
  }
  if (lastDone) {
    const secs = Math.round((Date.now() - lastDone.endedAt) / 1000);
    return ` — idle · last: ${lastDone.action} ${lastDone.ok ? '✓' : '✗'} ${secs}s ago`;
  }
  return '';
}
function renderTitle() {
  try { chrome.action.setTitle({ title: buildTitle() + activityTitleSuffix() }); } catch {}
}

function persistActivity() {
  try {
    chrome.storage.session.set({
      [ACTIVITY_KEY]: {
        running: [...inflight.values()].map((e) => ({ action: e.action, start: e.start, tabId: e.tabId, transport: e.transport })),
        inFlight: inflight.size,
        stuck: stuckActive,
        last: lastDone,
        transport: lastTransport,   // transport of the most recent command ('relay'|'local')
        ts: Date.now(),
      },
    });
  } catch {}
}

function startTicker() { if (!tickTimer) tickTimer = setInterval(tick, TICK_MS); }
function stopTicker()  { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }

// Runs only while ≥1 command is in flight (the worker is alive anyway then, so
// this adds no artificial keepalive). Advances the spinner, recomputes stuck,
// refreshes the live elapsed in the title, and fires stuck notifications.
function tick() {
  spinFrame++;
  // Hard-cap sweep BEFORE recomputing stuck: evict orphaned entries (see
  // STUCK_HARD_CAP_MS) so they can't hold the badge/title/panel non-idle
  // forever. The most recent eviction becomes lastDone (ok:false, timedOut)
  // so the idle title still reads "last: X ✗". Teardown mirrors finish() in
  // trackedDispatch: delete inflight + notifiedStuck, recompute the relay
  // gate, onActivityChange() (badge/title/persist + stopTicker when empty),
  // maybeNotifyDone() once the map drains.
  const now = Date.now();
  let evicted = null;          // latest-started evicted entry → lastDone
  let evictedRelay = false;
  for (const [id, e] of inflight) {
    if (now - e.start >= STUCK_HARD_CAP_MS) {
      inflight.delete(id);
      notifiedStuck.delete(id);
      if (e.transport === 'relay') evictedRelay = true;
      if (!evicted || e.start > evicted.start) evicted = e;
    }
  }
  if (evicted) {
    lastDone = { action: evicted.action, ok: false, endedAt: now, duration: now - evicted.start, timedOut: true };
    // No lastRelayTs bump (nothing finished) — recompute so the gate sees the
    // entry gone; the start-time recency window has long expired by the cap.
    if (evictedRelay) recomputeRelayActive();
    onActivityChange();
    if (inflight.size === 0) { maybeNotifyDone(); return; }
  }
  const wasStuck = stuckActive;
  stuckActive = computeStuck();
  applyBadge();
  renderTitle();
  maybeNotifyStuck();
  // HEARTBEAT for the in-page overlay. While a command runs, the single merged
  // box (src/overlay.js, on the driven tab) relies on these periodic pings to know
  // the worker is still alive. If the worker dies mid-action the pings stop, and
  // the overlay's staleness watchdog neutralizes its frozen "▶ …" row instead of
  // showing it forever. A legitimately long action keeps getting pings, so the
  // watchdog never false-positives on it.
  sendDrivingHeartbeat();
  refreshActiveOverlay();   // re-push transcript+activity → its elapsed stays live + acts as a heartbeat
  if (stuckActive !== wasStuck) persistActivity();
}

// Ping the driving overlay on every tab that currently has a command in flight
// (the driven tab). Fire-and-forget; tabs without an overlay no-op (lastError
// swallowed). entry.tabId is resolved async in trackedDispatch.
function sendDrivingHeartbeat() {
  const seen = new Set();
  for (const e of inflight.values()) {
    const id = e.tabId;
    if (typeof id !== 'number' || seen.has(id)) continue;
    seen.add(id);
    try { chrome.tabs.sendMessage(id, { fastlink: 'event', phase: 'heartbeat' }, () => void chrome.runtime.lastError); } catch {}
  }
}

// Recompute the toolbar after any start/finish and persist for the popup.
function onActivityChange() {
  stuckActive = computeStuck();
  if (inflight.size > 0) startTicker(); else stopTicker();
  applyBadge();
  renderTitle();
  persistActivity();
}

// THE CHOKEPOINT. Both transports are started with this wrapper instead of the
// bare dispatchAction, so relay (claude.ai-web) AND broker (Claude Code) commands
// are tracked. It calls dispatchAction IMMEDIATELY (zero added dispatch latency)
// and resolves the driven tab in the background. `transport` ('relay'|'local')
// is supplied by the per-transport wrappers in startLocal/startRelay; it tags the
// in-flight entry and drives the transcript relay-gate (relay commands only).
function trackedDispatch(action, args, transport) {
  const id = ++__actSeq;
  const start = Date.now();
  const tport = transport === 'relay' ? 'relay' : 'local';
  let p;
  try { p = Promise.resolve(dispatchAction(action, args)); } catch (e) { p = Promise.reject(e); }

  const entry = { action, start, tabId: null, transport: tport };
  lastTransport = tport;
  if (inflight.size === 0) { burstStart = start; burstCount = 0; }
  burstCount++;
  inflight.set(id, entry);
  // A relay command starting (re)opens the relay-driving window.
  if (tport === 'relay') { lastRelayTs = start; recomputeRelayActive(); }

  // Discover the pinned/driven tab without blocking the command.
  chrome.storage.session.get('fastlink.targetTabId').then((o) => {
    const t = o?.['fastlink.targetTabId'];
    if (typeof t === 'number' && inflight.has(id)) { entry.tabId = t; persistActivity(); }
  }).catch(() => {});

  onActivityChange();

  const finish = (ok) => {
    inflight.delete(id);
    notifiedStuck.delete(id);
    lastDone = { action, ok, endedAt: Date.now(), duration: Date.now() - start };
    // A relay command finishing extends the relay-driving window by RECENCY.
    if (tport === 'relay') { lastRelayTs = Date.now(); recomputeRelayActive(); }
    onActivityChange();
    if (inflight.size === 0) maybeNotifyDone();
  };
  return p.then(
    (env) => { finish(!(env && typeof env === 'object' && 'error' in env && env.error !== undefined)); return env; },
    (err) => { finish(false); throw err; },
  );
}

// ---- Relay-driving gate computation ---------------------------------------
// Single source of truth for "is claude.ai-web currently driving this browser?"
// Recomputed on: relay command start/finish, relay connection state change,
// the recency-window expiry timer, and SW startup. When the value flips it is
// persisted (storage.session) and the transcript surfaces are pushed/cleared.
function relayInflight() {
  for (const e of inflight.values()) if (e.transport === 'relay') return true;
  return false;
}
function persistRelayGate() {
  try {
    chrome.storage.session.set({
      [RELAY_GATE_KEY]: { active: relayActiveState, lastRelayTs, ts: Date.now() },
    });
  } catch {}
}
// Arm a one-shot timer to re-evaluate exactly when the recency window closes, so
// the gate flips to inactive on its own after the last relay command (no command
// needed to trigger it). The SW stays alive while in flight; after that it may
// sleep, but RECENCY (25s) < the ~30s idle kill, so this normally fires — and if
// the worker dies first, the startup recompute reads the (now-expired) timestamp.
function scheduleRelayExpiry(connected, now) {
  if (relayExpiryTimer) { clearTimeout(relayExpiryTimer); relayExpiryTimer = null; }
  if (!connected || relayInflight()) return;
  const remaining = (lastRelayTs + RELAY_RECENCY_MS) - now;
  if (remaining > 0) relayExpiryTimer = setTimeout(() => { relayExpiryTimer = null; recomputeRelayActive(); }, remaining + 50);
}
function recomputeRelayActive() {
  const connected = connState.relay?.state === 'connected';
  const now = Date.now();
  const recent = (now - lastRelayTs) <= RELAY_RECENCY_MS;
  const desired = !!connected && (relayInflight() || recent);
  scheduleRelayExpiry(connected, now);
  if (desired !== relayActiveState) {
    relayActiveState = desired;
    persistRelayGate();
    onRelayActiveChange(desired);
  }
}

// ---- Optional desktop notifications (default OFF; toggle in the popup) -------
// Justification: the badge+title+popup are the always-on baseline. Notifications
// are the only signal that reaches a user NOT looking at the toolbar at all, which
// is the exact pain point — but they can nag, so they default off and are
// debounced (one "done" per burst, one "stuck" per command).
function notify(id, title, message) {
  if (!notifyEnabled || !chrome.notifications) return;
  try {
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title,
      message,
      priority: 1,
    }, () => void chrome.runtime.lastError);
  } catch {}
}
function maybeNotifyStuck() {
  if (!notifyEnabled) return;
  const now = Date.now();
  for (const [id, e] of inflight) {
    if (now - e.start >= stuckThreshold(e.action) && !notifiedStuck.has(id)) {
      notifiedStuck.add(id);
      notify(`fastlink-stuck-${id}`, 'FastLink — Claude may be stuck',
        `${e.action} has been running ${Math.round((now - e.start) / 1000)}s with no result.`);
    }
  }
}
function maybeNotifyDone() {
  // Only after a real burst (≥2 commands, or ≥3s of work) so a single quick
  // action doesn't ping.
  if (!notifyEnabled) return;
  const lasted = Date.now() - burstStart;
  if (burstCount >= 2 || lasted >= 3000) {
    notify('fastlink-done', 'FastLink — Claude finished',
      lastDone ? `Last action: ${lastDone.action} ${lastDone.ok ? '✓' : '✗'}.` : 'Driving is idle.');
  }
}

// Load + watch the notification toggle.
chrome.storage.local.get(NOTIFY_FLAG).then((o) => { notifyEnabled = !!o?.[NOTIFY_FLAG]; }).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[NOTIFY_FLAG]) notifyEnabled = !!changes[NOTIFY_FLAG].newValue;
});

// MV3 worker revival: any command that was in flight on the PREVIOUS worker died
// with it (its awaiting promise is gone). Clear stale in-flight, keep the last
// completed action for the idle title/popup, and rebuild the toolbar (badge
// cleared → idle). reconcile() below will repaint the title once connState loads.
chrome.storage.session.get(ACTIVITY_KEY).then((o) => {
  const a = o?.[ACTIVITY_KEY];
  if (a?.last) lastDone = a.last;
  inflight.clear();
  stuckActive = false;
  applyBadge();
  renderTitle();
  persistActivity();
}).catch(() => {});

// Relay-gate revival: restore the last relay timestamp so the recency window can
// survive a worker restart, then recompute. In-flight relay commands died with
// the old worker (inflight was cleared above), and the relay socket re-dials
// async — so the gate seeds inactive here and re-activates when the relay
// reconnects (reportRelay) or the next relay command arrives.
chrome.storage.session.get(RELAY_GATE_KEY).then((o) => {
  const g = o?.[RELAY_GATE_KEY];
  if (g && typeof g.lastRelayTs === 'number') lastRelayTs = g.lastRelayTs;
  recomputeRelayActive();
}).catch(() => { recomputeRelayActive(); });

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
  transports.push(startConnection((a, ar) => trackedDispatch(a, ar, 'local'), { onState: reportLocal }));
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
  transports.push(startRelayConnection((a, ar) => trackedDispatch(a, ar, 'relay'), { wssUrl, deviceToken: c.deviceToken, onState: reportRelay }));
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

// ---------------------------------------------------------------------------
// Auto-update CHECK (notify-only). Reads the latest published version from the
// PUBLIC GitHub repo (src/updateCheck.js) and records it in
// chrome.storage.local['fastlinkUpdate'] for the popup banner. NOT a self-
// installer — the unpacked / self-distributed model has no silent update path;
// the user pulls + reloads (or downloads the release). See updateCheck.js.
//
// Its own dedicated alarm survives MV3 worker death. checkForUpdate() self-
// debounces on the stored `checkedAt` (≥6h between real fetches), so the
// startup/install + per-wake calls below are cheap no-ops between cycles and
// can't hammer GitHub. Errors/offline/rate-limit are swallowed inside the module.
// ---------------------------------------------------------------------------
const UPDATE_ALARM = 'fastlink-update-check';
chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 60 * 6, delayInMinutes: 1 });
// ONLY the periodic alarm tick passes selfApply:true, so a no-click self-reload
// can fire STRICTLY from "a periodic check found a newer version AND guards pass"
// — never from a bare SW startup/wake/install (those call checkForUpdate() with
// self-apply OFF). This is the structural half of the loop-safety; the circuit
// breaker + 30-min guard in updateCheck.js are the backstops.
chrome.alarms.onAlarm.addListener((a) => { if (a?.name === UPDATE_ALARM) checkForUpdate({ selfApply: true }); });
chrome.runtime.onStartup.addListener(()   => { checkForUpdate(); });
chrome.runtime.onInstalled.addListener(() => { checkForUpdate(); });
checkForUpdate();   // first fresh-eval check; debounced + no self-apply, so harmless if recent

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

// ===========================================================================
// LIVE TRANSCRIPT PIPELINE  (additive — does NOT touch the activity tracker above)
// ---------------------------------------------------------------------------
// New feature: let the user SEE what Claude is SAYING from any tab while
// claude.ai-web drives the browser. The relay carries only tool calls/results,
// NOT chat prose, so the transcript is SCRAPED from the claude.ai DOM by the
// src/claudeScrape.js content script. That scraper posts {type:'fastlink:transcript'}
// here; we keep the latest in chrome.storage.session and fan it out to TWO
// surfaces that share this ONE pipeline:
//   (a) the side panel (sidepanel.html/js) — subscribes to storage.onChanged.
//   (b) the active-tab floating box (src/overlay.js — the SINGLE merged panel) —
//       pushed here onto whatever tab the user is currently looking at. overlay.js
//       is manifest-injected on every tab, so we just sendMessage the transcript;
//       it folds into the same box that shows the driving rows (no 2nd overlay).
//
// We ALSO read the existing activity state (running/idle/stuck) written to
// 'fastlink.activity' by the tracker above, so both surfaces show BOTH "what
// it's saying" and "what it's doing". We only READ that key here — the tracker
// remains the sole writer, so none of the statusfix work is regressed.
// ===========================================================================
const TRANSCRIPT_KEY = 'fastlink.transcript';
const TARGET_TAB_KEY = 'fastlink.targetTabId';

let activeTabId = null;
let latestTranscript = { available: false, text: '', structured: null, toolActivity: null, permission: null, ts: 0, sourceTabId: null };
let latestActivity = null;               // mirror of 'fastlink.activity' (read-only here)
const overlayInjected = new Set();       // tabIds we've pushed a transcript to this SW lifetime (for targeted teardown)
let refreshScheduled = false;

const TVERB = {
  fast_snapshot: 'Reading page', fast_marks: 'Reading page', fast_text: 'Reading text',
  fast_vision_capture: 'Looking at page', fast_screenshot: 'Capturing screenshot',
  fast_click: 'Clicking', fast_click_xy: 'Clicking', fast_fill: 'Typing', fast_type: 'Typing',
  fast_fill_vision: 'Typing', fast_fill_form: 'Filling form', fast_select_option: 'Selecting',
  fast_nav: 'Navigating', fast_reload: 'Reloading', fast_scroll: 'Scrolling', fast_wheel: 'Scrolling',
  fast_hover: 'Hovering', fast_drag: 'Dragging', fast_wait: 'Waiting', fast_key: 'Pressing key',
  fast_tab: 'Switching tab', fast_switch: 'Switching tab', fast_evaluate: 'Running script',
};
function tVerb(a) { return TVERB[a] || String(a || '').replace(/^fast_/, '').replace(/_/g, ' ') || 'Working'; }

// Normalize the raw 'fastlink.activity' object into the compact summary both
// surfaces render (state + label + elapsed). Uses the SAME action-aware
// stuckThreshold() as the tracker so the two never disagree.
function buildActivitySummary() {
  const a = latestActivity;
  // The transcript overlay represents the claude.ai-WEB (relay) session — so only
  // RELAY-transport commands count as "driving." A local Claude Code command must
  // NOT flip this to running and surface the relay card on the user's tabs.
  // (Older persisted entries lacked `transport`; they filter out → idle, which
  // self-corrects on the next relay command.)
  const running = Array.isArray(a?.running) ? a.running.filter((r) => r.transport === 'relay') : [];
  if (!running.length) return { state: 'idle', last: a?.last || null };
  let oldest = running[0];
  for (const r of running) if (r.start < oldest.start) oldest = r;
  const secs = Math.round((Date.now() - oldest.start) / 1000);
  const stuck = Date.now() - oldest.start >= stuckThreshold(oldest.action);
  const more = running.length > 1 ? ` +${running.length - 1}` : '';
  return { state: stuck ? 'stuck' : 'running', label: tVerb(oldest.action) + more, secs, last: a.last || null };
}

// Push the latest transcript+activity to ONE tab's merged overlay (src/overlay.js).
// De-dup / skip rules (documented):
//   • Not injectable (chrome://, New Tab, settings, file viewers that block
//     scripting) → skip.
//   • The claude.ai SOURCE/chat tab → skip: the user is already reading the chat
//     there, a floating mirror would be redundant. (sourceTabId comes from the
//     scraper's sender.tab.id.)
//   • The DRIVEN tab is NO LONGER skipped — the merged box folds the transcript in
//     alongside the driving rows, so the driven tab SHOULD receive the push.
// ---- Relay-gate fan-out for the transcript surfaces -----------------------
// Called from recomputeRelayActive() whenever the gate flips. ACTIVE → push the
// current transcript to the active tab's overlay + let the claude.ai scraper
// resume sending. INACTIVE → tear the overlay off every tab we injected into,
// blank the stored transcript (so the side panel shows a neutral "no active
// claude.ai session" instead of a stale message), and tell scrapers to pause.
function onRelayActiveChange(active) {
  broadcastGateToScrapers(active);
  if (active) onRelaySessionStart();
  else        clearTranscriptSurfaces();
}

// Relay session just went idle→ACTIVE (the false→true transition). Surface the
// transcript IMMEDIATELY so the user doesn't have to open it manually:
//   1. Resolve the user's current active tab and inject + push the floating
//      transcript overlay onto it right now (don't wait for a tab switch). This is
//      the GUARANTEED surface (pushOverlay still honors the injectable-URL guard +
//      de-dup rules, so chrome:// / the driven / the claude.ai source tab skip).
//   2. Best-effort ONLY: also try to auto-open the side panel (see tryOpenSidePanel).
function onRelaySessionStart() {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((t) => {
    const tab = t && t[0];
    if (tab && typeof tab.id === 'number') { activeTabId = tab.id; pushOverlay(tab.id); }
    else refreshActiveOverlay();
    tryOpenSidePanel(tab?.windowId);
  }).catch(() => { refreshActiveOverlay(); tryOpenSidePanel(); });
}

// Best-effort side-panel auto-open on relay-session start.
// CAVEAT: chrome.sidePanel.open() REQUIRES a user gesture. A background
// "relay session started" event is NOT a gesture, so Chrome will USUALLY REJECT
// this call — that's expected. We swallow the rejection and DO NOT retry. The
// floating overlay (above) is the reliable auto-surface; nothing depends on the
// side panel actually opening here.
function tryOpenSidePanel(windowId) {
  const open = (wid) => {
    if (typeof wid !== 'number') return;
    try {
      const r = chrome.sidePanel?.open?.({ windowId: wid });
      if (r && typeof r.catch === 'function') r.catch(() => {});   // promise reject (no gesture) — swallow
    } catch {}                                                      // sync throw — swallow
  };
  try {
    if (typeof windowId === 'number') open(windowId);
    else chrome.windows.getLastFocused().then((w) => open(w?.id)).catch(() => {});
  } catch {}
}

// Tell the active-tab overlay to remove itself ({active:false}) on every tab we
// injected into, and blank the side-panel transcript store.
function clearTranscriptSurfaces() {
  for (const tabId of overlayInjected) {
    try { chrome.tabs.sendMessage(tabId, { fastlink: 'transcript', active: false }, () => void chrome.runtime.lastError); } catch {}
  }
  // overlayInjected only holds tabs injected during THIS worker lifetime — it is
  // empty after an MV3 worker restart, so a transcript overlay injected by a
  // previous worker would be orphaned and never told to clear. Reach those too by
  // querying real tabs and sending the same teardown. The overlay self-removes on
  // {active:false}; tabs without one no-op (lastError swallowed).
  try {
    chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).then((tabs) => {
      for (const t of tabs) {
        if (t.id == null || overlayInjected.has(t.id)) continue;
        try { chrome.tabs.sendMessage(t.id, { fastlink: 'transcript', active: false }, () => void chrome.runtime.lastError); } catch {}
      }
    }).catch(() => {});
  } catch {}
  overlayInjected.clear();
  latestTranscript = { available: false, text: '', structured: null, toolActivity: null, permission: null, ts: Date.now(), sourceTabId: latestTranscript.sourceTabId };
  chrome.storage.session.set({ [TRANSCRIPT_KEY]: latestTranscript }).catch(() => {});
}

// Broadcast the gate to any open claude.ai scraper so it stops sending while the
// relay isn't driving (and force-refreshes a fresh turn the moment it resumes).
function broadcastGateToScrapers(active) {
  chrome.tabs.query({ url: 'https://claude.ai/*' }).then((tabs) => {
    for (const t of tabs) {
      if (t.id == null) continue;
      try { chrome.tabs.sendMessage(t.id, { fastlink: 'relay-active', active }, () => void chrome.runtime.lastError); } catch {}
    }
  }).catch(() => {});
}

// claude.ai itself is the CHAT tab — the user reads Claude's messages natively
// there, so the floating transcript overlay must never ride it. The overlay only
// rides the DRIVEN (non-claude.ai) tabs.
function isClaudeUrl(url) { return /^https?:\/\/([^/]+\.)?claude\.ai(\/|$|\?)/i.test(url || ''); }

// Tell a tab's merged overlay to drop its transcript section ({active:false}) and
// forget it, so a fresh push re-populates it later if that tab becomes a valid
// (driven) target again. overlay.js itself stays (manifest content script).
function teardownOverlay(tabId) {
  if (tabId == null) return;
  try { chrome.tabs.sendMessage(tabId, { fastlink: 'transcript', active: false }, () => void chrome.runtime.lastError); } catch {}
  overlayInjected.delete(tabId);
}

async function pushOverlay(tabId) {
  if (!relayActiveState) return;        // gate: overlay only while claude.ai-web is driving
  if (tabId == null) return;
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  if (!tab || !isInjectableUrl(tab.url)) return;
  // claude.ai chat tab → never mirror; if an overlay lingered (e.g. the user
  // navigated this tab back to claude.ai), tear it off.
  if (isClaudeUrl(tab.url)) { teardownOverlay(tabId); return; }
  if (/^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/.test(tab.url)) return;
  if (tabId === latestTranscript.sourceTabId) return;        // de-dupe: claude.ai source tab
  // NOTE: we intentionally NO LONGER skip the driven tab. src/overlay.js (the
  // manifest-injected ISOLATED content script on every tab) is now the SINGLE
  // floating box: it shows BOTH the "Claude is driving this tab" rows AND the
  // transcript/permission. So the transcript push is routed to that one panel
  // (folded in) instead of injecting a second overlay host. overlay.js is already
  // present from the manifest, so we just sendMessage — no executeScript here
  // (re-injecting overlay.js would rebuild it and wipe live rows mid-action).
  overlayInjected.add(tabId);   // track for targeted {active:false} teardown
  try {
    chrome.tabs.sendMessage(
      tabId,
      { fastlink: 'transcript', transcript: latestTranscript, activity: buildActivitySummary() },
      () => void chrome.runtime.lastError,
    );
  } catch {}
}

// Coalesce bursts (a streaming answer + 500ms activity ticks) into one push.
function refreshActiveOverlay() {
  if (refreshScheduled) return;
  refreshScheduled = true;
  setTimeout(() => { refreshScheduled = false; pushOverlay(activeTabId); }, 60);
}

// Receive scraped transcript; store + fan out. Separate listener so it can't
// interfere with the onboarding/kill-switch listener above (never returns true).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // The claude.ai scraper asks for the current gate on load so it can suppress
  // sends until the relay is actually driving. Answered synchronously.
  if (msg?.type === 'fastlink:gate-query') {
    sendResponse({ active: relayActiveState });
    return true;
  }
  if (msg?.type === 'fastlink:transcript') {
    // GATE: ignore scraped chat text unless claude.ai-web is currently driving
    // this browser. (Scrapers also self-suppress, but background is authoritative.)
    if (!relayActiveState) return false;
    latestTranscript = {
      available: msg.available !== false,
      text: msg.text || '',
      // Structured segmentation of the latest turn ({ lines:[{kind,text}],
      // currentAction }) for legible rendering; raw text kept for back-compat.
      structured: msg.structured || null,
      toolActivity: msg.toolActivity || null,
      // Task D (best-effort): tool-permission prompt awareness from the claude.ai
      // DOM. { present, allowText, denyText } | null.
      permission: msg.permission && msg.permission.present ? msg.permission : null,
      ts: msg.ts || Date.now(),
      sourceTabId: sender?.tab?.id ?? latestTranscript.sourceTabId,
    };
    chrome.storage.session.set({ [TRANSCRIPT_KEY]: latestTranscript }).catch(() => {});  // → side panel
    refreshActiveOverlay();                                                               // → overlay
    return false;
  }
  // Task D (best-effort): user clicked Allow/Deny in the overlay or side panel.
  // Forward the decision into the claude.ai tab(s) so claudeScrape.js clicks the
  // real button in claude.ai's permission dialog. If no real button is found there
  // it just no-ops — we never throw.
  if (msg?.type === 'fastlink:permission-respond') {
    const decision = msg.decision === 'deny' ? 'deny' : 'allow';
    chrome.tabs.query({ url: 'https://claude.ai/*' }).then((tabs) => {
      for (const t of tabs) {
        if (t.id == null) continue;
        try { chrome.tabs.sendMessage(t.id, { fastlink: 'permission-respond', decision }, () => void chrome.runtime.lastError); } catch {}
      }
    }).catch(() => {});
    return false;
  }
  if (msg?.type === 'fastlink:open-sidepanel') {
    try { chrome.sidePanel?.open?.({ tabId: sender?.tab?.id }); } catch {}
    return false;
  }
  return false;
});

// Mirror the activity key (written by the tracker above) and refresh the overlay
// when it changes, so the overlay's running/idle/stuck + elapsed stays live. The
// side panel watches this same key independently.
chrome.storage.session.get(ACTIVITY_KEY).then((o) => { latestActivity = o?.[ACTIVITY_KEY] || null; }).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes[ACTIVITY_KEY]) return;
  latestActivity = changes[ACTIVITY_KEY].newValue || null;
  refreshActiveOverlay();
});

// Track the active tab so the overlay follows the user to whatever tab they're
// LOOKING AT. Each refresh routes through pushOverlay(), which is gated on
// relayActiveState AND on the overlay's own transcriptWorthShowing() — so the
// card mounts ONLY while a relay command is genuinely running/stuck (or a
// permission prompt is up), never on an idle relay. We deliberately do NOT
// preemptively paint new/background tabs anymore: a tab gets the card only once
// it is the active tab AND the relay is actually driving (the "card on every new
// tab while idle" complaint). Background tabs being driven still show their
// tool-call ROWS via notifyOverlay (the driven/pinned tab), independent of this.
chrome.tabs.onActivated.addListener(({ tabId }) => { activeTabId = tabId; refreshActiveOverlay(); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // A document load wipes the injected content script — drop the guard so it
  // re-injects on the next push.
  if (changeInfo.status === 'loading') overlayInjected.delete(tabId);
  // Only refresh the user's ACTIVE tab on load — never preemptively push onto a
  // backgrounded tab.
  if (changeInfo.status === 'complete' && tab?.active) { activeTabId = tabId; refreshActiveOverlay(); }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  overlayInjected.delete(tabId);
  if (tabId === activeTabId) activeTabId = null;
});
chrome.windows.onFocusChanged.addListener(() => {
  chrome.tabs.query({ active: true, lastFocusedWindow: true })
    .then((t) => { if (t && t[0]) { activeTabId = t[0].id; refreshActiveOverlay(); } })
    .catch(() => {});
});

// Resolve the initial active tab on (re)start. The toolbar click opens the POPUP
// card (action.default_popup = "popup.html" in the manifest). We force
// openPanelOnActionClick:false because `true` makes Chrome hijack the action click
// to open the side panel and IGNORE default_popup. The side panel is still reachable
// — from a control in the popup (which calls chrome.sidePanel.open directly) and
// from Chrome's own side-panel menu. setPanelBehavior is best-effort.
chrome.tabs.query({ active: true, lastFocusedWindow: true })
  .then((t) => { if (t && t[0]) activeTabId = t[0].id; refreshActiveOverlay(); })
  .catch(() => {});
try { chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {}); } catch {}

// ---------------------------------------------------------------------------
// STALE-OVERLAY REBIND on service-worker (re)start.
// ---------------------------------------------------------------------------
// When an MV3 worker is killed and revived (or the extension is reloaded), any
// overlay already injected on an open tab is ORPHANED: its message channel points
// at the dead worker, so the new worker never pushes it fresh state and it freezes
// on its last lines (e.g. "▶ Switching tab", "↻ extension reloaded —"). The new
// worker can't see those overlays either — overlayInjected resets empty on restart,
// so the normal push/teardown skips them. Actively reconcile the CURRENT tabs once
// on startup:
//   • Merged box (src/overlay.js, manifest-injected on every tab): re-inject a
//     FRESH copy on the driven/active tab. Its re-inject guard removes the orphan
//     host, so the frozen panel is replaced by a clean, live-context instance bound
//     to THIS worker. It mounts lazily on the next tool/transcript push, so
//     re-injecting when idle just clears the orphan.
//   • Transcript section: if the relay isn't driving, tear any orphan transcript
//     off every tab ({active:false} via clearTranscriptSurfaces). When the relay
//     re-activates, onRelaySessionStart() re-pushes a fresh transcript to overlay.js.
function reinjectDrivingOverlay(tabId) {
  if (typeof tabId !== 'number') return;
  chrome.tabs.get(tabId).then((tab) => {
    if (!tab || !isInjectableUrl(tab.url)) return;
    chrome.scripting.executeScript({ target: { tabId }, files: ['src/overlay.js'] }).catch(() => {});
  }).catch(() => {});
}
function rebindOverlaysOnStartup() {
  // Driving panel: the pinned/driven tab is the one that can be frozen mid-action.
  chrome.storage.session.get(TARGET_TAB_KEY)
    .then((o) => reinjectDrivingOverlay(o?.[TARGET_TAB_KEY]))
    .catch(() => {});
  // Also the user's current active tab (it may carry an orphan from before restart).
  chrome.tabs.query({ active: true, lastFocusedWindow: true })
    .then((t) => { const tab = t && t[0]; if (tab) reinjectDrivingOverlay(tab.id); })
    .catch(() => {});
  // Transcript overlay: the relay seeds INACTIVE on restart (the socket re-dials
  // async), so proactively tear any orphan transcript overlay off all tabs. If the
  // relay reconnects and resumes driving, onRelayActiveChange → onRelaySessionStart
  // re-injects a fresh one.
  if (!relayActiveState) clearTranscriptSurfaces();
}
rebindOverlaysOnStartup();

// ===========================================================================
// NO-CLICK SELF-UPDATE — startup handshake + driven-tab refresh.
// ---------------------------------------------------------------------------
// src/updateCheck.js may have called chrome.runtime.reload() to apply a pulled
// update (auto-update on). That reload re-reads the on-disk files and restarts
// THIS worker, so the only place to observe the result is on the next startup.
// updateCheck left a `fastlinkSelfReloaded = { toVersion, at }` handshake; here
// we consume it once:
//   • running === toVersion → the update STUCK (disk had caught up): clear the
//     loop guard, fire a brief "Updated to vX" notification, and refresh the
//     tab(s) Claude is driving so the NEW content script loads into them.
//   • running !== toVersion → disk was LAGGING the reload; just clear the
//     handshake and let the next scheduled (≤6h) check retry. The 30-min guard
//     in updateCheck prevents a tight reload loop in the meantime.
// Idempotent (consumes the flag) and safe on every fresh SW evaluation, so the
// top-level call below covers a chrome.runtime.reload() that doesn't surface as
// onStartup/onInstalled. Placed here so TARGET_TAB_KEY / isClaudeUrl are defined.
// ===========================================================================
const SELF_RELOADED_KEY = 'fastlinkSelfReloaded';
const SELF_ATTEMPT_KEY  = 'fastlinkLastSelfReloadAttempt';
const SELF_RELOAD_LOG_KEY = 'fastlinkSelfReloadLog';   // circuit-breaker log (see updateCheck.js)

// Reload the pinned/driven tab so it picks up the freshly-installed content
// script. Only the tab Claude is actively driving (fastlink.targetTabId) — never
// the claude.ai chat tab, and never a non-http(s) tab.
function refreshDrivenTabs() {
  chrome.storage.session.get(TARGET_TAB_KEY).then((o) => {
    const t = o?.[TARGET_TAB_KEY];
    if (typeof t !== 'number') return;
    chrome.tabs.get(t).then((tab) => {
      if (!tab || !/^https?:/.test(tab.url || '') || isClaudeUrl(tab.url)) return;
      try { chrome.tabs.reload(t); } catch {}
    }).catch(() => {});
  }).catch(() => {});
}

function notifyUpdated(version) {
  try {
    if (!chrome.notifications) return;
    chrome.notifications.create(`fastlink-updated-${version}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: 'FastLink — updated',
      message: `Updated to v${version}.`,
      priority: 0,
    }, () => void chrome.runtime.lastError);
  } catch {}
}

async function handleSelfReloadResult() {
  try {
    const o = await chrome.storage.local.get(SELF_RELOADED_KEY);
    const flag = o?.[SELF_RELOADED_KEY];
    if (!flag || !flag.toVersion) return;
    await chrome.storage.local.remove(SELF_RELOADED_KEY);   // consume once
    const running = chrome.runtime.getManifest().version;
    if (running === flag.toVersion) {
      // Success — disk had caught up and the reload STUCK (no loop). Clear the
      // loop guard (a future update targets a new version anyway) AND the circuit-
      // breaker log: a reload that reaches its target is a healthy update, not a
      // loop, so it must not count toward tripping the breaker. Then notify +
      // refresh tabs. (A reload that does NOT stick — the lag/loop case — leaves
      // its log entry in place, so genuine loops still accumulate toward the trip.)
      chrome.storage.local.remove([SELF_ATTEMPT_KEY, SELF_RELOAD_LOG_KEY]).catch(() => {});
      notifyUpdated(running);
      refreshDrivenTabs();
    }
    // else: disk lagged the reload — flag cleared; the next scheduled check retries.
  } catch {}
}

chrome.runtime.onStartup.addListener(()   => { handleSelfReloadResult(); });
chrome.runtime.onInstalled.addListener(() => { handleSelfReloadResult(); });
handleSelfReloadResult();   // also on every fresh eval (covers chrome.runtime.reload)
