// Per-socket WS ping/pong heartbeat. Sockets that miss two consecutive pings
// (alive flag still false on next tick) are terminated, which fires 'close'
// and lets the caller's existing close handler clean up.

const HEARTBEAT_MS = 15_000;

export function attachHeartbeat(ws) {
  ws.__alive = true;
  ws.on('pong', () => { ws.__alive = true; });
  // Treat any inbound application message as proof of life too — WS protocol
  // pongs are unreliable across Chrome MV3 + WSL in practice, so we'd
  // otherwise terminate healthy sockets that simply aren't returning pongs.
  ws.on('message', () => { ws.__alive = true; });
}

// Drive heartbeats for a set of sockets. Returns the interval handle so the
// caller can clearInterval() on shutdown. Skips work entirely when the set
// is empty.
export function startHeartbeatLoop(socketsIterable) {
  const interval = setInterval(() => {
    const sockets = typeof socketsIterable === 'function' ? socketsIterable() : socketsIterable;
    let any = false;
    for (const ws of sockets) {
      any = true;
      if (!ws.__alive) { try { ws.terminate(); } catch {} continue; }
      ws.__alive = false;
      try { ws.ping(); } catch {}
    }
    if (!any) return;
  }, HEARTBEAT_MS);
  interval.unref?.();
  return interval;
}
