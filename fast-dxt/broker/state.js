// Slots keyed by arbitrary `hello` label → N profiles concurrent. Route to
// FASTLINK_ACTIVE (default 'primary') unless a session pins via fast_profile.
// EXT_PORTS = fixed listener ports. 'primary' 9876 = shared port for all custom
// labels (demuxed by label); 'secondary' 9877 = legacy. Port key = default
// install for no/blank-hello builds. Custom labels learned from `hello` → `slots`.
export const EXT_PORTS = { primary: 9876, secondary: 9877 };

const LISTENER_INSTALLS = Object.keys(EXT_PORTS);
const ACTIVE = (process.env.FASTLINK_ACTIVE || LISTENER_INSTALLS[0]).toLowerCase();

// A slot's incumbent is "live" if it connected or pinged within this window.
// > the extension's 20s app-ping cycle so one missed ping doesn't read as dead.
const LIVENESS_MS = 30_000;

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
  // Fixed listener slots ∪ every custom label seen live this lifetime (tracked
  // in `slots`). Listeners first. Gates routing (router.js) + status output.
  knownInstalls() { return [...new Set([...LISTENER_INSTALLS, ...slots.keys()])]; },

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
  // Is this install slot held by a LIVE socket right now? "Live" = OPEN and
  // showing recent activity (connected or app-pinged within LIVENESS_MS). Used
  // by extBridge to tell a same-slot COLLISION (two live profiles → reject the
  // newcomer) from a SERVICE-WORKER RESPAWN (stale prev socket → adopt the
  // newcomer). The window is generous (> one 20s extension ping cycle) so a
  // briefly-laggy healthy incumbent is never mistaken for dead and evicted —
  // we bias toward protecting a working profile over fast respawn adoption (a
  // truly-dead half-open socket still ages out and gets replaced).
  isInstallLive(installId) {
    const s = slots.get(installId);
    if (!s?.ws || s.ws.readyState !== 1) return false;
    const last = Math.max(s.lastConnectedAt || 0, s.lastPingAt || 0);
    return Date.now() - last < LIVENESS_MS;
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
    for (const id of state.knownInstalls()) {
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
