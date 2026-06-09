// Per-install slots. FastLink supports two NEUTRAL install slots that can run
// side by side (e.g. two Chrome profiles on one machine), each bound to its own
// broker port so they never collide. The broker accepts both connections
// simultaneously and tracks them as separate slots; tools route to whichever
// install is "active" (FASTLINK_ACTIVE env var, defaults to the first slot,
// 'primary').
//
// EXT_PORTS is the single source of truth for the slot ids + ports. Everything
// else (known installs, the per-port default, status output) DERIVES from its
// keys, so the names stay neutral and in sync — no personal ids baked in.
export const EXT_PORTS = { primary: 9876, secondary: 9877 };

const KNOWN_INSTALLS = Object.keys(EXT_PORTS);
const ACTIVE = (process.env.FASTLINK_ACTIVE || KNOWN_INSTALLS[0]).toLowerCase();

const slots = new Map(); // installId -> { ws, lastConnectedAt, lastDisconnectedAt, lastPingAt, totalConnections }

function ensureSlot(installId) {
  let s = slots.get(installId);
  if (!s) {
    s = { ws: null, lastConnectedAt: null, lastDisconnectedAt: null, lastPingAt: null, totalConnections: 0 };
    slots.set(installId, s);
  }
  return s;
}

const ago = (t) => t ? `${Math.round((Date.now() - t) / 1000)}s ago` : 'never';

export const state = {
  getActiveInstall() { return ACTIVE; },
  knownInstalls() { return [...KNOWN_INSTALLS]; },

  setExtensionSocket(installId, ws) {
    const s = ensureSlot(installId);
    s.ws = ws;
    s.lastConnectedAt = Date.now();
    s.totalConnections += 1;
  },
  clearExtensionSocket(installId, ws) {
    const s = slots.get(installId);
    if (s && s.ws === ws) {
      s.ws = null;
      s.lastDisconnectedAt = Date.now();
    }
  },
  notePing(installId) {
    const s = ensureSlot(installId);
    s.lastPingAt = Date.now();
  },
  // Returns whichever install's socket tool calls should route to:
  //   - If ACTIVE is connected, use it.
  //   - Else if any other install is connected, use that one (so the secondary
  //     install works when the primary is offline, and vice versa — without
  //     anyone having to flip FASTLINK_ACTIVE).
  //   - Else null.
  getExtensionSocket() {
    const active = slots.get(ACTIVE);
    if (active?.ws && active.ws.readyState === 1) return active.ws;
    for (const s of slots.values()) {
      if (s.ws && s.ws.readyState === 1) return s.ws;
    }
    return null;
  },
  // Which install is currently being routed to (may differ from ACTIVE if
  // ACTIVE isn't connected). Used by snapshot() so fast_status reports the
  // truth, not the configured preference.
  getRoutedInstall() {
    const active = slots.get(ACTIVE);
    if (active?.ws && active.ws.readyState === 1) return ACTIVE;
    for (const [id, s] of slots.entries()) {
      if (s.ws && s.ws.readyState === 1) return id;
    }
    return null;
  },
  getSocketForInstall(installId) {
    const s = slots.get(installId);
    return s?.ws || null;
  },
  // Returns every connected socket — used to broadcast badge updates so both
  // installs' badges reflect the same client count.
  *allConnectedSockets() {
    for (const s of slots.values()) {
      if (s.ws && s.ws.readyState === 1) yield s.ws;
    }
  },
  isExtensionConnected() {
    const ws = state.getExtensionSocket();
    return !!ws && ws.readyState === 1;
  },
  snapshot() {
    const installs = {};
    for (const id of KNOWN_INSTALLS) {
      const s = slots.get(id);
      installs[id] = {
        connected: !!(s?.ws && s.ws.readyState === 1),
        totalConnections: s?.totalConnections ?? 0,
        lastConnectedAt: s?.lastConnectedAt ? new Date(s.lastConnectedAt).toISOString() : null,
        lastConnectedAgo: ago(s?.lastConnectedAt),
        lastDisconnectedAgo: ago(s?.lastDisconnectedAt),
        lastPingAgo: ago(s?.lastPingAt),
      };
    }
    // Top-level fields reflect whichever install tool calls actually route to
    // (the routed install — see getRoutedInstall). That may differ from the
    // configured ACTIVE when ACTIVE is offline but another install is up.
    const routed = state.getRoutedInstall();
    const routedSnap = routed ? installs[routed] : null;
    return {
      connected: !!routedSnap?.connected,
      totalConnections: routedSnap?.totalConnections ?? 0,
      lastConnectedAt: routedSnap?.lastConnectedAt ?? null,
      lastConnectedAgo: routedSnap?.lastConnectedAgo ?? 'never',
      lastDisconnectedAgo: routedSnap?.lastDisconnectedAgo ?? 'never',
      lastPingAgo: routedSnap?.lastPingAgo ?? 'never',
      activeInstall: ACTIVE,
      routedInstall: routed,
      installs,
    };
  },
};
