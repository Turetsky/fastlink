// src/userRelay.js — the per-user Durable Object (relay-core)
//
// One UserRelay instance per userId (the DO name IS the userId). It is the
// meeting point between the two transports:
//   • '/__mcp'  — an MCP JSON-RPC POST forwarded from FastlinkApiHandler. Handled
//                 by mcp.js, which calls back into this.callExtension(...) for
//                 each browser primitive.
//   • '/__ext'  — the extension's outbound WebSocket upgrade, forwarded from
//                 auth.js after the device token resolved to THIS user. The DO is
//                 the WS *server* and accepts the socket *hibernatably*.
//
// WebSocket Hibernation is the cost model: while a paired browser is idle the WS
// stays open but the DO is evicted from memory (no duration billing). Pings are
// answered by setWebSocketAutoResponse WITHOUT waking the DO. A real tool call
// wakes it (the runtime delivers the frame to webSocketMessage), it does its
// work, then goes idle again.
//
// Protocol on the ext WS (mirrors fast-dxt/broker/router.js):
//   relay → ext :  { type:'call',   id, action, args }
//   ext → relay :  { type:'result', id, ...reply }   reply = {result} | {error,...extras}
//   keepalive   :  ext sends {"ping":true} → DO auto-responds {"pong":true}
//
// See SPEC.md §3d.

import { DurableObject } from 'cloudflare:workers';
import { handleMcpRequest } from './mcp.js';
import { createScout } from './scout.js';

const REQUEST_TIMEOUT_MS = 30_000;
// Background prewarm debounce. On a 'navigated' event we fire ONE lightweight DOM
// page-map warm so the first fast_scout/vision call is warm. The cooldown caps the
// rate well under the Gemini free tier (2.5-flash-lite ~30 RPM): ≥8s spacing →
// ≤~7.5 warms/min even under constant navigation, and it's also one-per-nav +
// skip-same-URL + skip-while-a-real-call-is-in-flight. Purely best-effort.
const PREWARM_COOLDOWN_MS = 8_000;

export class UserRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    // mcpCallId -> { resolve, timer, ws }. In-memory and short-lived: an entry
    // only exists while an MCP tools/call is awaiting the browser. See the
    // "Hibernation × pending map" note in SPEC.md §3d — the DO cannot hibernate
    // while a call is in flight (the /__mcp fetch promise is awaiting), so the
    // map is never lost mid-call; when fully idle there is nothing pending.
    this.pending = new Map();
    // Best-effort identity label for status/audit (set from the forwarded
    // X-Fastlink-User-Id header on /__mcp). NOT used for isolation.
    this.userId = null;
    // Active-tab origin of the most recent extension result (SIGNUP-SPEC §5.2).
    // The extension stamps `origin` on each result frame; we cache it here so the
    // per-origin consent gate (M4), the eval allowlist, and audit can read the
    // current origin WITHOUT an extra fast_list round-trip. Falls back to a
    // fast_list probe (activeOrigin) until the extension stamping lands.
    this.lastOrigin = null;
    // N2 kill-switch (SAFETY): "Stop driving" pause state. Lazy in-memory cache of
    // the DURABLE flag in ctx.storage — it MUST be durable because the DO hibernates
    // between tool calls and would otherwise forget a pause. undefined = not yet read.
    this._paused = undefined;
    // Background-prewarm debounce state (in-memory; resets on hibernation wake,
    // which is fine — the scout's page-map cache is per-instance too, so a fresh
    // instance legitimately wants to re-warm). { at: last warm ms, url: last warmed
    // url, inFlight: a warm is running }.
    this._prewarm = { at: 0, url: null, inFlight: false };

    // Answer ext keepalive pings without waking the DO from hibernation. The
    // match is an EXACT string compare, so the extension's relay ping frame must
    // be byte-for-byte '{"ping":true}' (same payload as the local broker uses).
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"ping":true}', '{"pong":true}'),
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    // Remember the caller's userId for status/audit (best-effort).
    const hdrUser = request.headers.get('X-Fastlink-User-Id');
    if (hdrUser) this.userId = hdrUser;

    if (url.pathname === '/__ext') return this.#acceptExtension(request);
    if (url.pathname === '/__mcp') return handleMcpRequest(request, this);
    if (url.pathname === '/__revoke') return this.#revokeDevice(request);
    return new Response('not found', { status: 404 });
  }

  // --- extension WebSocket (hibernatable server side) -----------------------

  // MULTI-DEVICE (SPEC §3d): a user may pair several browsers; ALL attach to this
  // same DO under the 'ext' tag and stay connected. We do NOT close older sockets
  // — closing one would drop that user's other browser. Routing is
  // most-recent-wins: extSocket() picks the most-recently-CONNECTED live socket.
  // Each socket is stamped (connectedAt + its device token) via serializeAttachment
  // so the stamp survives hibernation and a targeted revoke can find it.
  #acceptExtension(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 });
    }
    const token = new URL(request.url).searchParams.get('token') || null;
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, ['ext']); // tag 'ext' survives hibernation
    try { server.serializeAttachment({ connectedAt: Date.now(), deviceToken: token }); } catch { /* non-fatal */ }
    return new Response(null, { status: 101, webSocket: client });
  }

  // The most-recently-connected LIVE extension socket, or null. Picks the max
  // connectedAt among open 'ext' sockets (multi-device most-recent-wins). A
  // half-dead socket from an MV3 SW-death has an older stamp, so a fresh redial
  // automatically supersedes it without us closing anything.
  extSocket() {
    let best = null;
    let bestAt = -1;
    for (const ws of this.ctx.getWebSockets('ext')) {
      if (ws.readyState !== 1) continue; // WebSocket.OPEN
      let at = 0;
      try { at = (ws.deserializeAttachment() || {}).connectedAt || 0; } catch { /* unstamped */ }
      if (at >= bestAt) { bestAt = at; best = ws; }
    }
    return best;
  }

  // How many extension browsers are currently paired+live to this user's DO.
  extSocketCount() {
    return this.ctx.getWebSockets('ext').filter((ws) => ws.readyState === 1).length;
  }

  // Targeted revoke (SPEC §7 + extension 4401 contract): oauth's revokeDevice
  // POSTs here with ?token=<deviceToken> after marking it revoked in D1. We close
  // the matching live socket(s) with code 4401 so the extension clears its stored
  // token and shows the re-pair UI (any other close code = ordinary drop →
  // reconnect). A *cold* revoke (token already offline) can't be signalled this
  // way — that's an accepted browser limitation (the next upgrade 401s → 1006).
  async #revokeDevice(request) {
    const token = new URL(request.url).searchParams.get('token');
    let closed = 0;
    if (token) {
      for (const ws of this.ctx.getWebSockets('ext')) {
        let dt = null;
        try { dt = (ws.deserializeAttachment() || {}).deviceToken; } catch { /* unstamped */ }
        if (dt === token) { try { ws.close(4401, 'device token revoked'); } catch {} closed++; }
      }
    }
    return new Response(JSON.stringify({ closed }), { headers: { 'content-type': 'application/json' } });
  }

  // Runtime delivers ext frames here (waking the DO from hibernation as needed).
  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return; // ignore non-JSON
    }

    if (msg.type === 'result') {
      const entry = this.pending.get(msg.id);
      if (!entry) return; // unknown/late id — timed out already
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      // SIGNUP-SPEC §5.2: the extension stamps the active-tab origin on each
      // result. Cache it for the consent gate / eval check / audit (fixes T3/T4).
      if (typeof msg.origin === 'string' && msg.origin) this.lastOrigin = msg.origin;
      // Strip the routing envelope (incl. origin); hand the reply ({result} |
      // {error,...extras}) back to the awaiting callExtension — same fields
      // handlers.js relies on.
      const { type, id, origin, ...reply } = msg;
      entry.resolve(reply);
      return;
    }

    if (msg.type === 'hello') {
      // Diagnostics only. Stash installId/version so it survives hibernation.
      try { ws.serializeAttachment({ installId: msg.installId, version: msg.version }); } catch { /* non-fatal */ }
      // The extension re-asserts the user's pause toggle on (re)connect when it
      // carries one, so the durable relay flag converges with the popup's state.
      if (typeof msg.drivingPaused === 'boolean') {
        try { await this.setDrivingPaused(msg.drivingPaused); } catch { /* non-fatal */ }
      }
      return;
    }

    // N2 kill-switch (SAFETY): the user toggled "Stop / Resume driving" in the
    // extension popup. Human-only — there is NO MCP tool to un-pause, so a
    // prompt-injection can't resume it. Persisted durably (survives hibernation).
    // Tolerant of both frame shapes: the canonical event envelope
    // {type:'event', event:'driving_paused'} (sendRelayEvent wraps payloads as
    // {type:'event',...}) AND a bare {type:'driving_paused'}.
    const evt = msg.type === 'event' ? msg.event : msg.type;
    if (evt === 'driving_paused' || evt === 'driving_resumed') {
      try { await this.setDrivingPaused(evt === 'driving_paused'); } catch { /* non-fatal */ }
      return;
    }

    // BACKGROUND PREWARM: the extension fired a 'navigated' event. Kick a debounced,
    // best-effort DOM page-map warm so the first fast_scout/vision call on the new
    // page is already warm. Runs in ctx.waitUntil so it neither blocks this message
    // handler nor lets the DO hibernate mid-warm; it never affects the live path.
    if (evt === 'navigated') {
      const url =
        (typeof msg.url === 'string' && msg.url) ||
        (msg.payload && typeof msg.payload.url === 'string' ? msg.payload.url : null) ||
        (msg.data && typeof msg.data.url === 'string' ? msg.data.url : null);
      try { this.ctx.waitUntil(this.#prewarmOnNav(url)); } catch { /* waitUntil unavailable — skip */ }
      return;
    }

    // {type:'pong'} and any other event are ignored. The {"ping":true} keepalive
    // never reaches here — it's handled by the auto-response pair without waking
    // the DO.
  }

  // Debounced, best-effort page-map prewarm on navigation. Lightweight: ONE viewport
  // snapshot → ONE Gemini page-map build (cached by URL inside the scout factory), so
  // a subsequent fast_scout for the same URL hits the warm cache. Guards (any → skip):
  //   • cooldown not elapsed (rate cap, free-tier safe)   • same URL already warmed
  //   • a warm already in flight                          • driving paused (N2)
  //   • a real MCP tool call is in flight (don't contend) • no Gemini key (tier off)
  async #prewarmOnNav(url) {
    try {
      const nowMs = Date.now();
      if (this._prewarm.inFlight) return;
      if (nowMs - this._prewarm.at < PREWARM_COOLDOWN_MS) return;
      if (url && url === this._prewarm.url) return;
      if (this.pending.size > 0) return;          // user is actively driving — don't inject
      if (await this.isDrivingPaused()) return;   // honor the Stop-driving kill-switch
      const scout = await this.getBoundScout();
      if (!scout || !scout.enabled) return;       // no per-user/operator key → vision tier off

      // Reserve the slot up-front so a burst of navs can't fan out into many warms.
      this._prewarm.inFlight = true;
      this._prewarm.at = nowMs;
      if (url) this._prewarm.url = url;

      const snap = await this.callExtension('fast_snapshot', { viewport: true, __prewarm: true });
      const digest = snap?.result;
      if (digest && Array.isArray(digest.items) && digest.items.length) {
        if (typeof digest.url === 'string') this._prewarm.url = digest.url;
        await scout.warm(digest); // builds + caches the page map (the warm Gemini call)
      }
    } catch { /* best-effort: prewarm must never affect the live call path */ }
    finally {
      this._prewarm.inFlight = false;
    }
  }

  async webSocketClose(ws) {
    this.#failPending(ws, 'Extension disconnected before response');
  }

  async webSocketError(ws) {
    this.#failPending(ws, 'Extension socket error');
  }

  // Fail (only) the pending requests that were sent on `ws`. Requests already
  // re-issued on a fresh socket are tagged with that socket and untouched.
  #failPending(ws, message) {
    for (const [id, entry] of this.pending) {
      if (entry.ws !== ws) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve({ error: message });
    }
  }

  // --- the call primitive mcp.js builds on ----------------------------------

  // Push {type:'call'} to the ext WS and await the matching {type:'result'}.
  // Mirrors fast-dxt/broker/router.js dispatchCall: UUID-keyed pending map, 30s
  // timeout, never rejects — failures resolve to an {error} payload so the MCP
  // layer can surface them as a tool result.
  callExtension(action, args, timeoutMs = REQUEST_TIMEOUT_MS) {
    const ws = this.extSocket();
    if (!ws) return Promise.resolve({ error: 'Chrome extension not connected.' });
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve({ error: `Timeout waiting for browser response (${timeoutMs}ms)` });
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, timer, ws });
      try {
        ws.send(JSON.stringify({ type: 'call', id, action, args: args || {} }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ error: `Send to extension failed: ${e.message}` });
      }
    });
  }

  // --- Gemini scout/vision tier (lazy, per-user) ----------------------------

  // The cache-holding scout factory (one per DO → page-map/visual-map caches are
  // per-user). The API KEY is NOT baked in here — it's resolved per call and
  // bound via getBoundScout(), so a user's own BYO key vs the operator key can
  // differ per request without losing the cache. See src/scout.js.
  getScout() {
    if (!this._scout) {
      this._scout = createScout({ model: this.env.FASTLINK_GEMINI_MODEL || 'gemini-2.5-flash-lite' });
    }
    return this._scout;
  }

  // BYO-KEY (SPEC §12): the user's own encrypted key wins, else the operator's
  // shared GEMINI_API_KEY secret. Returns '' when neither exists (vision tier
  // then self-disables cleanly).
  async resolveGeminiKey() {
    try {
      if (this.env.DB && this.userId) {
        const { getUserGeminiKey } = await import('./db.js');
        if (typeof getUserGeminiKey === 'function') {
          // Keys are AES-GCM encrypted at rest; db.js needs the env secret to
          // decrypt (it stays free of module-level secrets).
          const k = await getUserGeminiKey(this.env.DB, this.userId, this.env.KEY_ENC_SECRET);
          if (k) return k;
        }
      }
    } catch { /* fall through to operator key */ }
    return this.env.GEMINI_API_KEY || this.env.GOOGLE_API_KEY || '';
  }

  // A scout surface bound to the resolved key, sharing the per-DO caches. This is
  // what mcp.js/composite.js use for a single tools/call.
  async getBoundScout() {
    const key = await this.resolveGeminiKey();
    return this.getScout().withKey(key);
  }

  // --- SAFETY hooks (SPEC.md §7) --------------------------------------------

  // fast_evaluate is high-risk (arbitrary in-page JS). ALLOWLIST gate (SPEC §7/§12):
  // resolve the user's eval policy, then allow only when enabled AND (operator
  // test allow-all OR the active tab's origin is explicitly allowlisted).
  //
  // Policy shape (from db.getEvalPolicy): { allowEvaluate, allowAll, isOperator,
  // origins:[...] }. Without D1/userId (v1 test loop), fall back to the
  // ALLOW_EVALUATE env flag treated as operator allow-all.
  async evalPolicy() {
    try {
      if (this.env.DB && this.userId) {
        const { getEvalPolicy } = await import('./db.js');
        if (typeof getEvalPolicy === 'function') {
          const p = await getEvalPolicy(this.env.DB, this.userId);
          if (p) return { allowEvaluate: !!p.allowEvaluate, allowAll: !!p.allowAll, isOperator: !!p.isOperator, origins: Array.isArray(p.origins) ? p.origins : [] };
        }
      }
    } catch { /* fall through to env default */ }
    const v = this.env.ALLOW_EVALUATE;
    const on = v === 'true' || v === '1' || v === true;
    return { allowEvaluate: on, allowAll: on, isOperator: on, origins: [] };
  }

  // Resolve {ok} | {ok:false,error} for a fast_evaluate attempt. Reads the active
  // tab's origin (cheap fast_list, no debugger attach) only when needed to check
  // the allowlist.
  async checkEvalAllowed() {
    const p = await this.evalPolicy();
    if (!p.allowEvaluate) {
      return { ok: false, error: 'fast_evaluate is disabled for this account — enable it in relay settings (high-risk: it runs arbitrary JavaScript in your page).' };
    }
    if (p.allowAll) return { ok: true };
    const origin = await this.currentOrigin();
    if (origin && p.origins.includes(origin)) return { ok: true };
    return { ok: false, error: `fast_evaluate is disabled for this site — enable it and allowlist this origin (${origin || 'unknown'}) in relay settings.` };
  }

  // The active tab's origin. Prefers the cheap stamped cache (this.lastOrigin,
  // set from each result frame per SIGNUP-SPEC §5.2); falls back to a fast_list
  // probe until the extension stamping lands. '' if it truly can't be determined.
  async currentOrigin() {
    if (this.lastOrigin) return this.lastOrigin;
    const o = await this.activeOrigin();
    if (o) this.lastOrigin = o;
    return o;
  }

  // The active tab's origin via a cheap fast_list (no CDP/debugger attach → no
  // banner flicker). '' if it can't be determined.
  async activeOrigin() {
    try {
      const r = await this.callExtension('fast_list');
      const tabs = r?.result;
      const active = Array.isArray(tabs) ? tabs.find((t) => t.active) : null;
      if (active?.url) { try { return new URL(active.url).origin; } catch {} }
    } catch { /* ignore */ }
    return '';
  }

  // --- per-origin consent (M4 / SIGNUP-SPEC §4.2, §5.2) ---------------------

  // The default decision for an origin with NO stored consent row, bound to the
  // identity mode unless CONSENT_DEFAULT overrides it:
  //   shared/operator ⇒ 'allow'  (single trusted user — current behavior)
  //   magic           ⇒ 'prompt' (multi-user — first-touch approval required)
  // 'readonly' is also accepted (silent read-only default, no prompt affordance).
  consentDefault() {
    const raw = String(this.env.CONSENT_DEFAULT || '').toLowerCase();
    if (raw === 'allow' || raw === 'prompt' || raw === 'readonly') return raw;
    return this.#identityMode() === 'magic' ? 'prompt' : 'allow';
  }

  // Resolve the effective consent for an origin: an explicit stored row
  // ('allow'|'readonly'|'block') wins; otherwise the mode-bound default
  // ('allow'|'prompt'|'readonly'). Best-effort — falls back to the default on any
  // DB error or when identity/DB are absent (v1 test loop).
  async consentFor(origin) {
    if (origin && this.env.DB && this.userId) {
      try {
        const { getSiteConsent } = await import('./db.js');
        const mode = await getSiteConsent(this.env.DB, this.userId, origin);
        if (mode === 'allow' || mode === 'readonly' || mode === 'block') return mode;
      } catch { /* fall through to default */ }
    }
    return this.consentDefault();
  }

  // --- N2 kill-switch: "Stop driving" pause (SAFETY) ------------------------

  // Is driving paused? Reads the durable flag (cached in-memory after first read;
  // the cache is rebuilt after a hibernation wake). Fail-safe: on a storage error
  // returns the last-known value (defaulting to NOT paused).
  async isDrivingPaused() {
    if (this._paused === undefined) {
      try { this._paused = !!(await this.ctx.storage.get('drivingPaused')); }
      catch { this._paused = false; }
    }
    return this._paused;
  }

  // Set + persist the pause flag (human-initiated via the extension popup).
  async setDrivingPaused(paused) {
    this._paused = !!paused;
    try { await this.ctx.storage.put('drivingPaused', this._paused); } catch { /* non-fatal: in-memory cache still gates this warm DO */ }
  }

  // Best-effort push of an out-of-band frame to the live extension socket (e.g. a
  // {type:'consent_required',...} prompt so the toolbar popup can surface Allow /
  // Read-only / Block without waiting for the user to look at Claude). Never throws
  // into the call path; a no-op when no browser is connected.
  notifyExtension(obj) {
    try {
      const ws = this.extSocket();
      if (ws) ws.send(JSON.stringify(obj));
    } catch { /* non-fatal */ }
  }

  // IDENTITY_MODE reader (mirrors auth.js identityMode; kept local so the DO stays
  // decoupled from the auth handler module). 'magiclink' is an alias of 'magic'.
  #identityMode() {
    const raw = this.env.IDENTITY_MODE || (this.env.UPSTREAM_OAUTH_CLIENT_ID ? 'google' : 'shared');
    return raw === 'magiclink' ? 'magic' : raw;
  }

  // Append-only audit of every tool call. Best-effort: a no-op until oauth's
  // db.js + the DB binding exist, so the v1 test loop runs without D1. Never
  // throws into the call path.
  async audit(action, args, ok) {
    try {
      if (!this.env.DB || !this.userId) return;
      const { logAudit } = await import('./db.js');
      // Log argument KEYS only, never their values (could carry secrets/PII).
      // Include the active-tab origin (T4) so the log answers "what, and where".
      const detail = JSON.stringify({ args: Object.keys(args || {}), origin: this.lastOrigin || null, ok: !!ok });
      await logAudit(this.env.DB, this.userId, action, detail);
    } catch { /* auditing must never break a tool call */ }
  }
}
