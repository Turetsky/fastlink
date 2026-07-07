// Reconnect via chrome.alarms — service workers get killed and revived,
// alarms survive the death.

// Slot LABEL (chrome.storage.local 'fastlinkInstallId', default 'primary') sent
// in `hello` → broker demuxes N profiles by label. Ports: primary/custom → 9876
// (shared, demuxed by label), secondary → 9877 (legacy). Set via options page.
const INSTALL_PORTS = { primary: 9876, secondary: 9877 };
const SHARED_PORT = INSTALL_PORTS.primary; // primary + every custom label dial here
const DEFAULT_INSTALL_ID = 'primary';
const INSTALL_ID_KEY = 'fastlinkInstallId';

// Slot key, mirrors broker/server: lowercase [a-z0-9_-], alnum first, ≤32. '' → default.
function sanitizeInstallId(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[-_]+/, '').slice(0, 32);
}

// Cached after the first storage read so the hot path (ping/event sends) stays
// synchronous. connect() awaits resolveInstallId() before dialing.
let installId = DEFAULT_INSTALL_ID;
let installResolved = false;

async function resolveInstallId() {
  if (installResolved) return installId;
  try {
    const o = await chrome.storage.local.get(INSTALL_ID_KEY);
    const stored = sanitizeInstallId(o?.[INSTALL_ID_KEY]);
    if (stored) installId = stored;
  } catch {}
  installResolved = true;
  return installId;
}

// Broker port for this slot: 'secondary' → 9877, else shared 9876 (demuxed by label).
function currentPort() { return INSTALL_PORTS[installId] || SHARED_PORT; }
const RECONNECT_ALARM = 'fastlink-reconnect';
// Application-level ping every 20s. Two effects:
//   1. Keeps the broker from terminating us as "dead" if WS pong frames don't
//      flow reliably (Chrome MV3 + WSL is suspect).
//   2. Inbound message from the broker (or even just outbound activity here)
//      counts as service-worker activity, extending the 30s idle timer.
const PING_MS = 20_000;
// Capped exponential backoff for in-process reconnects while the worker is
// alive. The 30s alarm is the long-stop that revives a *dead* worker; this
// makes a live worker heal in ~1s after a clean drop instead of waiting up to
// 30s for the next alarm tick. Reset to the floor on every healthy open.
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// When the broker reports this slot is already held by another live profile
// ({type:'slotBusy'}), don't war over it — sit out this long before re-dialing,
// re-checking each cycle whether the other profile has freed the slot. Without
// this the rejected profile would reconnect-and-get-rejected ~once/second.
const SLOT_BUSY_COOLDOWN_MS = 60_000;
// A socket stuck in CONNECTING this long never resolved (e.g. broker gone, or a
// half-open WSL path that never errors). Force-recycle it instead of letting the
// connect()-guard treat the zombie as "already connecting" forever.
const CONNECT_TIMEOUT_MS = 12_000;
// Half-open detection: once the broker has proven it echoes our pings with
// {pong:true}, a healthy socket yields inbound traffic at least every PING_MS.
// If an OPEN socket goes silent for this long, the path is dead (WSL blip /
// broker died without a clean FIN) — recycle it. Gated on pongCapable so an
// older broker that doesn't echo pongs is never falsely recycled while idle.
const STALE_MS = 50_000;
// Broker hosts, tried in order. 127.0.0.1 is the normal path on every platform
// (native broker on macOS / Windows, or WSL2 localhost-forwarding). Each dial
// that never reaches OPEN rotates to the next candidate, so the failover
// MECHANISM is preserved even with a single host.
//
// SHIPPED DEFAULT is 127.0.0.1 only — we do NOT ship a machine-specific WSL VM
// IP (it changes across WSL restarts and leaks a private address). WSL users
// whose localhost-forwarding breaks after a host sleep can append their VM IP
// here as a fallback, e.g. `['127.0.0.1', '172.x.y.z']` (get it with
// `ip addr show eth0` inside WSL). The real cure, though, is restart-wsl.bat.
const HOSTS = ['127.0.0.1'];

const ICONS = {
  green:  { 16: 'icons/icon-green-16.png',  32: 'icons/icon-green-32.png',  48: 'icons/icon-green-48.png',  128: 'icons/icon-green-128.png' },
  yellow: { 16: 'icons/icon-yellow-16.png', 32: 'icons/icon-yellow-32.png', 48: 'icons/icon-yellow-48.png', 128: 'icons/icon-yellow-128.png' },
  red:    { 16: 'icons/icon-red-16.png',    32: 'icons/icon-red-32.png',    48: 'icons/icon-red-48.png',    128: 'icons/icon-red-128.png' },
};

let socket = null;
let hostIdx = 0;              // index into HOSTS of the candidate to dial next
let lastDialOpened = true;    // did the previous dial ever reach OPEN? (true initially so the first dial uses HOSTS[0])
let pingTimer = null;
let reconnectTimer = null;
let backoffMs = BACKOFF_MIN_MS;
let connectStartedAt = 0;     // when the current socket entered CONNECTING
let lastRxTs = 0;             // last inbound frame (proof the path is alive)
let pongCapable = false;      // broker has echoed at least one {pong:true}
let slotBusyUntil = 0;        // sit out reconnects until this ts (slot held by another profile)
let lastClientCount = 0;      // mirror for the popup so a state-only update keeps it
let handler = null;           // dispatchAction, captured so checkHealth can reconnect
// State reporter injected by background.js. When two transports run at once,
// background is the SOLE owner of the toolbar icon and the `fastlinkConn`
// storage key (so the local + relay transports don't clobber each other). If
// no reporter is supplied (standalone use), we fall back to writing both
// directly so this module still works on its own.
let report = null;            // (payload:{state,clients}) => void

export function startConnection(handle, opts = {}) {
  handler = handle;
  report = opts.onState || null;
  ensureAlarm();
  setBadgeForCount(0);
  connect();

  // Return the event hooks; background.js registers the actual chrome listeners
  // synchronously (MV3 requires synchronous registration so a fired alarm can
  // revive a dead service worker). The onWindowCreated hook reacts promptly to
  // a window opening instead of waiting up to 30s for the next alarm tick.
  return {
    // Every alarm tick: prune a zombie socket, then (re)connect if needed.
    onAlarm: (a) => { if (a && a.name === RECONNECT_ALARM) { checkHealth(); connect(); } },
    onWindowCreated: () => { ensureAlarm(); connect(); },
    onWindowRemoved: () => disconnectIfIdle(),
    // Generic "the worker just woke" hook (onStartup/onInstalled): re-arm the
    // alarm and reconnect the previously-active transport.
    wake: () => { ensureAlarm(); checkHealth(); connect(); },
    sendEvent,
  };
}

async function connect() {
  if (socket && socket.readyState === WebSocket.OPEN) return;
  if (socket && socket.readyState === WebSocket.CONNECTING && Date.now() - connectStartedAt < CONNECT_TIMEOUT_MS) return;
  // Only present as "connected" to the broker when this profile actually
  // has a window. Otherwise the SW (kept alive by alarms) would claim the
  // install slot while having zero tabs to serve.
  if (!await hasAnyWindow()) return;
  // Slot-busy cooldown: another live profile holds our slot. Defer dialing until
  // the cooldown elapses, then re-check (the other profile may have closed since).
  const nowTs = Date.now();
  if (nowTs < slotBusyUntil) {
    if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, slotBusyUntil - nowTs);
    return;
  }
  await resolveInstallId();   // resolve this profile's slot (cached) before dialing
  recycle();   // drop any stale/zombie socket before dialing a fresh one

  // Previous dial never opened → that host is unreachable right now; rotate to
  // the next candidate. (Covers refused, connect-timeout recycle, and half-open
  // paths alike, because all of them end without onopen ever firing.)
  if (!lastDialOpened) hostIdx = (hostIdx + 1) % HOSTS.length;
  lastDialOpened = false;

  let ws;
  try { ws = new WebSocket(`ws://${HOSTS[hostIdx]}:${currentPort()}`); }
  catch { scheduleReconnect(); return; }
  socket = ws;
  connectStartedAt = Date.now();
  setLocalState('connecting');
  // Stay red until the broker pushes the actual client count after handshake.
  ws.onopen = () => {
    lastDialOpened = true;                             // this host works — keep dialing it
    backoffMs = BACKOFF_MIN_MS;                        // healthy connection — reset backoff
    lastRxTs = Date.now();
    try { ws.send(JSON.stringify({ type: 'hello', installId })); } catch {}
    startPingLoop(ws);
  };
  ws.onmessage = (e) => onMessage(ws, e);
  ws.onclose = () => {
    stopPingLoop();
    if (socket !== ws) return;     // superseded / deliberately recycled — its replacement is live
    socket = null;
    setBadgeForCount(0);
    scheduleReconnect();
  };
  ws.onerror = () => {};           // onclose always follows; reconnect is handled there
}

// Tear down the current socket without scheduling work — used before dialing a
// replacement. Nulling `socket` first makes the old socket's onclose a no-op
// (its `socket !== ws` guard), so it can't clobber the fresh one or double-fire
// a reconnect.
function recycle() {
  const dead = socket;
  socket = null;
  if (dead) { stopPingLoop(); try { dead.close(); } catch {} }
}

// Liveness watchdog, run from the ping loop (worker alive) and the alarm tick
// (worker possibly just revived). Force-recycles zombie sockets so connect()
// can replace them; a healthy socket is left untouched.
function checkHealth() {
  if (!socket) return;
  const now = Date.now();
  if (socket.readyState === WebSocket.CONNECTING) {
    if (now - connectStartedAt > CONNECT_TIMEOUT_MS) { recycle(); scheduleReconnect(); }
    return;
  }
  if (socket.readyState === WebSocket.OPEN) {
    if (pongCapable && now - lastRxTs > STALE_MS) { recycle(); setBadgeForCount(0); scheduleReconnect(); }
    return;
  }
  // CLOSING / CLOSED that never fired a usable onclose — clean up and retry.
  recycle();
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer) return;                          // a reconnect is already pending
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  setLocalState('connecting');
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

async function disconnectIfIdle() {
  if (await hasAnyWindow()) return;
  recycle();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // Also stop the alarm so the SW isn't kept alive for nothing — Chrome
  // will let it die after ~30s of no events, freeing the install slot.
  // chrome.windows.onCreated will re-wake it when a window appears.
  chrome.alarms.clear(RECONNECT_ALARM);
}

function ensureAlarm() { chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 }); }

function hasAnyWindow() {
  return new Promise((resolve) => {
    try {
      chrome.windows.getAll({}, (wins) => resolve(Array.isArray(wins) && wins.length > 0));
    } catch { resolve(false); }
  });
}

async function onMessage(ws, e) {
  lastRxTs = Date.now();          // any inbound frame is proof the path is alive
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }
  if (msg.pong) { pongCapable = true; return; }        // broker echoes our keepalive — enables staleness detection
  if (msg.ping) return;
  if (msg.type === 'slotBusy') return onSlotBusy(msg);
  // mcpClients is only sent when the broker ADOPTED us → proof this slot is ours;
  // clear any stale slot-busy cooldown/flag from a prior collision.
  if (msg.type === 'mcpClients') { clearSlotBusy(); return setBadgeForCount(msg.count); }
  let reply;
  try { reply = await handler(msg.action, msg.args || {}); }
  catch (err) { reply = { error: err?.message || String(err) }; }
  ws.send(JSON.stringify({ id: msg.id, ...reply }));
}

// The broker rejected us because another live profile already holds this slot.
// Enter a cooldown (so we don't reconnect-war) and surface a clear hint to the
// options page so the user can switch this profile to a free slot. The broker
// closes the socket right after; connect() then defers re-dialing until the
// cooldown elapses and re-checks whether the slot freed.
function onSlotBusy(msg) {
  slotBusyUntil = Date.now() + SLOT_BUSY_COOLDOWN_MS;
  backoffMs = BACKOFF_MAX_MS;     // if we do redial later, do it slowly
  setLocalState('connecting');    // not connected; no dedicated color (badge stays red/yellow)
  try {
    chrome.storage.local.set({ fastlinkSlotBusy: {
      install: msg.install || installId,
      knownInstalls: Array.isArray(msg.knownInstalls) ? msg.knownInstalls : [],
      at: Date.now(),
    } });
  } catch {}
}

// Slot is (now) ours — drop the cooldown + the options-page hint.
function clearSlotBusy() {
  if (slotBusyUntil) slotBusyUntil = 0;
  try { chrome.storage.local.remove('fastlinkSlotBusy'); } catch {}
}

function startPingLoop(ws) {
  stopPingLoop();
  pingTimer = setInterval(() => {
    checkHealth();                                      // catch half-open sockets between alarm ticks
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ ping: true })); } catch {}
  }, PING_MS);
}

function stopPingLoop() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

// Push an unsolicited event to the broker (→ MCP server), e.g. a page-load
// signal so the scout can pre-warm its page map. No-op if the socket is down.
export function sendEvent(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try { socket.send(JSON.stringify({ type: 'event', installId, ...payload })); } catch {}
  }
}

// 0 clients → red, 1 → yellow, 2+ → green. Reflects MCP sessions reaching
// the broker — independent of whether the extension itself is reachable
// (close → red is forced separately).
function setBadgeForCount(count) {
  lastClientCount = count;
  publish(count >= 1 ? 'connected' : 'disconnected');
}

// State-only popup update (e.g. "connecting" while we redial) that preserves the
// last known client count so the detail line doesn't flicker.
function setLocalState(state) { publish(state); }

// Report this transport's state. Prefer the injected reporter (background owns
// the shared icon + storage when both transports run); otherwise fall back to
// driving the icon + storage directly so standalone use still works.
function publish(state) {
  if (report) { report({ state, clients: lastClientCount }); return; }
  const color = state === 'connected'
    ? (lastClientCount >= 2 ? 'green' : 'yellow')
    : state === 'connecting' ? 'yellow' : 'red';
  try { chrome.action.setIcon({ path: ICONS[color] }); } catch {}
  try { chrome.action.setTitle({ title: `FastLink — ${lastClientCount} MCP client${lastClientCount === 1 ? '' : 's'} (broker port ${currentPort()})` }); } catch {}
  try { chrome.storage.local.set({ fastlinkConn: { local: { enabled: true, state, clients: lastClientCount } } }); } catch {}
}
