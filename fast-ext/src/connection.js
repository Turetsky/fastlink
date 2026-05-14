// Reconnect via chrome.alarms — service workers get killed and revived,
// alarms survive the death.

// FastLink is private to two installs. Each install hardcodes its INSTALL_ID
// here and connects to its own port — so two extensions running in different
// Chrome profiles on the same machine never collide on the broker.
//   yaakov: 9876
//   dad:    9877
// To deploy to the other profile, change INSTALL_ID below and reload the
// extension at chrome://extensions.
const INSTALL_ID = 'yaakov';
const INSTALL_PORTS = { yaakov: 9876, dad: 9877 };
const PORT = INSTALL_PORTS[INSTALL_ID];
if (!PORT) throw new Error(`FastLink: unknown INSTALL_ID "${INSTALL_ID}"`);
const RECONNECT_ALARM = 'fastlink-reconnect';
// Application-level ping every 20s. Two effects:
//   1. Keeps the broker from terminating us as "dead" if WS pong frames don't
//      flow reliably (Chrome MV3 + WSL is suspect).
//   2. Inbound message from the broker (or even just outbound activity here)
//      counts as service-worker activity, extending the 30s idle timer.
const PING_MS = 20_000;
let pingTimer = null;

const ICONS = {
  green:  { 16: 'icons/icon-green-16.png',  32: 'icons/icon-green-32.png',  48: 'icons/icon-green-48.png',  128: 'icons/icon-green-128.png' },
  yellow: { 16: 'icons/icon-yellow-16.png', 32: 'icons/icon-yellow-32.png', 48: 'icons/icon-yellow-48.png', 128: 'icons/icon-yellow-128.png' },
  red:    { 16: 'icons/icon-red-16.png',    32: 'icons/icon-red-32.png',    48: 'icons/icon-red-48.png',    128: 'icons/icon-red-128.png' },
};

let socket = null;

export function startConnection(handle) {
  const connect = async () => {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    // Only present as "connected" to the broker when this profile actually
    // has a window. Otherwise the SW (kept alive by alarms) would claim the
    // install slot while having zero tabs to serve.
    if (!await hasAnyWindow()) return;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    socket = ws;
    // Stay red until the broker pushes the actual client count after handshake.
    ws.onopen    = () => {
      try { ws.send(JSON.stringify({ type: 'hello', installId: INSTALL_ID })); } catch {}
      startPingLoop(ws);
    };
    ws.onmessage = (e) => onMessage(ws, e, handle);
    ws.onclose   = () => { stopPingLoop(); if (socket === ws) socket = null; setBadgeForCount(0); };
    ws.onerror   = () => {};
  };

  const disconnectIfIdle = async () => {
    if (await hasAnyWindow()) return;
    if (socket) try { socket.close(); } catch {}
    // Also stop the alarm so the SW isn't kept alive for nothing — Chrome
    // will let it die after ~30s of no events, freeing the install slot.
    // chrome.windows.onCreated will re-wake it when a window appears.
    chrome.alarms.clear(RECONNECT_ALARM);
  };

  const ensureAlarm = () => chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });

  ensureAlarm();
  chrome.alarms.onAlarm.addListener((a) => { if (a.name === RECONNECT_ALARM) connect(); });

  // React promptly to window open/close — don't make the user wait up to 30s
  // for the next alarm tick.
  chrome.windows.onCreated.addListener(() => { ensureAlarm(); connect(); });
  chrome.windows.onRemoved.addListener(() => disconnectIfIdle());

  setBadgeForCount(0);
  connect();
}

function hasAnyWindow() {
  return new Promise((resolve) => {
    try {
      chrome.windows.getAll({}, (wins) => resolve(Array.isArray(wins) && wins.length > 0));
    } catch { resolve(false); }
  });
}

async function onMessage(ws, e, handle) {
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }
  if (msg.ping) return;
  if (msg.type === 'mcpClients') return setBadgeForCount(msg.count);
  let reply;
  try { reply = await handle(msg.action, msg.args || {}); }
  catch (err) { reply = { error: err?.message || String(err) }; }
  ws.send(JSON.stringify({ id: msg.id, ...reply }));
}

function startPingLoop(ws) {
  stopPingLoop();
  pingTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ ping: true })); } catch {}
  }, PING_MS);
}

function stopPingLoop() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

// 0 clients → red, 1 → yellow, 2+ → green. Reflects MCP sessions reaching
// the broker — independent of whether the extension itself is reachable
// (close → red is forced separately).
function setBadgeForCount(count) {
  const color = count >= 2 ? 'green' : count === 1 ? 'yellow' : 'red';
  chrome.action.setIcon({ path: ICONS[color] });
  chrome.action.setTitle({ title: `FastLink — ${count} MCP client${count === 1 ? '' : 's'} (broker port ${PORT})` });
}
