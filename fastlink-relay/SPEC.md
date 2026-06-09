# FastLink Relay — SPEC (the contract)

Multi-tenant Cloudflare relay so **Claude on the web (claude.ai custom connector) drives EACH USER'S OWN browser**. Replaces the localhost-only broker (`fast-dxt/broker/`) with a cloud relay. One **Durable Object per user**, strict per-user isolation. Reuses the FastLink action protocol + `tools.js` surface verbatim.

This file is the **interface contract** between four builders. Signatures here are normative — match them exactly so the pieces compose. If a builder needs to change a cross-file signature, edit this file and message the affected builder.

---

## 1. Architecture

```
  ┌──────────────┐   MCP Streamable HTTP (/mcp)        ┌─────────────────────────────────────┐
  │  claude.ai   │   POST JSON-RPC + Bearer access tok │         FastLink Relay Worker        │
  │  (web custom │ ──────────────────────────────────► │  src/index.js  (OAuthProvider entry) │
  │  connector)  │ ◄────────────────────────────────── │   • apiRoute   '/mcp'  → apiHandler  │
  └──────────────┘   JSON-RPC result                   │   • default    '/authorize','/oauth',│
        │  OAuth 2.1 + PKCE                             │                '/pair','/ext'        │
        │  (/authorize, /oauth/token, /oauth/register) │                                      │
        └────────────────────────────────────────────► │  src/auth.js   (OAuth glue, userId)  │
                                                        │  src/db.js     (D1 helpers)          │
                                                        │     │ resolve userId                 │
                                                        │     ▼                                │
                                                        │  env.USER_RELAY.idFromName(userId)   │
                                                        │     │                                │
                                                        │     ▼   ONE Durable Object PER USER  │
                                                        │  src/userRelay.js  (UserRelay DO)    │
                                                        │   • holds the extension WS (server)  │
                                                        │   • WebSocket Hibernation (idle ~$0) │
                                                        │   • pending{ id→resolver } in-mem    │
                                                        │   • MCP tool call → {type:'call'}    │
                                                        └───────────────┬─────────────────────┘
                                                                        │  WSS  /ext?token=deviceTok
                                                  outbound dial-out     │  (relay is the WS SERVER;
                                                  {type:'call'}  ▲      ▼   ext is the CLIENT)
                                                  {type:'result'}│  ┌──────────────────────────┐
                                                                 └──│  fast-ext (MV3 extension) │
                                                                    │  src/relayClient.js       │
                                                                    │  drives the active tab    │
                                                                    │  (local broker fallback)  │
                                                                    └──────────────────────────┘
            ┌──────────┐  D1 (SQLite): users, devices, pairing_codes, grants_audit, site_consent
            │   D1 DB  │◄─ migrations/0001_init.sql
            └──────────┘
```

**Two transports, one DO.** claude.ai↔relay is **MCP Streamable HTTP** (request/response, OAuth-bearer). extension↔relay is an **outbound WSS** the extension dials; the relay DO is the WS **server** and accepts it **hibernatably**. The DO is the meeting point: an MCP `tools/call` becomes a `{type:'call'}` frame pushed down the user's extension WS, and the `{type:'result'}` frame resolves the awaiting MCP request.

**Isolation:** the DO name **is** the `userId`. User A's MCP calls can only reach `idFromName(A)`, which only holds A's extension socket. No shared state, no cross-tenant fan-out.

---

## 2. Directory & file ownership

```
fastlink-relay/
  SPEC.md                  ← this file (architect)
  src/
    index.js               ← relay-core   Worker entry: OAuthProvider, route → DO
    userRelay.js           ← relay-core   UserRelay Durable Object (WS server + MCP handler)
    mcp.js                 ← relay-core   minimal MCP JSON-RPC (initialize/tools.list/tools.call) + dispatchTool
    scout.js               ← relay-core   PORT of fast-dxt scout/vision helpers, Gemini via fetch (task #7, §12)
    auth.js                ← oauth        OAuth handlers (authorize UI, upstream login, userId)
    db.js                  ← oauth        D1 query helpers (pure functions, no globals)
  migrations/
    0001_init.sql          ← oauth        D1 schema
  tools.js                 ← relay-core   COPIED from fast-dxt/server/tools.js (TOOLS array)
  wrangler.toml            ← infra-docs   bindings: DO, D1, vars, compat date
  package.json             ← infra-docs   deps + scripts
  DEPLOY.md                ← infra-docs   step-by-step deploy + claude.ai connector setup
  SAFETY.md                ← infra-docs   consent / injection / audit / revocation model

fast-ext/                  (existing extension repo)
  src/relayClient.js       ← extension    NEW: dial-out WSS client to the relay
  src/connection.js        ← extension    EDIT: choose local broker OR relay (keep fallback)
  background.js            ← extension    EDIT: 1-line wiring + pairing message handler
  popup/ or options        ← extension    NEW minimal: paste pairing code → POST /pair/claim
```

**Ownership rule:** only the named builder edits its files. `tools.js` is owned by relay-core but is a verbatim copy — do not diverge the schema from `fast-dxt/server/tools.js`.

---

## 3. Cross-file interfaces (normative signatures)

### 3a. `src/index.js` — Worker entry (relay-core)

Exports the `OAuthProvider` as the default Worker handler. `apiRoute:'/mcp'` is OAuth-protected; everything else goes to the default handler (auth UI, pairing, the `/ext` WS upgrade).

```js
// src/index.js
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { makeDefaultHandler } from './auth.js';   // owns /authorize,/oauth/*,/pair/*,/ext
export { UserRelay } from './userRelay.js';        // DO class, bound as USER_RELAY

// API handler: OAuth already validated the Bearer token and attached the grant's
// props to ctx.props. We trust ctx.props.userId (set at completeAuthorization).
export class FastlinkApiHandler extends WorkerEntrypoint {
  async fetch(request) {
    const { env, ctx } = this;
    const userId = ctx.props?.userId;                       // ← identity from OAuth grant
    if (!userId) return new Response('no userId in grant', { status: 401 });
    const id = env.USER_RELAY.idFromName(String(userId));   // ← ONE DO PER USER
    const stub = env.USER_RELAY.get(id);
    // Forward the MCP POST to the DO, tagging the path so the DO routes it to MCP.
    const url = new URL(request.url); url.pathname = '/__mcp';
    return stub.fetch(new Request(url, request));
  }
}

export default new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: FastlinkApiHandler,
  defaultHandler: makeDefaultHandler(),   // { fetch(request, env, ctx) }
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',   // claude.ai dynamic-registers here
  scopesSupported: ['browser.drive'],
  accessTokenTTL: 3600,
});
```

> `env.OAUTH_PROVIDER` is auto-injected by the library into every handler's `env`; auth.js uses it for `parseAuthRequest` / `completeAuthorization`.

### 3b. `src/auth.js` — OAuth + pairing routes (oauth)

```js
// src/auth.js
// Returns the OAuthProvider defaultHandler. Owns every non-/mcp route.
export function makeDefaultHandler() {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname === '/authorize')        return handleAuthorize(request, env);     // consent UI + upstream login
      if (url.pathname === '/authorize/callback') return handleUpstreamCallback(request, env); // upstream IdP → completeAuthorization
      if (url.pathname === '/pair/new')         return handlePairNew(request, env);       // logged-in user mints a one-time code
      if (url.pathname === '/pair/claim')       return handlePairClaim(request, env);     // extension exchanges code → deviceToken
      if (url.pathname === '/ext')              return handleExtUpgrade(request, env);     // WSS upgrade → route to user's DO
      if (url.pathname === '/' || url.pathname === '/health') return new Response('ok');
      return new Response('not found', { status: 404 });
    },
  };
}

// authorize: authenticate the human (upstream IdP — Google recommended; magic-link
// acceptable for v1), derive a STABLE userId, then:
//   const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
//     request: oauthReqInfo, userId, scope: ['browser.drive'],
//     metadata: { ts }, props: { userId },     // ← props.userId is what apiHandler reads
//   });
//   return Response.redirect(redirectTo, 302);

// /ext upgrade: validate the device token, resolve its userId, forward the upgrade
// request to THAT user's DO (the DO performs ctx.acceptWebSocket).
export async function handleExtUpgrade(request, env) {
  if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected ws', { status: 426 });
  const token = new URL(request.url).searchParams.get('token');
  const device = await import('./db.js').then(m => m.lookupDevice(env.DB, token));   // { userId, revoked } | null
  if (!device || device.revoked) return new Response('unauthorized', { status: 401 });
  const stub = env.USER_RELAY.get(env.USER_RELAY.idFromName(String(device.userId)));
  const u = new URL(request.url); u.pathname = '/__ext';                              // tag for DO routing
  return stub.fetch(new Request(u, request));   // pass the Upgrade through to the DO
}
```

### 3c. `src/db.js` — D1 helpers (oauth)

Pure async functions; first arg is always the D1 binding `env.DB`. No module-level state.

```js
export async function upsertUser(db, userId, profile);              // -> void
export async function createPairingCode(db, userId, code, ttlSec);  // -> { code, expiresAt }
export async function claimPairingCode(db, code);                   // -> { userId } | null  (single-use; marks used)
export async function createDevice(db, userId, deviceToken, label); // -> void
export async function lookupDevice(db, deviceToken);                // -> { userId, label, revoked } | null
export async function revokeDevice(db, deviceToken);                // -> void
export async function listDevices(db, userId);                     // -> [{ deviceToken(masked), label, lastSeen, revoked }]
export async function logAudit(db, userId, action, detail);        // -> void  (append-only)
export async function getSiteConsent(db, userId, origin);          // -> 'allow' | 'readonly' | 'block' | null
export async function setSiteConsent(db, userId, origin, mode);    // -> void
export async function getAllowEvaluate(db, userId);                // -> boolean (per-user fast_evaluate opt-in)
export async function setAllowEvaluate(db, userId, allowed);       // -> void
// fast_evaluate allowlist (test-now + allowlist-ready):
export async function getEvalPolicy(db, userId);                   // -> { allowEvaluate, allowAll, isOperator, origins:[...] }
export async function setEvalAllowAll(db, userId, allowAll);       // -> void  (operator test mode)
export async function addEvalOrigin(db, userId, origin);           // -> void
export async function removeEvalOrigin(db, userId, origin);        // -> void
// BYO Gemini key (operator-key-now, BYO-ready). keyEncSecret (env.KEY_ENC_SECRET) is
// PASSED IN, not imported — keeps db.js pure (no module-level secrets/globals). AES-GCM.
export async function getUserGeminiKey(db, userId, keyEncSecret);      // -> decrypted key string | null (null → use operator key)
export async function setUserGeminiKey(db, userId, key, keyEncSecret); // -> void  (stored ENCRYPTED at rest)
export async function isOperator(db, userId);                          // -> boolean
export async function setOperator(db, userId, isOp);                   // -> void
// NOTE: getEvalPolicy() structurally forces allowAll=false for NON-operators inside the
// helper — a non-operator can never get blanket eval regardless of the column value.
```

### 3d. `src/userRelay.js` — the per-user Durable Object (relay-core)

```js
// src/userRelay.js
import { DurableObject } from 'cloudflare:workers';
import { handleMcpRequest } from './mcp.js';

export class UserRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx; this.env = env;
    this.pending = new Map();   // mcpCallId -> { resolve, timer }   (in-mem, lives for the call)
    // Auto ping/pong without waking the DO (keeps the ext WS warm during hibernation).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"ping":true}', '{"pong":true}'));
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/__ext') return this.#acceptExtension(request);   // WSS server side
    if (path === '/__mcp') return handleMcpRequest(request, this);  // MCP JSON-RPC
    return new Response('not found', { status: 404 });
  }

  // --- extension WS (hibernatable server) ---
  #acceptExtension(request) {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ['ext']);     // ← hibernation: DO may evict while idle
    // Stamp arrival for most-recent-wins routing (survives hibernation).
    const deviceToken = new URL(request.url).searchParams.get('token') || null;
    server.serializeAttachment({ connectedAt: Date.now(), deviceToken });
    return new Response(null, { status: 101, webSocket: client });
  }
  // Runtime delivers ext frames here (wakes DO from hibernation as needed).
  async webSocketMessage(ws, raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'result') {                   // {type:'result', id, result|error, ...extras}
      const p = this.pending.get(msg.id);
      if (p) { clearTimeout(p.timer); this.pending.delete(msg.id); p.resolve(msg); }
    }
    // msg.type === 'event' (e.g. 'navigated') / 'hello' / 'pong' handled here too.
  }
  async webSocketClose(ws) { /* fail any pending with error; clear */ }

  // MULTI-DEVICE, most-recent-wins. A user may pair SEVERAL browsers — all their
  // ext sockets attach to THIS one DO (tag 'ext'). Commands route to the MOST
  // RECENTLY connected socket. We stamp each accepted socket with connectedAt via
  // serializeAttachment (survives hibernation) and pick the max here.
  extSocket() {
    const socks = this.ctx.getWebSockets('ext').filter((w) => w.readyState === 1);
    if (!socks.length) return null;
    return socks.reduce((best, w) =>
      ((w.deserializeAttachment()?.connectedAt || 0) > (best.deserializeAttachment()?.connectedAt || 0) ? w : best));
  }
  extSocketCount() { return this.ctx.getWebSockets('ext').filter((w) => w.readyState === 1).length; }

  // Called by mcp.js for a tools/call. Mirrors broker/router.js dispatchCall:
  // push {type:'call'} to the ext WS, await the matching {type:'result'}.
  callExtension(action, args, timeoutMs = 30000) {
    const ws = this.extSocket();
    if (!ws) return Promise.resolve({ error: 'Chrome extension not connected.' });
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve({ error: `Timeout waiting for browser response (${timeoutMs}ms)` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try { ws.send(JSON.stringify({ type: 'call', id, action, args: args || {} })); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); resolve({ error: `Send to extension failed: ${e.message}` }); }
    });
  }
}
```

> **Hibernation × pending map.** The in-memory `pending` map is safe because a `tools/call` keeps the DO's `/__mcp` `fetch` promise **awaiting** — an in-flight request prevents eviction, so `pending` survives send→receive. The DO only hibernates when **fully idle** (no awaiting MCP request), and at that point there is nothing pending to lose. The ext WS stays open across hibernation; auto-response keeps pings answered without waking.

> **Multi-device, most-recent-wins.** A user may pair MULTIPLE browsers — every one of their extensions dials `/ext` and all attach to this same DO (tag `'ext'`). `extSocket()` routes each command to the most-recently-connected live socket (via the `connectedAt` attachment), so the last browser the user paired/opened is the active driver. Older sockets stay connected (warm, still pingable) but don't receive commands unless they later become the newest. Likewise claude.ai may be signed in on several devices — all those grants carry the same `userId` and hit the same DO. This is intentional fan-IN to one DO, not a violation of per-user isolation (the boundary is the *user*, not the device).

### 3e. `src/mcp.js` — MCP JSON-RPC (relay-core)

Stateless Streamable HTTP, same spirit as `fast-dxt/server/transports.js` but hand-rolled for Workers (no Node SDK). One POST → one JSON response (no SSE session needed for claude.ai).

```js
// src/mcp.js
import { TOOLS } from './tools.js';

// `relay` is the UserRelay DO instance (has .callExtension).
export async function handleMcpRequest(request, relay) {
  const rpc = await request.json();                 // JSON-RPC 2.0 (single or batch)
  const out = await handleOne(rpc, relay);
  return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
}

async function handleOne(rpc, relay) {
  switch (rpc.method) {
    case 'initialize':   return ok(rpc.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} },
                                             serverInfo: { name: 'fastlink-relay', version: '1.0.0' } });
    case 'tools/list':   return ok(rpc.id, { tools: TOOLS });
    case 'tools/call':   return ok(rpc.id, await dispatchTool(rpc.params, relay));
    case 'ping':         return ok(rpc.id, {});
    default:             return err(rpc.id, -32601, 'method not found');
  }
}

// MUST mirror fast-dxt/server/handlers.js dispatchCall surface: the server-side
// composite tools (fast_scout/point/fill_vision/do/locate/batch/screenshot save)
// run HERE, calling relay.callExtension(...) for each browser primitive — so the
// extension still only implements the raw actions it does today.  Returns
// MCP { content:[{type:'text', text: JSON.stringify(result)}] }.
async function dispatchTool(params, relay) { /* ... */ }
```

**Decision (UPDATED — scout is IN for v1).** The Gemini-backed composite tools (`fast_scout`, `fast_point`, `fast_fill_vision`, `fast_do`, `fast_locate`) live in `handlers.js`/`scout.js` today and need `GEMINI_API_KEY` + (for screenshots) file writes. They are **ported into the Worker** — see §12. `dispatchTool` runs them server-side just like `handlers.js`, calling `relay.callExtension(...)` for each browser primitive and `fetch`-ing the Gemini Generative Language API directly (no Node deps, no `/tmp`: screenshots stay as data URLs in memory and are returned inline, never written to disk). The raw/DOM tools (snapshot/click/fill/nav/etc.) route straight through `callExtension`. `tools.js` is copied whole. `fast_screenshot`/`fast_marks` return inline data URLs rather than `/tmp` paths (note this small return-shape difference vs. the WSL server). Owner: relay-core, task #7, after #2.

---

## 4. OAuth 2.1 + device pairing — end to end

**Identity — v1 ships `IDENTITY_MODE=shared` (LOCKED). magic-link is fully built but gated; flip `IDENTITY_MODE=magiclink` after the human does the email/DNS setup.** The relay is the OAuth provider for claude.ai; how it authenticates the *human* is isolated so the two modes are interchangeable without touching anything downstream. Identity is resolved at the point each mode actually knows the human, then handed to `completeAuthorization({ userId, props:{ userId } })` — the rest of the system never sees the mode.

- **Mode `shared` — V1 DEFAULT (single-user bootstrap):** no email/DNS needed. The human enters `OWNER_SECRET` at `/authorize`; identity resolves to ONE fixed `userId` (`SHARED_USER_ID`, that account flagged `is_operator=1`). Lets the relay go live immediately. **Single-tenant** — do NOT open to other users in this mode (everyone would share one DO/browser fleet).
- **Mode `magiclink` (built, gated):** `/authorize` emails a signed one-time link; on the callback `userId = sha256(lower(trim(email)))`. Requires the email provider + DNS wired (`MAIL_API_KEY` + `MAGICLINK_SECRET`). Full multi-user, multi-device. Flip to this once setup is done — no code change, just the env var.

Selected by env var `IDENTITY_MODE` (canonical `shared` | `magiclink`; the code also accepts the alias `magic` for `magiclink`). Either way `userId` is the DO key and the OAuth `props.userId`. **Same owner/email ⇒ same `userId` ⇒ same DO** — across every claude.ai device and every paired browser.

> **Resolution points (per oauth's implementation, ratified):** the literal single-entry `resolveUserId(env, ctx)` is a *logical* contract, not a required call site — the two modes derive identity at different steps with different inputs: `shared` → `sharedUserId(env)` at the `/authorize` form submit; `magiclink` → `sha256(email)` at `/authorize/callback` after the link click. Both end in the same `completeAuthorization({ userId, props:{ userId } })`. No other caller needs a unified entry point, so the per-mode derivation stands. (If a future caller needs one, oauth adds a thin `identityMode()` dispatcher wrapper.)

**A. claude.ai connects (OAuth 2.1 + PKCE):**
1. User adds the custom connector in claude.ai pointing at `https://relay.ytx.app/mcp`.
2. claude.ai discovers `/.well-known/oauth-authorization-server` (OAuthProvider serves it) and dynamic-registers at `/oauth/register`.
3. claude.ai opens `/authorize?...&code_challenge=...` (PKCE S256). `auth.js` authenticates the **human** by **emailing a magic-link**: the consent page asks for the email, `/authorize` mails a signed one-time link (`MAIL_API_KEY`, token signed with `MAGICLINK_SECRET`, short TTL), the user clicks it → `/authorize/callback` verifies the token, derives `userId = resolveUserId(email)`, then calls `env.OAUTH_PROVIDER.completeAuthorization({ userId, props:{ userId }, scope:['browser.drive'], metadata:{ email } })` and 302s back to claude.ai.
4. claude.ai exchanges the code at `/oauth/token` (provider-implemented) → access + refresh tokens.
5. Every `/mcp` call carries `Authorization: Bearer <access>`; the provider validates it and exposes `ctx.props.userId` to `FastlinkApiHandler`.
6. **Multi-device claude.ai:** the user can repeat A on a second laptop/phone — each is its own OAuth grant but the same email ⇒ same `userId` ⇒ same DO. All their claude.ai sessions drive the one browser fleet.

**B. Extension pairing — MULTIPLE browsers per account:**
1. Signed-in user (magic-link session on the relay web UI) hits `POST /pair/new` → `db.createPairingCode(userId, code, 600)` → shows a short one-time code (`8 chars`, 10-min TTL). They can do this once per browser they want to pair.
2. In each extension's popup, the user pastes a code → extension `POST /pair/claim {code}`.
3. `auth.js` `handlePairClaim`: `db.claimPairingCode(code)` (single-use) → `userId`; mint a long-lived random `deviceToken` (≥128-bit); `db.createDevice(userId, deviceToken, label)`; return `{ deviceToken, userId, wssUrl: 'wss://relay.ytx.app/ext' }`. **Each paired browser gets its OWN `deviceToken` row** — N devices per `userId` is expected.
4. Each extension stores its `deviceToken` in `chrome.storage.local`, dials `wss://relay.ytx.app/ext?token=<deviceToken>`.
5. `handleExtUpgrade` validates the token → `userId` → forwards the upgrade to `idFromName(userId)`'s DO. **All of a user's browsers attach to the same DO** (tag `'ext'`).
6. **Routing across devices (most-recent-wins):** the DO's `extSocket()` sends each command to the most-recently-connected live socket. Re-opening/re-pairing a browser makes it the active driver; the others stay connected and warm. (A future tool arg could target a specific device by label; out of scope for v1.)

Now `userId` is the join key: **all** of a user's claude.ai grants **and all** their extension sockets resolve to the **same DO**.

---

## 5. Extension side (extension builder)

### 5a. `fast-ext/src/relayClient.js` (NEW)

Mirror `connection.js`'s lifecycle (alarms-based reconnect, ping loop, badge), but:
- URL is `wss://relay.ytx.app/ext?token=<deviceToken>` (from `chrome.storage.local`), not `ws://127.0.0.1:<port>`.
- **Inbound frame shape changes:** the relay sends `{ type:'call', id, action, args }` (the broker today sends `{ id, action, args }` with no `type`). Handle both. Reply with `{ type:'result', id, ...reply }` (broker today replies `{ id, ...reply }`).
- Reuse `dispatchAction` from `src/actions/index.js` **unchanged** — same action names, same returns.
- `sendEvent` posts `{ type:'event', ... }` (navigated, etc.) — DO `webSocketMessage` may ignore or use for future pre-warm.

```js
// dispatch contract (unchanged): const reply = await handle(action, args);  // {result}|{error}
// onmessage:
//   if (msg.type === 'call') ws.send(JSON.stringify({ type:'result', id: msg.id, ...await handle(msg.action, msg.args||{}) }));
export function startRelayConnection(handle, { wssUrl, deviceToken }) { /* alarms + reconnect + ping */ }
export async function claimPairingCode(code, relayBase) { /* POST /pair/claim → store deviceToken; returns {userId} */ }
```

### 5b. `connection.js` / `background.js` (EDIT — keep local fallback)

`background.js` chooses mode from stored config — **local broker stays the default/fallback**:
```js
const { fastlinkMode, deviceToken, relayBase } = await chrome.storage.local.get([...]);
if (fastlinkMode === 'relay' && deviceToken)
  startRelayConnection(dispatchAction, { wssUrl: `${relayBase}/ext`, deviceToken });
else
  startConnection(dispatchAction);   // existing localhost broker path, untouched
```
Add a popup/options affordance: paste pairing code → `claimPairingCode` → set `fastlinkMode='relay'`. A "use local broker" toggle restores the current behavior. **Do not remove or regress the localhost broker path** — it's how Claude Code/Desktop still work.

---

## 6. D1 schema — `migrations/0001_init.sql` (oauth)

```sql
CREATE TABLE users (
  user_id        TEXT PRIMARY KEY,      -- resolveUserId(email): sha256(normalized email)
  email          TEXT,
  created_at     INTEGER NOT NULL,
  allow_evaluate INTEGER NOT NULL DEFAULT 0,  -- per-user opt-in for fast_evaluate (off by default)
  eval_allow_all INTEGER NOT NULL DEFAULT 0,  -- when allow_evaluate: permit eval on ANY origin (operator test mode)
  gemini_key_enc TEXT,                        -- per-user BYO Gemini key, ENCRYPTED at rest; NULL → use operator key
  is_operator    INTEGER NOT NULL DEFAULT 0   -- operator account: exempt from the multi-user allowlist/key gates
);
-- Per-user, per-origin allowlist for fast_evaluate (eval fires only if origin is here,
-- unless eval_allow_all=1). Empty list + allow_all=0 ⇒ eval never fires.
CREATE TABLE eval_allowed_origins (
  user_id  TEXT NOT NULL,
  origin   TEXT NOT NULL,               -- e.g. https://console.cloud.google.com
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, origin)
);
CREATE TABLE pairing_codes (
  code        TEXT PRIMARY KEY,         -- short one-time code
  user_id     TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,                  -- NULL until claimed (single-use)
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);
CREATE TABLE devices (
  device_token TEXT PRIMARY KEY,        -- long-lived bearer the extension holds
  user_id      TEXT NOT NULL,
  label        TEXT,
  created_at   INTEGER NOT NULL,
  last_seen    INTEGER,
  revoked      INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);
CREATE INDEX idx_devices_user ON devices(user_id);
CREATE TABLE site_consent (                -- per-user, per-origin consent (SAFETY)
  user_id     TEXT NOT NULL,
  origin      TEXT NOT NULL,             -- e.g. https://mail.google.com
  mode        TEXT NOT NULL,             -- 'allow' | 'readonly' | 'block'
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, origin)
);
CREATE TABLE grants_audit (               -- append-only action log (SAFETY)
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  action      TEXT NOT NULL,             -- tool name, e.g. fast_click
  detail      TEXT                       -- JSON: {origin, argsSummary, ok}
);
CREATE INDEX idx_audit_user_ts ON grants_audit(user_id, ts);
```

---

## 7. SAFETY / consent model (infra-docs owns SAFETY.md; relay-core enforces)

claude.ai driving a real browser session = the user's live cookies/auth. Guardrails:

- **Prompt-injection containment.** A page can try to talk Claude into actions. Mitigate by **per-origin consent** (`site_consent`): on first action against a new origin the relay returns a `consent_required` result (the user approves in the relay UI / extension), recorded in D1. Never auto-allow.
- **Read-only default (opt-in stricter mode).** A `mode='readonly'` consent lets snapshot/text/screenshot/list through but **blocks mutating actions** (`fast_click`, `fast_fill*`, `fast_type`, `fast_key*`, `fast_nav`, `fast_evaluate`, `fast_drag*`, `fast_select_option`). Enforced in `dispatchTool` via a MUTATING-action set before `callExtension`.
- **Audit log.** Every tool call appends to `grants_audit` (`user_id, ts, action, origin, ok`). User-visible history; the basis for "what did Claude do?".
- **Revocable tokens.** OAuth access/refresh revocable via the provider (and short access TTL = 1h). Device tokens revocable via `db.revokeDevice` → the next `/ext` dial and in-flight sends are rejected. A revoked device's open WS should be closed by the DO.
- **`fast_evaluate` is high-risk** (arbitrary JS in the page) → **per-user opt-in + per-origin allowlist, OFF by default.** `dispatchTool` enforces, via `db.getEvalPolicy(userId)`: eval fires ONLY when `allowEvaluate === true` **AND** ( `allowAll === true` **OR** the page's origin ∈ `origins` ). Otherwise returns `{ error: 'fast_evaluate is disabled for this account/site — enable it and allowlist this origin in relay settings' }`.
  - `allowAll` (operator test mode) lets the operator test freely on any site once eval is enabled — fine for the single operator account.
  - **Defense-in-depth (implemented):** `db.getEvalPolicy()` **structurally forces `allowAll=false` for non-operators** inside the helper — a stranger can never get blanket eval regardless of the column value. So `allowAll` is effectively operator-only by construction, not just by policy.
  - **BLOCKER for multi-user (oauth's security audit, task #8 verifies end-to-end):** before magic-link opens to strangers, any **non-operator** user MUST have a **non-empty allowlist** (and `allowAll` is already forced `0` for them per above). Enforce/verify this gate before public launch.
  - To get the origin in the DO: pass the active tab's origin alongside the eval call (the extension already knows it), or resolve it via a cheap `fast_list`. Scope is per-userId, per-origin — never global.
- **Strict tenant isolation** is structural: DO keyed by `userId`; an MCP grant can only reach its own DO; the extension socket only attaches to its owner's DO. No code path crosses users.
- **Transport security:** WSS + HTTPS only; device token in query string is acceptable over TLS but prefer `Sec-WebSocket-Protocol` header if feasible. Bound token entropy ≥128 bits.

---

## 8. Infra — `wrangler.toml` shape (infra-docs)

```toml
name = "fastlink-relay"
main = "src/index.js"
compatibility_date = "2026-04-07"          # ≥ for web_socket_auto_reply_to_close
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "USER_RELAY"
class_name = "UserRelay"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["UserRelay"]         # SQLite-backed DO (required for new DOs)

[[d1_databases]]
binding = "DB"
database_name = "fastlink-relay"
database_id = "<from: wrangler d1 create fastlink-relay>"

# REQUIRED by @cloudflare/workers-oauth-provider — it stores clients/grants/tokens
# here itself (keys: client:*, grant:{userId}:*, token:*). Binding name MUST be OAUTH_KV.
[[kv_namespaces]]
binding = "OAUTH_KV"
id = "<from: wrangler kv namespace create OAUTH_KV>"

[vars]
RELAY_BASE = "https://relay.ytx.app"
IDENTITY_MODE = "shared"      # V1 DEFAULT (locked). canonical "shared" | "magiclink" (alias "magic" accepted). §4
SHARED_USER_ID = "owner"      # fixed userId for shared mode (that account is is_operator=1)
# secrets (wrangler secret put):
#   OWNER_SECRET      — entry secret for "shared" single-user mode  (canonical; alias SHARED_SECRET still read)
#   MAGICLINK_SECRET  — HMAC key signing magic-link tokens   (magiclink mode)
#   MAIL_API_KEY      — email provider (Resend/MailChannels) to send the link (magiclink mode)
#   KEY_ENC_SECRET    — AES-GCM key encrypting per-user BYO Gemini keys at rest (§6 gemini_key_enc)
#   GEMINI_API_KEY    — operator's shared key for the scout/vision tier (§12); BYO override per-user, §11 flag
```

**Canonical naming (ratified — aliases kept as a safety net so already-wired config doesn't break):**
- `IDENTITY_MODE`: canonical values `shared` / `magiclink`; the code ALSO accepts `magic` → normalized to `magiclink`.
- Bootstrap secret: canonical `OWNER_SECRET`; the code ALSO reads `SHARED_SECRET` (`OWNER_SECRET || SHARED_SECRET`).
- infra-docs: document ONLY the canonical names (`magiclink`, `OWNER_SECRET`); the aliases stay in code, undocumented.

Domain is **relay.ytx.app** — used for OAuth redirect URIs, the claude.ai connector URL (`https://relay.ytx.app/mcp`), and the wrangler route/zone. Add a `[[routes]]`/custom-domain entry binding `relay.ytx.app` to the Worker.

`package.json` deps: `@cloudflare/workers-oauth-provider`. Dev/deploy scripts: `wrangler dev`, `wrangler deploy`, `wrangler d1 migrations apply fastlink-relay`.

---

## 9. Cost notes

- **WebSocket Hibernation** is the whole game: an idle paired browser holds an open WS but the DO is **evicted from memory** → **no duration billing while idle**. Auto ping/pong (`setWebSocketAutoResponse`) answers keepalives **without waking** the DO. Wall-cost ≈ requests + active-CPU during real tool calls + D1 reads.
- One DO per user is cheap at rest; DOs spin up on first MCP/WS activity and hibernate after.
- D1: tiny per-call writes (audit). Batch/skip audit for read-only snapshots if volume matters.
- No persistent compute, no always-on server. Contrast the WSL broker (always running locally).

---

## 10. Build order & dependencies

1. **relay-core** (`index.js`, `userRelay.js`, `mcp.js`, copy `tools.js`) — can stub `auth.js`'s `userId` to a constant to test the DO + MCP + ext-WS loop end to end first.
2. **oauth** (`auth.js`, `db.js`, `0001_init.sql`) — replaces the stub; owns identity + pairing.
3. **extension** (`relayClient.js` + wiring) — depends on `/ext` + `/pair/claim` contracts (§3b, §5).
4. **infra-docs** (`wrangler.toml`, `package.json`, `DEPLOY.md`, `SAFETY.md`) — depends on binding names (`USER_RELAY`, `DB`) and routes above.

Integration/reconcile + STATUS.md is task #6.

---

## 11. Decisions (resolved by human) + remaining flag

RESOLVED:
- **Identity: v1 ships `IDENTITY_MODE=shared`** (single-user bootstrap, `OWNER_SECRET`, no email). magic-link is fully built but gated — flip `IDENTITY_MODE=magiclink` after the human wires email/DNS (`MAIL_API_KEY` + `MAGICLINK_SECRET`). No Google upstream. Full multi-device per account once on magic-link. §4. *(Resolved by team-lead — was the only pending identity question.)*
- **Scout/vision = ported into the Worker** (not deferred). `fetch` to Gemini, inline images, shared `GEMINI_API_KEY`. §12, task #7.
- **Domain = relay.ytx.app.** Connector URL `https://relay.ytx.app/mcp`. §8.
- **`fast_evaluate` = per-user opt-in, OFF by default.** `db.getAllowEvaluate(userId)`. §7.

STILL OPEN (decided for v1; these are the PRE-MULTI-USER gates):
- **Gemini key = operator-now, BYO-ready.** v1: per call uses `db.getUserGeminiKey(userId) ?? env.GEMINI_API_KEY` (user's own encrypted key if set, else operator's shared key). No per-user quota in v1. **Before magic-link opens to strangers, decide whether to DISABLE the operator-key fallback for non-operator users** (so the operator doesn't pay strangers' Gemini bills) — i.e. require BYO key for non-operators. Schema + getters/setters are built now; only the policy switch is deferred.
- **`fast_evaluate` allowlist = BLOCKER for multi-user.** v1 allows the operator `eval_allow_all` to test freely. **Before public launch, any non-operator user MUST have a non-empty per-origin allowlist and `allowAll` forced to 0.** oauth's security audit (task #8) must verify this gate exists and flag it as a hard blocker for non-operator accounts.

---

## 12. Scout & vision tiers — Worker-side port (relay-core, task #7, after #2)

Port the server-side composite tools from `fast-dxt/server/{handlers,scout}.js` to run **inside `dispatchTool`** in the Worker. They orchestrate browser primitives (via `relay.callExtension`) plus Gemini calls — no Node-only deps, so the port is mechanical once the I/O shims are swapped.

**What moves:** `fast_scout`, `fast_point`, `fast_point_som`, `fast_fill_vision`, `fast_do`, `fast_locate`, plus the helpers (`pointOnce`, `domLocate`, `refinePoint`, `screenshotRung`, tier escalation). The orchestration logic copies almost verbatim — only the boundaries change.

**Shims to write (the only real work):**
- `callExtension(action, args)` → `relay.callExtension(action, args)` (the DO method, §3d). Drop-in for `brokerClient.callExtension`.
- `scout.js`'s Gemini calls (`scout`, `pointByImage`, `boxByImage`, `pickMarks`, `planByImage`, `visualMap`, `locateByImage`) → rewrite the transport as `fetch('https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent?key=' + env.GEMINI_API_KEY, { method:'POST', body: JSON.stringify({ contents, generationConfig }) })`. Same prompts, same response parsing — only the HTTP client changes (no SDK).
- **No `/tmp`.** `fast_screenshot`/`fast_marks` return their data URL **inline** in the tool result (the WSL server wrote a `/tmp` path; the relay returns `{ dataUrl }` instead). Internal vision rungs already pass dataURLs around in memory — keep them in memory.
- **Pre-warm / prewarm-gate:** the navigation pre-warm machinery (`prewarmVision`, `prewarmScout`, the activity window) is OPTIONAL for v1 — the `'navigated'` event arrives as a `{type:'event'}` frame on the ext WS (`webSocketMessage`). v1 may skip pre-warming and just build the map on first `fast_scout`; note this is a perf-only omission. If kept, store the warm capture/map in the DO instance (lost on hibernation — acceptable, it's a cache).
- **Gemini key (operator-now, BYO-ready):** resolve per call as `db.getUserGeminiKey(userId) ?? env.GEMINI_API_KEY` — use the user's own encrypted key if they've set one, else fall back to the operator's shared `GEMINI_API_KEY` (§8). `scout.js`'s Gemini helpers take the resolved key as a parameter (don't read `env` directly — the DO passes it in, since it knows the `userId`). No per-user quota in v1. See §11 for the pre-multi-user decision to disable the operator-key fallback for non-operators.
- **Timeouts:** Gemini `fetch` should have an AbortController timeout; a slow vision call must not exceed the DO's request budget.

**Order:** land the raw/DOM relay loop first (task #2), prove an end-to-end MCP→DO→ext→tab click, THEN port scout (task #7) on top. The composite tools are pure additions to `dispatchTool` — they don't change the protocol or the DO/WS plumbing.
```
