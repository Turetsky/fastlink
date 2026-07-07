import { WebSocketServer } from 'ws';
import { state, EXT_PORTS } from './state.js';
import { log, onFatalListenError } from './lifecycle.js';
import { onExtensionResponse, failPendingForSocket } from './router.js';
import { mcpClientCount, broadcastToMcp } from './mcpBridge.js';
import { attachHeartbeat, startHeartbeatLoop } from './heartbeat.js';

// Binds EXT_PORTS. 'primary' 9876 = shared port for custom labels (demuxed by
// `hello` label → N profiles/port); 'secondary' 9877 + no-hello → port default.

// 2s grace for {type:'hello', installId}; absent → port default.
const HELLO_TIMEOUT_MS = 2_000;

// Slot key: lowercase [a-z0-9_-], alnum first, ≤32. null → port default.
function sanitizeInstallId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[-_]+/, '').slice(0, 32);
  return id || null;
}

const extSockets = {
  *[Symbol.iterator]() { yield* state.allConnectedSockets(); },
};

export function startExtBridge() {
  startHeartbeatLoop(extSockets);
  for (const [defaultId, port] of Object.entries(EXT_PORTS)) {
    startOne(defaultId, port);
  }
}

function startOne(defaultId, port) {
  // Bind all interfaces (not just 127.0.0.1): the extension dials localhost
  // normally, but falls back to the WSL VM IP when WSL2 localhost-forwarding
  // breaks (it dies after a host sleep until `wsl --shutdown`) — that fallback
  // path needs the broker reachable on eth0. LAN exposure is acceptable: WSL2
  // NAT means other machines can't reach this VM without an explicit portproxy.
  const wss = new WebSocketServer({ port, host: '0.0.0.0' });
  wss.on('listening', () => log(`ext WS listening on ${port} (default install: ${defaultId})`));
  wss.on('error', (e) => onFatalListenError('ext', port, e));
  wss.on('connection', (ws, req) => {
    log(`extension connected on :${port} from ${req.socket.remoteAddress}`);
    let installId = null;
    const helloTimer = setTimeout(() => {
      if (installId) return;
      log(`no hello on :${port}, defaulting to install "${defaultId}"`);
      assign(defaultId, ws);
    }, HELLO_TIMEOUT_MS);

    function assign(id, socket) {
      if (installId) return;
      // Same-slot arbitration. A prior socket on this install is EITHER a stale
      // socket from a service-worker respawn (adopt the newcomer, replace it) OR
      // a second live Chrome profile that defaulted to the same slot (a real
      // COLLISION — must NOT evict the incumbent, or both profiles ping-pong the
      // slot in an endless reconnect war). isInstallLive() distinguishes them.
      const prevForId = state.getSocketForInstall(id);
      if (prevForId && prevForId !== socket && state.isInstallLive(id)) {
        // Live incumbent owns the slot → tell the newcomer to switch slots and
        // close it, leaving the working profile untouched.
        log(`slot "${id}" busy (live incumbent) — rejecting newcomer on :${port}`);
        try { socket.send(JSON.stringify({ type: 'slotBusy', install: id, knownInstalls: state.knownInstalls() })); } catch {}
        // Give the frame a tick to flush before closing.
        setTimeout(() => { try { socket.close(); } catch {} }, 50);
        return; // do NOT adopt — installId stays null so this socket owns no slot
      }
      installId = id;
      // Stale prev (respawn) → replace. Distinct labels = distinct slots even on
      // shared port 9876, so cross-install never collides.
      if (prevForId && prevForId !== socket) try { prevForId.close(); } catch {}
      state.setExtensionSocket(id, socket);
      attachHeartbeat(socket);
      try { socket.send(JSON.stringify({ type: 'mcpClients', count: mcpClientCount() })); } catch {}
    }

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'hello' && typeof msg.installId === 'string') {
        clearTimeout(helloTimer);
        // Sanitizable label → dynamic slot; empty/garbage → port default.
        const id = sanitizeInstallId(msg.installId);
        if (!id) {
          log(`unusable installId "${msg.installId}" on :${port}, falling back to "${defaultId}"`);
          assign(defaultId, ws);
        } else {
          assign(id, ws);
        }
        return;
      }
      if (msg.ping) {
        if (installId) state.notePing(installId);
        // Echo a pong so the extension can detect a half-open socket (no inbound
        // for >N ping cycles => dead path) and self-heal. Additive + backward
        // compatible: older extensions ignore unknown inbound frames.
        try { ws.send(JSON.stringify({ pong: true })); } catch {}
        return;
      }
      // Unsolicited extension events (e.g. page-load) fan out to MCP servers,
      // which decide what to do (the scout pre-warms on 'navigated').
      if (msg.type === 'event') {
        broadcastToMcp(msg);
        return;
      }
      onExtensionResponse(msg);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (installId) {
        state.clearExtensionSocket(installId, ws);
        log(`extension "${installId}" disconnected`);
      }
      failPendingForSocket(ws);
    });
    ws.on('error', (e) => log(`ext ws error on :${port}: ${e.message}`));
  });
}
