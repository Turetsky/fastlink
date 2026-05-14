import { WebSocketServer } from 'ws';
import { state } from './state.js';
import { log, onFatalListenError } from './lifecycle.js';
import { onExtensionResponse, failPendingForSocket } from './router.js';
import { mcpClientCount } from './mcpBridge.js';
import { attachHeartbeat, startHeartbeatLoop } from './heartbeat.js';

// One port per install. Two extensions running side-by-side never collide
// because they target different sockets — no race-reconnect.
const EXT_PORTS = { yaakov: 9876, dad: 9877 };

// 2-second grace for the extension to send {type:'hello', installId} after
// connect. If it doesn't, we fall back to the install mapped to the port —
// covers older extension builds that don't speak hello yet.
const HELLO_TIMEOUT_MS = 2_000;

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
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
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
      installId = id;
      // Replace prior socket for the same install (SW respawn = stale prev).
      // Cross-install never collides because they're on different ports.
      const prevForId = state.getSocketForInstall(id);
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
        const id = msg.installId.toLowerCase();
        if (!Object.hasOwn(EXT_PORTS, id)) {
          log(`unknown installId "${id}" on :${port}, falling back to "${defaultId}"`);
          assign(defaultId, ws);
        } else {
          assign(id, ws);
        }
        return;
      }
      if (msg.ping) {
        if (installId) state.notePing(installId);
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
