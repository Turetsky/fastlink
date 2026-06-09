# FastLink Relay — Integration STATUS

_Integrator reconciliation of the multi-tenant Cloudflare relay (tasks #2–#5, plus #7 vision port) against SPEC.md._
_Last updated: 2026-06-08 (post vision-port, magic-link, BYO-key + eval-allowlist #9/#10)._

Multi-tenant relay so **claude.ai (web custom connector) drives each user's own Chrome browser**.
claude.ai ⇄ relay over **MCP Streamable HTTP + OAuth 2.1**; the extension dials **out over WSS** to a
**per-user Durable Object** that bridges the two. One DO per `userId` = structural tenant isolation.
Served at the custom domain **`relay.ytx.app`**.

---

## 1. State at a glance

| Piece | Owner | Status |
|---|---|---|
| Worker entry + routing (`index.js`) | relay-core | ✅ built, imports reconciled |
| Per-user DO (`userRelay.js`) | relay-core | ✅ WS hibernation, pending map, most-recent-wins, `getScout()` |
| MCP JSON-RPC (`mcp.js`) | relay-core | ✅ raw tools pass through + vision tiers routed to composite.js |
| Vision/scout port (`scout.js`, `composite.js`) | relay-core | ✅ **task #7 done** — Gemini over fetch, per-DO caches |
| `tools.js` | relay-core | ✅ byte-identical to `fast-dxt/server/tools.js` (diff-verified) |
| OAuth + pairing + magic-link (`auth.js`) | oauth | ✅ 3 identity modes; **4401 patch by integrator** (§4) |
| D1 helpers (`db.js`) | oauth | ✅ SPEC §3c + magic-link + per-user evaluate helpers |
| D1 schema (`0001_init.sql`, `0002_magic_links.sql`) | oauth | ✅ both present |
| `wrangler.toml` / `package.json` | infra-docs | ✅ bindings + custom domain; ⚠️ secret-name drift (§4) |
| `DEPLOY.md` / `SAFETY.md` | infra-docs | ✅ relay.ytx.app; ⚠️ secret-name fixes pending (§4) |
| Extension relay client + UI | extension | ✅ `relayClient.js`, `background.js`, `connection.js`, `options.*` |

**Bottom line:** all five builders' pieces + the #7 vision port compose on paper. Every cross-file import/
export resolves, all relay `src/*.js` + `tools.js` + the 4 extension JS files pass `node --check`, the
on-wire protocol matches byte-for-byte on both ends, DO binding names line up, and the ported vision tier
drives only extension actions the extension actually implements. **Not yet deployed / not yet run live.**
Two **doc-only** secret-name drifts are flagged to infra-docs (§4) — they break the documented deploy path
until corrected, but the code itself is correct.

---

## 2. Full file tree

```
fastlink-relay/
  SPEC.md                    architect — interface contract
  STATUS.md                  this file
  DEPLOY.md  SAFETY.md       infra-docs — deploy steps + threat model
  package.json               infra-docs — @cloudflare/workers-oauth-provider ^0.7.2, wrangler scripts
  wrangler.toml              infra-docs — DO USER_RELAY, D1 DB, KV OAUTH_KV, custom_domain relay.ytx.app, vars
  migrations/
    0001_init.sql            oauth — users, pairing_codes, devices, site_consent, grants_audit
    0002_magic_links.sql     oauth — magic_links (single-use email sign-in)
  tools.js                   relay-core — verbatim copy of fast-dxt/server/tools.js (TOOLS export)
  src/
    index.js                 relay-core — OAuthProvider default; '/mcp' → FastlinkApiHandler → DO '/__mcp'
    userRelay.js             relay-core — UserRelay DO: WS server, callExtension, pending map, getScout()
    mcp.js                   relay-core — MCP JSON-RPC; raw → callExtension, vision → composite.js
    scout.js                 relay-core — Gemini client (createScout), per-DO page/visual-map caches
    composite.js             relay-core — handleScout/Point/PointSom/FillVision/Do/Locate orchestration
    auth.js                  oauth — defaultHandler: /authorize (+magic/shared/google), /pair/*, /ext, /health
    db.js                    oauth — D1 helpers (pure, first arg env.DB)

fast-ext/  (existing extension; relay additions)
  manifest.json              +options_ui
  background.js              EDIT — transport selector: local broker (default) vs relay (when paired)
  src/
    relayClient.js           NEW — outbound WSS client to /ext; pairing claim; alarms reconnect; 4401/4000 handling
    connection.js            EDIT — now returns handler hooks (behavior identical); local-broker fallback intact
  options.html / options.js  NEW — paste pairing code → /pair/claim → flip to relay mode
```

---

## 3. Verified (by reading + checks)

- **All relay imports/exports reconcile:**
  - `index.js` ← `makeDefaultHandler` (auth.js ✓), re-exports `UserRelay` (userRelay.js ✓).
  - `userRelay.js` ← `handleMcpRequest` (mcp.js ✓), `createScout` (scout.js ✓), dynamic `logAudit` (db.js ✓).
  - `mcp.js` ← `TOOLS` (tools.js ✓) and all 6 composite handlers `handleScout/handlePoint/handlePointSom/handleFillVision/handleDo/handleLocate` (composite.js exports all 6 ✓).
  - `auth.js` uses `db.{upsertUser,createPairingCode,claimPairingCode,createDevice,lookupDevice,touchDevice,logAudit,createMagicLink,claimMagicLink}` — all exported by db.js ✓.
- **DO binding** `USER_RELAY` ↔ `class_name="UserRelay"` ↔ exported `UserRelay` ✓.
- **On-wire protocol (extension ⇄ DO) matches exactly:**
  - relay→ext `{type:'call', id, action, args}`; ext→relay `{type:'result', id, ...reply}`; keepalive ext sends **exactly** `{"ping":true}` → DO auto-responds `{"pong":true}` without waking (byte-for-byte string match confirmed).
  - `{type:'hello'}` / `{type:'event'}` handled/ignored as designed. 4401 (revoked) → re-pair; 4000 (superseded) → ignored, reconnect.
- **Action naming is identical on both transports.** Local `handlers.js`/broker send `action = fast_<name>` (prefixed); relay `userRelay.callExtension(name)` sends the same prefixed name; extension `runOne()` switches on `fast_`-prefixed names. So the relay path uses the exact wire contract the extension already serves locally. **Verified end-to-end** (handlers.js ↔ broker/router.js ↔ fast-ext/src/actions/index.js).
- **Vision tier drives only supported extension actions.** `composite.js` calls `callExtension('fast_snapshot' | 'fast_marks' | 'fast_vision_capture' | 'fast_annotate_boxes' | 'fast_click_xy' | 'fast_type' | 'fast_key_press' | 'fast_wheel' | 'fast_macro_list')` — every one is handled by the extension's `runOne()`. It mirrors `fast-dxt/server/handlers.js` call-for-call, so if local vision works, relay vision works (modulo the Gemini key).
- **Scout wiring:** `userRelay.getScout()` lazily builds one `createScout({apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY, model: env.FASTLINK_GEMINI_MODEL || 'gemini-2.5-flash-lite'})` per DO (per-user caches, no cross-tenant leak). No key → `enabled:false` → the 6 vision tools return a clean `{disabled:true}`.
- **Magic-link path reconciles:** auth.js `createMagicLink`/`claimMagicLink` ↔ db.js helpers ↔ `0002_magic_links.sql` table; single-use, 15-min TTL, `userId = sha256(email)`.
- **`tools.js` byte-identical** to source (`diff -q` → identical). **D1 timestamps** ms-epoch both sides.
- **`db.logAudit` accepts string OR object `detail`** (stringifies objects) — userRelay's pre-stringified detail and auth.js's object detail both work.
- **All relay `src/*.js` + extension relay JS pass `node --check`**, AND every relative import is
  **resolution-verified** (each `./`/`../` path checked to point at a real file, not just syntax): index.js→./auth.js,./userRelay.js; userRelay.js→./mcp.js,./scout.js,dynamic ./db.js ×3; mcp.js→**../tools.js** (root-level, the only `../` case),./composite.js; auth.js→./db.js. _(Note: `node --check` is syntax-only and will pass a wrong import path — an earlier draft mislabeled mcp.js's then-`./tools.js` as resolved; it was later corrected to `../tools.js` and is now confirmed.)_
- **Options UI wiring**: `options.html` has every id `options.js` queries; manifest registers `options_ui`.
- **Local-broker fallback preserved**: `connection.js` behavior unchanged; relay used only when `fastlinkMode==='relay' && deviceToken`. Claude Code / Desktop unaffected.
- **Multi-device most-recent-wins (SPEC §3d)**: `#acceptExtension` stamps each socket `serializeAttachment({connectedAt, deviceToken})`; `extSocket()` returns the newest LIVE socket (no socket is force-closed, so a user's other browsers stay attached). `fast_status` reports `devicesConnected`. Extension's old 4000-supersede handling is now moot but harmless.
- **Live device revocation wired end-to-end**: `auth.js revokeDeviceAndClose()` (auth.js:369) sets the D1 revoked flag (`db.revokeDevice`) then POSTs the DO `/__revoke?token=`, which closes the matching live socket(s) with code **4401** → extension clears its token + shows re-pair. (Caveat: nothing yet *calls* `revokeDeviceAndClose` — no revoke route/UI — so the mechanism is complete but untriggered; see gap.)
- **Per-user `fast_evaluate` gate wired**: `mcp.js` does `await relay.allowEvaluate()` (mcp.js:158) → `db.getAllowEvaluate(userId)` (with `ALLOW_EVALUATE` env fallback); `users.allow_evaluate INTEGER DEFAULT 0` column added to `0001_init.sql`. OFF by default.
- **/mcp CORS**: `index.js` echoes an allowlisted `Origin` (`ALLOWED_ORIGINS`, default `https://claude.ai`) and answers `OPTIONS` 204 (see §6 caveat about preflight reaching the apiHandler).
- **Identity/secret name aliases reconcile**: `IDENTITY_MODE='magiclink'`→`'magic'` (auth.js:388), `OWNER_SECRET||SHARED_SECRET` (auth.js:400), `GEMINI_API_KEY||GOOGLE_API_KEY` (userRelay:235) — so docs and code agree regardless of which name is set.
- **BYO Gemini key (tasks #9/#10) reconciles**: `db.getUserGeminiKey/setUserGeminiKey` (AES-GCM at rest via `KEY_ENC_SECRET`) ↔ `userRelay.resolveGeminiKey()` (per-user key ?? operator `GEMINI_API_KEY`) ↔ `getBoundScout().withKey()` ↔ `scout.js createScout({model}).withKey(apiKey)` (self-disables without a key). `mcp.js` uses `getBoundScout()` (key-bound) for ALL vision dispatch, `fast_prewarm`, and `fast_status` — no stale unbound `getScout()` left.
- **Eval allowlist (tasks #9/#10) reconciles**: `mcp.js` → `relay.checkEvalAllowed()` → `db.getEvalPolicy` → `{allowEvaluate, allowAll(operator-only), isOperator, origins[]}`; gate = enabled AND (allowAll OR active-tab origin ∈ origins), origin via `callExtension('fast_list')`. Schema columns + `eval_allowed_origins` table present in `0001_init.sql`.

## 3b. Assumed (NOT verifiable without deploy / live run)

- **`@cloudflare/workers-oauth-provider@^0.7.2` API surface** — constructor options, `parseAuthRequest`/`completeAuthorization`, and grant `props` arriving on `ctx.props` of the WorkerEntrypoint api handler. `index.js` reads `this.ctx?.props?.userId ?? this.props?.userId` defensively. **Most likely first-deploy breakage point — verify against the installed version.**
- **claude.ai custom-connector OAuth discovery / dynamic registration** served by the library — assumed, not exercised.
- **Streamable-HTTP shape** claude.ai expects (mcp.js is request/response only, declines GET/SSE with 405) — assumed sufficient.
- **Gemini vision quality through the relay** — the port mirrors local logic, but no live capture→Gemini→click round-trip has been run in the cloud. Screenshots flow as base64 (no `/tmp`); large images count against Worker/subrequest limits — untested at scale.
- **Magic-link email delivery** (Resend via `MAIL_API_KEY`/`MAIL_FROM`) — code path present, never sent a real email.
- **WebSocket from the extension SW to `wss://relay.ytx.app/ext`** without an added host permission — assumed OK (WS isn't host-permission-gated; `<all_urls>` covers the `/pair/claim` fetch, and auth.js returns `access-control-allow-origin: *`).

---

## 4. Integration fixes (by integrator) + flagged drifts

**FIX APPLIED — `src/auth.js` `handleExtUpgrade` (revoked/invalid device token).**
The extension listens for WS close **`4401`** as its "token revoked → stop, clear, re-pair" signal, but the
handler rejected bad tokens with HTTP 401 at the handshake (a browser WS only sees generic `1006`, so the
UX never fired and it slow-looped a dead token). Fixed the smaller side: reject with `wsReject(4401, …)`
(accept-then-close) instead of HTTP 401. A *thrown* DB error still 500s → extension treats as transient and
retries; only a genuinely unknown/revoked token clears the device. **Survived oauth's later magic-link
rework** (confirmed still present). oauth notified.

**RESOLVED during reconciliation — secret/mode name drifts now reconcile via aliases (oauth):**
- `OWNER_SECRET` vs `SHARED_SECRET`: `ownerSecret(env) = env.OWNER_SECRET || env.SHARED_SECRET` (auth.js:400).
  **Canonical = `OWNER_SECRET`** (what infra-docs documents); SHARED_SECRET is a back-compat alias. Either
  works — no longer a deploy blocker. (An earlier STATUS draft + a message to infra-docs flagged this the
  wrong way round off a stale read; retracted.)
- `IDENTITY_MODE`: `identityMode()` aliases `'magiclink' → 'magic'` (auth.js:388-390), so infra-docs'
  `IDENTITY_MODE="magiclink"` and the code's internal `'magic'` agree.

**STILL FLAGGED to infra-docs (doc-only):**
1. **`COOKIE_SECRET` is required, not optional.** Docs hedge "SPEC §8 omits it; confirm if read." Confirmed
   read in every mode — `cookieSecret = env.COOKIE_SECRET || '<insecure dev default>'` (auth.js:540; magic
   signing falls back to it at :546). Must be set for production or you run on a known-insecure default.
2. DEPLOY.md magic-link section should name `MAIL_API_KEY` (or `RESEND_API_KEY`) + `MAIL_FROM` +
   `MAGICLINK_SECRET`, NOT `EMAIL_PROVIDER_API_KEY` (wrangler.toml already correct; auth.js reads MAIL_API_KEY at :425).

---

## 5. OWNER-ONLY checklist (humans must do these)

### A. Deploy the relay (Cloudflare account + zone `ytx.app`)
1. `cd fastlink-relay && npm install`
2. `npm run d1:create` → paste **database_id** into `wrangler.toml` (`REPLACE_ME_D1_DATABASE_ID`).
3. `npm run kv:create` → paste **id** into `wrangler.toml` (`REPLACE_ME_OAUTH_KV_NAMESPACE_ID`).
4. `npm run migrate` (applies `0001_init.sql` **and** `0002_magic_links.sql` to remote D1). ⚠️ The #9 schema
   (gemini_key_enc / eval_allow_all / is_operator / allow_evaluate columns + `eval_allowed_origins` table)
   lives **inside the edited `0001_init.sql`**, not a separate migration. Fresh DB = clean. But if this D1 ever
   had an OLDER `0001` applied, D1 won't re-run the edited file (it tracks by name) → those columns will be
   MISSING and BYO-key/eval queries will error. On a previously-migrated DB: drop+recreate it, or hand-author
   a `0003` ALTER. Never-migrated DB: no action.
5. `RELAY_BASE` and the `[[routes]]` custom domain are already set to `relay.ytx.app` — change only if the host differs.
6. **`COOKIE_SECRET` (required, all modes):** `openssl rand -hex 32 | wrangler secret put COOKIE_SECRET`.
7. Choose identity mode (set `IDENTITY_MODE` in wrangler.toml — default shipped is `shared`):
   - **shared** (`IDENTITY_MODE="shared"`, fastest bring-up, single-user): `openssl rand -hex 32 | wrangler secret put OWNER_SECRET` (canonical; `SHARED_SECRET` accepted as an alias); optional `SHARED_USER_ID`.
   - **magiclink** (`IDENTITY_MODE="magiclink"`, multi-user, SPEC §4 final): `wrangler secret put MAGICLINK_SECRET` + `MAIL_API_KEY` (or `RESEND_API_KEY`) + `MAIL_FROM` (verified sender).
   - **google** (legacy/dormant): `UPSTREAM_OAUTH_CLIENT_ID` + `UPSTREAM_OAUTH_CLIENT_SECRET`; Google OAuth client with redirect `https://relay.ytx.app/authorize/callback`.
8. **Vision/scout tier (optional):** `wrangler secret put GEMINI_API_KEY` sets the **operator/default** key enabling `fast_scout/point/point_som/fill_vision/do/locate` (model overridable via `FASTLINK_GEMINI_MODEL`). Without it those 6 return `{disabled:true}`; raw DOM tools work regardless. Users may instead **bring their own key** (stored encrypted) — if any do, also set `KEY_ENC_SECRET`: `openssl rand -hex 32 | wrangler secret put KEY_ENC_SECRET` (AES-GCM key for per-user keys at rest; one shared value).
9. `npm run deploy` (provisions the custom domain + managed TLS on first deploy).

### B. Connect claude.ai
10. claude.ai → add a **custom connector** at `https://relay.ytx.app/mcp`.
11. Complete OAuth consent (email magic-link, or the shared-mode `OWNER_SECRET` form) → confirm 302 back and the FastLink tools appear.

### C. Pair a browser
12. Load `fast-ext/` unpacked (or publish to the Chrome Web Store — **not yet published**; owner step for non-dev installs).
13. On the relay site generate a pairing code (`/pair/new`); in the extension **Options** page paste the relay base + code → **Pair & use cloud relay**; badge → green.
14. From claude.ai run `fast_status` → expect `connected: true`; then `fast_snapshot` / a vision tool on your active tab.

### Open product decision (only one left, SPEC §11)
- **Which identity mode is the real default**: shared (single-user bootstrap) vs magiclink (multi-user, needs an email provider configured). Both are built; this is a human call, not a code gap.

---

## 6. KNOWN GAPS (documented, not hidden)

1. **(RESOLVED) Secret/mode name reconciliation.** Canonical names settled: `OWNER_SECRET` (SHARED_SECRET
   alias), `IDENTITY_MODE="magiclink"` (magic alias), `COOKIE_SECRET` required in all modes. Code reads both
   spellings (auth.js:388/400); infra-docs' wrangler.toml + DEPLOY.md updated to match. No deploy-blocking
   drift remains here.
2. **Per-origin consent / read-only mode is scaffolded but INERT (= task #12 / M4).** `mcp.js` has the
   `MUTATING_TOOLS` set + `relay.readonly` enforcement point and `db.{get,set}SiteConsent` exist, but nothing
   wires `site_consent` → `relay.readonly`, and there's no `consent_required` first-touch flow. **In single-user
   operator/shared mode this is fine** (you only drive your own browser). It's the **gate before enabling
   magic-link/multi-user** — tracked as #12 M4 (relay-core has proposed the dispatchTool gate; waiting on
   oauth's approve-UX / `consent_required` contract). Other #12 items already landed: **M1** S256-only PKCE
   (`allowPlainPKCE:false`, index.js:99), **M6** BYO-key encryption-at-rest (KEY_ENC_SECRET, done in #10).
3. **No revoke route/UI triggers the (working) live-revocation mechanism.** `auth.js revokeDeviceAndClose()`
   fully closes a live socket with 4401 (§3), but no endpoint or page calls it, and `db.listDevices` has no
   caller either — so a user can't see or revoke paired browsers from the relay site. The plumbing is done;
   the surface isn't. _(Resolves the earlier "live revocation not implemented" gap — mechanism now exists.)_
4. **(DONE & reconciled — tasks #9/#10) `fast_evaluate` allowlist + BYO Gemini key.** `fast_evaluate` now
   gates on `relay.checkEvalAllowed()` → `db.getEvalPolicy`: **enabled AND (operator `eval_allow_all` OR the
   active-tab origin ∈ `eval_allowed_origins`)**; the origin is read via a cheap `callExtension('fast_list')`,
   and `eval_allow_all` is honored only for `is_operator`. BYO key: `userRelay.resolveGeminiKey()` returns the
   user's own AES-GCM-encrypted key (`db.getUserGeminiKey` + `KEY_ENC_SECRET`) **else** the operator
   `GEMINI_API_KEY`, bound per-call via `getBoundScout().withKey(key)` (shared per-DO caches). New `users`
   columns (`gemini_key_enc`, `eval_allow_all`, `is_operator`, `allow_evaluate`) + `eval_allowed_origins`
   table were added to **`0001_init.sql`** (no separate migration file — fine since nothing is deployed). All
   verified; no management UI/route to set these yet (operator must seed via SQL or a future settings page).
5. **Audit log is best-effort, key-only, no origin.** `grants_audit` records `{args:[…keys], ok}` — never
   values, and **no `origin`** (the relay doesn't yet know the active tab's origin; the extension would need
   to report it, which also blocks per-origin consent #2). No audit-viewing UI.
6. **(RESOLVED — task #11) `/mcp` CORS preflight.** The default export is now a thin wrapper (index.js:110-120)
   that intercepts `OPTIONS /mcp` and answers it 204 with CORS headers *before* delegating to
   `oauthProvider.fetch()` — so the unauthenticated browser preflight never reaches the provider's 401.
   Verified structurally; still worth a live smoke-test against the real claude.ai connector (the only true
   confirmation).
7. **OAuth-provider runtime assumptions unverified** — see §3b. Props location / option names are the single
   most likely first-deploy break.
8. **Nothing deployed or run live.** All verification here is static (reading + `node --check` + `diff`). No
   `wrangler dev`, no real claude.ai handshake, no real pairing, no live Gemini round-trip, no magic-link email sent.

---

## 7. Tasks #7 / #8

- **#7 (port scout/vision) — DONE and reconciled.** `src/scout.js` + `src/composite.js` are wired through
  `mcp.js` and `userRelay.getScout()`; they drive only extension actions the extension implements; gated on
  the optional `GEMINI_API_KEY`. Earlier STATUS drafts listed this as "deferred" — that is now obsolete.
- **#8 (security audit) — pending, not integrator's.** Maps directly onto gaps #2 (inert consent), #4 (live
  revocation), #5 (audit origin), and the §4 secret hygiene. oauth is taking this; STATUS handed off.
