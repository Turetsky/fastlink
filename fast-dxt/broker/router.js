import { randomUUID } from 'crypto';
import { state } from './state.js';
import { log } from './lifecycle.js';

const REQUEST_TIMEOUT_MS = 30_000;
const pending = new Map();

export function dispatchCall(mcpClient, mcpId, action, args) {
  const ext = state.getExtensionSocket();
  if (!ext || ext.readyState !== 1) {
    return reply(mcpClient, mcpId, { error: 'Chrome extension not connected.' });
  }
  const extId = randomUUID();
  const timer = setTimeout(() => {
    if (!pending.has(extId)) return;
    pending.delete(extId);
    reply(mcpClient, mcpId, { error: `Timeout waiting for browser response (${REQUEST_TIMEOUT_MS}ms)` });
  }, REQUEST_TIMEOUT_MS);
  // Track which socket sent this so a stale socket's close doesn't fail requests
  // routed via a fresh one (extension service workers respawn).
  pending.set(extId, { mcpClient, mcpId, timer, socket: ext });
  try {
    ext.send(JSON.stringify({ id: extId, action, args: args || {} }));
  } catch (e) {
    pending.delete(extId);
    clearTimeout(timer);
    reply(mcpClient, mcpId, { error: `Send to extension failed: ${e.message}` });
  }
}

export function onExtensionResponse(msg) {
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  clearTimeout(entry.timer);
  reply(entry.mcpClient, entry.mcpId, msg);
}

export function failPendingForSocket(socket) {
  for (const [extId, entry] of pending) {
    if (entry.socket !== socket) continue;
    clearTimeout(entry.timer);
    pending.delete(extId);
    reply(entry.mcpClient, entry.mcpId, { error: 'Extension disconnected before response' });
  }
}

export function dropPendingForClient(mcpClient) {
  for (const [extId, entry] of pending) {
    if (entry.mcpClient !== mcpClient) continue;
    clearTimeout(entry.timer);
    pending.delete(extId);
  }
}

function reply(mcpClient, mcpId, payload) {
  if (!mcpClient || mcpClient.readyState !== 1) return;
  // Pass through every field except the routing id — preserves diagnostics,
  // available, headers, screenshot, etc. on error/success payloads.
  const { id, ...rest } = payload || {};
  try { mcpClient.send(JSON.stringify({ type: 'result', id: mcpId, ...rest })); }
  catch (e) { log(`reply send failed: ${e.message}`); }
}
