// relayClient.js — outbound WSS client to the FastLink cloud relay's /ext endpoint.
//
// This is the cloud counterpart to connection.js. Where connection.js dials the
// localhost broker (ws://127.0.0.1:PORT) so a local MCP server can drive the
// tab, this module dials OUT over WSS to the multi-tenant Cloudflare relay so
// claude.ai on the web drives THIS user's browser. The relay's Durable Object
// is the WebSocket *server*; the extension is the *client*.
//
// Auth: a long-lived deviceToken (minted once via POST /pair/claim — see
// claimPairingCode below) is presented in the upgrade URL query string. Browsers
// cannot set custom headers on a WebSocket handshake, so the token rides the URL.
//
// Wire protocol (fastlink-relay/SPEC.md §3d, §5a):
//   inbound   {type:'call', id, action, args}   -> dispatchAction(action, args)
//   outbound  {type:'result', id, ...reply}       (reply = {result} | {error, ...extras})
//   keepalive: the ext SENDS {"ping":true} every 20s; the DO auto-responds
//              {"pong":true} WITHOUT waking from hibernation (exact string match
//              via setWebSocketAutoResponse). So the ping must be EXACTLY
//              {"ping":true} with no extra fields. Inbound {"pong":true} is ignored.
//   on open:  {type:'hello', version} — diagnostics only; auth is the URL token.
//   close 4401: device token rejected/revoked -> clear token, stop, prompt re-pair.
//
// Lifecycle mirrors connection.js: a 30s chrome.alarms tick survives MV3 service-
// worker death, plus capped exponential backoff for fast reconnects while alive.
// background.js registers the alarm/window listeners synchronously and delegates
// to the handlers returned by startRelayConnection (MV3 requires synchronous
// listener registration so a fired alarm can revive a dead worker).

const RECONNECT_ALARM = 'fastlink-relay-reconnect';
const PING_MS = 20_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
// A socket stuck in CONNECTING this long never completed the upgrade — recycle
// it instead of letting the connect()-guard treat the zombie as "connecting".
const CONNECT_TIMEOUT_MS = 12_000;
// The relay DO auto-responds {pong:true} to every {ping:true}, so a live socket
// yields inbound traffic at least every PING_MS. Silence past this → half-open
// path (network blip / DO recycle without a clean close) → recycle and redial.
const STALE_MS = 50_000;
const AUTH_FAIL_CODE = 4401;   // relay closes with this when the device token is rejected/revoked
const DEFAULT_RELAY_BASE = 'https://relay.ytx.app';
const VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch { return '0'; } })();

const ICONS = {
  green:  { 16: 'icons/icon-green-16.png',  32: 'icons/icon-green-32.png',  48: 'icons/icon-green-48.png',  128: 'icons/icon-green-128.png' },
  yellow: { 16: 'icons/icon-yellow-16.png', 32: 'icons/icon-yellow-32.png', 48: 'icons/icon-yellow-48.png', 128: 'icons/icon-yellow-128.png' },
  red:    { 16: 'icons/icon-red-16.png',    32: 'icons/icon-red-32.png',    48: 'icons/icon-red-48.png',    128: 'icons/icon-red-128.png' },
};

let socket = null;
let pingTimer = null;
let reconnectTimer = null;
let backoffMs = BACKOFF_MIN_MS;
let connectStartedAt = 0;  // when the current socket entered CONNECTING
let lastRxTs = 0;          // last inbound frame (proof the path is alive)
let cfg = null;            // { wssUrl, deviceToken }
let dispatch = null;       // dispatchAction
let stopped = false;       // set on auth failure — no reconnect until the user re-pairs
// State reporter injected by background.js. When two transports run at once,
// background is the SOLE owner of the toolbar icon and `fastlinkConn` storage
// (so local + relay don't clobber each other). Falls back to driving them
// directly if no reporter is supplied (standalone use).
let report = null;         // (payload:{state}) => void

// Mirror of the user "Stop" pause flag (chrome.storage.session). Re-asserted in
// the hello frame on every (re)connect so the relay DO converges its DURABLE
// pause state with the popup toggle after an SW restart / reconnect — prevents a
// stale-pause mismatch. Kept fresh via storage.onChanged.
const PAUSE_KEY = 'fastlink.drivingPaused';
let drivingPaused = false;
try {
  chrome.storage.session.get(PAUSE_KEY).then((o) => { drivingPaused = !!o?.[PAUSE_KEY]; }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[PAUSE_KEY]) drivingPaused = !!changes[PAUSE_KEY].newValue;
  });
} catch {}

// Start the relay transport. Returns handler hooks for background.js to wire to
// the synchronously-registered alarm/window listeners.
export function startRelayConnection(handle, { wssUrl, deviceToken, onState } = {}) {
  dispatch = handle;
  cfg = { wssUrl, deviceToken };
  report = onState || null;
  stopped = false;
  backoffMs = BACKOFF_MIN_MS;

  ensureAlarm();
  setBadgeForState('connecting');
  connect();

  return {
    onAlarm: (a) => { if (a && a.name === RECONNECT_ALARM) { checkHealth(); connect(); } },
    onWindowCreated: () => { ensureAlarm(); connect(); },
    onWindowRemoved: () => disconnectIfIdle(),
    // Generic "the worker just woke" hook (onStartup/onInstalled).
    wake: () => { ensureAlarm(); checkHealth(); connect(); },
    sendEvent: sendRelayEvent,
  };
}

function ensureAlarm() { chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 }); }

async function connect() {
  if (stopped) return;
  if (socket && socket.readyState === WebSocket.OPEN) return;
  if (socket && socket.readyState === WebSocket.CONNECTING && Date.now() - connectStartedAt < CONNECT_TIMEOUT_MS) return;
  // Only hold the relay socket open when this profile actually has a window —
  // mirrors connection.js so a windowless, alarm-kept-alive worker doesn't claim
  // the user's relay slot with no tab to serve.
  if (!await hasAnyWindow()) return;
  if (!cfg?.wssUrl || !cfg?.deviceToken) return;
  recycle();   // drop any stale/zombie socket before dialing a fresh one

  const sep = cfg.wssUrl.includes('?') ? '&' : '?';
  const url = `${cfg.wssUrl}${sep}token=${encodeURIComponent(cfg.deviceToken)}`;

  let ws;
  try { ws = new WebSocket(url); } catch { scheduleReconnect(); return; }
  socket = ws;
  connectStartedAt = Date.now();
  setBadgeForState('connecting');

  ws.onopen = () => {
    backoffMs = BACKOFF_MIN_MS;                       // healthy connection — reset backoff
    lastRxTs = Date.now();
    try { ws.send(JSON.stringify({ type: 'hello', version: VERSION, drivingPaused })); } catch {}
    startPingLoop(ws);
    setBadgeForState('connected');
  };
  ws.onmessage = (e) => onMessage(ws, e);
  ws.onclose = (e) => {
    // Ignore closes for a superseded/stale socket. After an MV3 SW-death redial,
    // relay-core's DO closes the OLD socket with code 4000 ("superseded") while
    // the freshly-dialed socket is the live one. ping loop / badge / reconnect are
    // module-global, so acting on the dead socket here would clobber the live one.
    if (socket !== ws) return;
    stopPingLoop();
    socket = null;
    // Token revoked (4401): stop + prompt re-pair (don't hammer a dead token).
    // Anything else (drop, hibernation churn, SW death): backoff reconnect.
    if (e && e.code === AUTH_FAIL_CODE) { onAuthFailure(); return; }
    setBadgeForState('disconnected');
    scheduleReconnect();
  };
  ws.onerror = () => {};                              // onclose always follows; handle reconnect there
}

async function onMessage(ws, e) {
  lastRxTs = Date.now();                             // any inbound frame is proof the path is alive
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }
  if (msg.ping || msg.pong) return;                  // keepalive echoes — nothing to do
  // Per-origin consent prompt pushed by the relay on first touch of a new site
  // (SIGNUP-SPEC §4.2). Stash it so the toolbar popup can surface Allow / Read-
  // only / Block. Shape coordinated with relay-auth/hardening; tolerate either
  // `modesOffered` or `modes`.
  if (msg.type === 'consent_required' && msg.origin) {
    try {
      chrome.storage.local.set({
        fastlinkPendingConsent: {
          origin: msg.origin,
          modes: msg.modesOffered || msg.modes || ['allow', 'readonly'],
          message: msg.message || '',
          ts: Date.now(),
        },
      });
    } catch {}
    return;
  }
  // Relay sends {type:'call', id, action, args}. Be lenient and also accept a
  // broker-style {id, action} with no type, so the same handler is transport-agnostic.
  const isCall = msg.type === 'call' || (msg.type == null && msg.action && msg.id != null);
  if (!isCall) return;                               // events/hello/result-echo/etc. — ignore inbound
  let reply;
  try { reply = await dispatch(msg.action, msg.args || {}); }
  catch (err) { reply = { error: err?.message || String(err) }; }
  // Spread reply so {result} or {error, ...extras} reach the relay verbatim,
  // exactly as the local broker router expects.
  try { ws.send(JSON.stringify({ type: 'result', id: msg.id, ...reply })); } catch {}
}

function scheduleReconnect() {
  if (stopped) return;
  if (reconnectTimer) return;                        // a reconnect is already pending
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

// Tear down the current socket without scheduling work. Nulling `socket` first
// makes the old socket's onclose a no-op (its `socket !== ws` guard), so it
// can't clobber the fresh one or double-fire a reconnect.
function recycle() {
  const dead = socket;
  socket = null;
  if (dead) { stopPingLoop(); try { dead.close(); } catch {} }
}

// Liveness watchdog, run from the ping loop (worker alive) and the alarm tick
// (worker possibly just revived). Force-recycles zombie sockets so connect()
// can replace them; a healthy socket is left untouched.
function checkHealth() {
  if (stopped || !socket) return;
  const now = Date.now();
  if (socket.readyState === WebSocket.CONNECTING) {
    if (now - connectStartedAt > CONNECT_TIMEOUT_MS) { recycle(); scheduleReconnect(); }
    return;
  }
  if (socket.readyState === WebSocket.OPEN) {
    if (now - lastRxTs > STALE_MS) { recycle(); setBadgeForState('disconnected'); scheduleReconnect(); }
    return;
  }
  // CLOSING / CLOSED that never fired a usable onclose — clean up and retry.
  recycle();
  scheduleReconnect();
}

// Token rejected/revoked: stop reconnecting (no infinite loop on a dead token),
// clear the stored token, and surface a re-pair prompt for the options page.
function onAuthFailure() {
  stopped = true;
  stopPingLoop();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  chrome.alarms.clear(RECONNECT_ALARM);
  try {
    chrome.storage.local.remove(['deviceToken']);
    chrome.storage.local.set({ relayAuthError: 'FastLink was unpaired or its token was revoked — re-pair in the extension options.' });
  } catch {}
  setBadgeForState('auth');
}

// User-initiated hard disconnect (SAFETY N2 "Disconnect relay"). Stops dialing,
// closes the socket, drops the keepalive alarm — claude.ai can no longer drive
// this browser until the relay is re-enabled (background sets relayEnabled=false
// and a reconnect re-evaluates the module with stopped reset). Distinct from
// onAuthFailure: no re-pair prompt, no stored error — this is intentional.
export function stopRelay() {
  stopped = true;
  stopPingLoop();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try { chrome.alarms.clear(RECONNECT_ALARM); } catch {}
  recycle();
  setBadgeForState('disconnected');
}

async function disconnectIfIdle() {
  if (await hasAnyWindow()) return;
  if (socket) try { socket.close(); } catch {}
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // Drop the alarm so a windowless worker can die and free the relay slot;
  // chrome.windows.onCreated re-arms it when a window reappears.
  chrome.alarms.clear(RECONNECT_ALARM);
}

function startPingLoop(ws) {
  stopPingLoop();
  pingTimer = setInterval(() => {
    checkHealth();                                   // catch half-open sockets between alarm ticks
    if (ws.readyState !== WebSocket.OPEN) return;
    // EXACTLY {"ping":true} — must string-match the DO's setWebSocketAutoResponse
    // key so the keepalive is answered without waking the DO from hibernation.
    try { ws.send(JSON.stringify({ ping: true })); } catch {}
  }, PING_MS);
}

function stopPingLoop() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

// Push an unsolicited event up to the relay DO (e.g. a 'navigated' page-load
// signal for future pre-warm). No-op if the socket is down.
export function sendRelayEvent(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try { socket.send(JSON.stringify({ type: 'event', ...payload })); } catch {}
  }
}

function hasAnyWindow() {
  return new Promise((resolve) => {
    try {
      chrome.windows.getAll({}, (wins) => resolve(Array.isArray(wins) && wins.length > 0));
    } catch { resolve(false); }
  });
}

// Report this transport's state. Prefer the injected reporter (background owns
// the shared icon + storage when both transports run); otherwise drive the icon
// + storage directly so standalone use still works.
// connecting → yellow, connected → green, disconnected/auth → red.
function setBadgeForState(state) {
  if (report) { report({ state }); return; }
  const color = state === 'connected' ? 'green' : state === 'connecting' ? 'yellow' : 'red';
  const titles = {
    connected:    'FastLink — cloud relay connected',
    connecting:   'FastLink — connecting to cloud relay…',
    disconnected: 'FastLink — cloud relay disconnected (reconnecting)',
    auth:         'FastLink — relay unpaired; re-pair in options',
  };
  try {
    chrome.action.setIcon({ path: ICONS[color] });
    chrome.action.setTitle({ title: titles[state] || titles.disconnected });
  } catch {}
  // Mirror state into storage so the toolbar popup can show live relay status.
  try { chrome.storage.local.set({ fastlinkConn: { relay: { enabled: true, state } } }); } catch {}
}

// ---------------------------------------------------------------------------
// Pairing (HTTPS, one-time): exchange a short human code for a durable device
// token. Called from the options page. On success, stores the relay config in
// chrome.storage.local and flips fastlinkMode to 'relay'. The caller should then
// chrome.runtime.reload() so the worker re-reads config and dials the relay.
// ---------------------------------------------------------------------------
export async function claimPairingCode(code, relayBase) {
  const base = (String(relayBase || '').trim() || DEFAULT_RELAY_BASE).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Relay base URL must start with https://');
  const clean = normalizeCode(code);
  if (!clean) throw new Error('Enter the pairing code shown on the relay page.');

  let res, body = {};
  try {
    res = await fetch(`${base}/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: clean, label: deviceLabel() }),
    });
  } catch (e) {
    throw new Error(`Could not reach the relay at ${base} (${e?.message || e}).`);
  }
  try { body = await res.json(); } catch { body = {}; }
  if (!res.ok) {
    const map = { invalid_or_expired_code: 'That code is invalid or expired — generate a new one on the relay page.' };
    throw new Error(map[body?.error] || body?.error || `Pairing failed (HTTP ${res.status}).`);
  }
  const { deviceToken, userId } = body;
  if (!deviceToken) throw new Error('Relay did not return a device token.');
  // Prefer the relay-supplied wss URL; otherwise derive it from the base origin.
  const wssUrl = body.wssUrl || `${base.replace(/^http/, 'ws')}/ext`;

  await persistRelayPairing({ deviceToken, base, wssUrl, userId });
  return { userId: userId || null, wssUrl };
}

// ---------------------------------------------------------------------------
// Auto-pair via chrome.identity.launchWebAuthFlow (SIGNUP-SPEC §1.4 / §4.1).
// One-click "Sign in & connect": opens the relay's /ext/authorize in a browser-
// controlled auth window, the human proves identity there (OWNER_SECRET in
// shared mode, email magic-link in magic mode), and the relay 302s back to our
// fixed chromiumapp.org redirect URI with the freshly minted device token in the
// URL FRAGMENT. No code is ever shown to or typed by the user.
//
// MUST be invoked from a user-gesture context (the onboarding / options button)
// so interactive:true is allowed to open the window. On success this stores the
// same relay config claimPairingCode does (shared tail) — the caller then asks
// background.js to start the relay transport live (no extension reload needed).
// ---------------------------------------------------------------------------
export async function authorizeViaWebAuthFlow(relayBase) {
  const base = (String(relayBase || '').trim() || DEFAULT_RELAY_BASE).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Relay base URL must start with https://');
  if (!chrome.identity?.launchWebAuthFlow) {
    throw new Error('chrome.identity is unavailable — reload the extension (the "identity" permission may be missing).');
  }

  // Fixed redirect URI derived from the extension ID: https://<id>.chromiumapp.org/
  const redirectUri = chrome.identity.getRedirectURL();
  // CSRF / response-fixation guard: opaque random the relay must echo verbatim.
  const state = randomState();
  const url = `${base}/ext/authorize`
    + `?redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&state=${encodeURIComponent(state)}`
    + `&label=${encodeURIComponent(deviceLabel())}`;

  let ret;
  try {
    ret = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  } catch (e) {
    const m = String(e?.message || e);
    // launchWebAuthFlow rejects on user-close/cancel and on flow timeout.
    if (/did not approve|cancell?ed|closed|user_cancelled/i.test(m)) {
      throw new Error('Sign-in was canceled. Click “Sign in & connect” to try again.');
    }
    throw new Error(`Sign-in could not complete (${m}).`);
  }
  if (!ret) throw new Error('Sign-in did not complete — please try again.');

  // Token data rides the fragment (#…); parse it (NOT the query string).
  let frag;
  try { frag = new URLSearchParams(new URL(ret).hash.replace(/^#/, '')); }
  catch { throw new Error('Could not read the sign-in response from the relay.'); }

  const err = frag.get('error');
  if (err) throw new Error(mapAuthError(err));
  // Verify state BEFORE trusting any token in the response.
  if (frag.get('state') !== state) {
    throw new Error('Sign-in failed a security check (state mismatch). Please retry.');
  }
  const deviceToken = frag.get('devicetoken');
  if (!deviceToken) throw new Error('The relay did not return a device token.');
  const userId = frag.get('userId') || null;
  const wssUrl = frag.get('wssUrl') || `${base.replace(/^http/, 'ws')}/ext`;

  await persistRelayPairing({ deviceToken, base, wssUrl, userId });
  return { userId, wssUrl };
}

// Shared storage-write tail for BOTH pairing paths (manual code + web-auth).
// Writes the relay config and flips BOTH transports on (local broker stays up
// for the CLI; relay runs for claude.ai). Clears any stale auth-error banner.
async function persistRelayPairing({ deviceToken, base, wssUrl, userId }) {
  await chrome.storage.local.set({
    fastlinkMode: 'relay',
    deviceToken,
    relayBase: base,
    relayWssUrl: wssUrl,
    relayUserId: userId || null,
    relayAuthError: null,
    localEnabled: true,
    relayEnabled: true,
  });
}

// 16 random bytes → base64url. ≥16 chars, satisfies the relay's state length gate.
function randomState() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Map the relay's machine-readable error codes (#error=…) to friendly text.
function mapAuthError(code) {
  const map = {
    access_denied:   'Sign-in was declined on the relay.',
    invalid_request: 'The sign-in request was invalid — please try again.',
    server_error:    'The relay hit an error during sign-in — please try again.',
  };
  return map[code] || `Sign-in failed (${code}).`;
}

function normalizeCode(code) {
  // Crockford base32, case-insensitive, dashes/spaces are cosmetic.
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function deviceLabel() {
  let ua = '';
  try { ua = navigator.userAgent || ''; } catch {}
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : 'Browser';
  return `FastLink ${browser}`;
}
