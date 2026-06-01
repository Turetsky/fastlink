import { WebSocket } from 'ws';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { BROKER_PORT, REQUEST_TIMEOUT_MS } from './config.js';
import { log } from './log.js';

const BROKER_ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'broker', 'index.js');
const RECONNECT_BACKOFF_MS = [200, 500, 1000, 2000, 4000];
const MAX_CONNECT_ATTEMPTS = 12;
const STATUS_TIMEOUT_MS = 5_000;
// Ping every 15s; if no pong for >32s, the socket is dead.
const HEARTBEAT_MS = 15_000;
const HEARTBEAT_DEAD_MS = 32_000;

let ws = null;
let connectingPromise = null;
const pending = new Map();
const eventHandlers = new Set();

// Subscribe to unsolicited broker→server events (e.g. page-load 'navigated').
export function onBrokerEvent(fn) { eventHandlers.add(fn); }

// Surfaced through fast_status so the LLM can tell "just reconnected,
// retry once" from "steady-state failure".
let lastDisconnectAt = null;

export const callExtension = (action, args = {}) => rpc({ type: 'call', action, args }, REQUEST_TIMEOUT_MS);
export const getStatus     = () => rpc({ type: 'status' }, STATUS_TIMEOUT_MS);

export function getBrokerLinkInfo() {
  return { lastDisconnectAgoMs: lastDisconnectAt ? Date.now() - lastDisconnectAt : null };
}

async function rpc(payload, timeoutMs) {
  const socket = await ensureConnected();
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`Broker call timed out (${timeoutMs}ms)`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ ...payload, id })); }
    catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(new Error(`Send to broker failed: ${e.message}`));
    }
  });
}

async function ensureConnected() {
  if (ws && ws.readyState === WebSocket.OPEN) return ws;
  if (connectingPromise) return connectingPromise;
  connectingPromise = connectWithRetry();
  try { return await connectingPromise; }
  finally { connectingPromise = null; }
}

async function connectWithRetry() {
  let lastErr;
  for (let attempt = 0; attempt < MAX_CONNECT_ATTEMPTS; attempt++) {
    try {
      ws = await openSocket();
      wireSocket(ws);
      log('connected to broker');
      return ws;
    } catch (e) {
      lastErr = e;
      // First failure: assume no broker is running. Spawn unconditionally —
      // a duplicate broker exits on EADDRINUSE, so it's a safe no-op if one
      // already exists (avoids stale-PID-file false negatives).
      if (attempt === 0) spawnBroker();
      const wait = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw new Error(`Broker unreachable: ${lastErr?.message || 'unknown'}`);
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${BROKER_PORT}`);
    s.once('open', () => { s.off('error', reject); resolve(s); });
    s.once('error', reject);
  });
}

function wireSocket(socket) {
  // Use ws-level ping frames — the broker (also `ws`) auto-pongs without
  // needing app-level cooperation. If pongs stop arriving, terminate the
  // socket so close fires and the auto-reconnect kicks in.
  let lastPongAt = Date.now();
  const heartbeat = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastPongAt > HEARTBEAT_DEAD_MS) {
      log('heartbeat timeout, terminating socket');
      try { socket.terminate(); } catch {}
      return;
    }
    try { socket.ping(); } catch {}
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  socket.on('pong', () => { lastPongAt = Date.now(); });

  socket.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'event') {
      for (const h of eventHandlers) { try { h(msg); } catch {} }
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.type === 'status') return entry.resolve(msg.data);
    // Resolve with the whole payload (success or tool error). Distinguishing
    // tool errors via rejection would drop diagnostics/available/etc.; the
    // caller (handlers.js) checks for `error` in the resolved value.
    const { type, id, ...payload } = msg;
    entry.resolve(payload);
  });
  socket.on('close', () => {
    clearInterval(heartbeat);
    // A delayed close from a stale socket (e.g. one we already replaced)
    // must not null out the current ws or count as a fresh disconnect.
    if (ws !== socket) return;
    log('broker connection closed');
    ws = null;
    lastDisconnectAt = Date.now();
    failAllPending('broker disconnected');
    // Proactively reconnect in the background so the next tool call lands on
    // a live socket instead of paying the connect cost on its critical path.
    // ensureConnected is single-flight, so this is safe if a call is already
    // racing us.
    ensureConnected().catch(e => log(`background reconnect failed: ${e.message}`));
  });
  socket.on('error', (e) => log(`broker ws error: ${e.message}`));
}

function failAllPending(reason) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
}

function spawnBroker() {
  log('spawning broker...');
  spawn(process.execPath, [BROKER_ENTRY], { detached: true, stdio: 'ignore' }).unref();
}
