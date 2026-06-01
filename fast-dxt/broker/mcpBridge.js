// Protocol (client → broker):
//   { type: 'call',   id, action, args }
//   { type: 'status', id }
// Protocol (broker → client):
//   { type: 'result', id, result }                  // tool success
//   { type: 'result', id, error, ...extras }        // tool error; extras include
//                                                   // diagnostics, available, etc.
//   { type: 'status', id, data }

import { WebSocketServer } from 'ws';
import { state } from './state.js';
import { log, onFatalListenError } from './lifecycle.js';
import { dispatchCall, dropPendingForClient } from './router.js';
import { attachHeartbeat, startHeartbeatLoop } from './heartbeat.js';

const MCP_PORT = 9870;
const clients = new Set();

export const hasMcpClients = () => clients.size > 0;
export const mcpClientCount = () => clients.size;

// Push an unsolicited message (e.g. a page-load 'event' from the extension) to
// every connected MCP server, which decides what to do with it (the scout
// pre-warms on 'navigated'). Distinct from notifyExtensionOfClientCount, which
// targets extensions.
export function broadcastToMcp(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1) { try { ws.send(payload); } catch {} }
  }
}

// Push the current client count to every connected extension so both
// installs' badges (yaakov/dad) reflect "0/1/2+ clients" — red/yellow/green.
function notifyExtensionOfClientCount() {
  const payload = JSON.stringify({ type: 'mcpClients', count: clients.size });
  for (const ws of state.allConnectedSockets()) {
    try { ws.send(payload); } catch {}
  }
}

export function startMcpBridge() {
  const wss = new WebSocketServer({ port: MCP_PORT, host: '127.0.0.1' });
  wss.on('listening', () => log(`mcp WS listening on ${MCP_PORT}`));
  wss.on('error', (e) => onFatalListenError('mcp', MCP_PORT, e));
  wss.on('connection', (ws) => {
    clients.add(ws);
    attachHeartbeat(ws);
    log(`mcp client connected (${clients.size} total)`);
    notifyExtensionOfClientCount();
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'call') return dispatchCall(ws, msg.id, msg.action, msg.args);
      if (msg.type === 'status') {
        ws.send(JSON.stringify({ type: 'status', id: msg.id, data: state.snapshot() }));
      }
    });
    ws.on('close', () => {
      clients.delete(ws);
      dropPendingForClient(ws);
      log(`mcp client disconnected (${clients.size} remaining)`);
      notifyExtensionOfClientCount();
    });
    ws.on('error', (e) => log(`mcp ws error: ${e.message}`));
  });

  startHeartbeatLoop(clients);
}
