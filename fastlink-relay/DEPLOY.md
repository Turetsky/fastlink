# FastLink Relay — Deployment Guide (OWNER steps)

Ordered, copy-pasteable steps to stand up the multi-tenant relay and connect it
to claude.ai. Run everything from `fastlink-relay/` under WSL. Binding/secret
names match **SPEC.md** (the contract).

> **Auth is already handled.** `wrangler` is on PATH and `CLOUDFLARE_API_TOKEN`
> is set in the environment (account `yjturetsky@gmail.com`), so every
> `wrangler` command below runs **non-interactively** — no `wrangler login`.
> Verify with: `wrangler whoami`.

Prerequisites: Node 18+, this repo checked out. `npm install` once to pull
`wrangler` + `@cloudflare/workers-oauth-provider`.

> **Identity = email magic-link** is the multi-user target (SPEC §11; no
> Google), `userId = sha256(normalized email)`. But **ship in shared mode first**
> (§4 Option A) — single-user, no email, live in minutes — then flip to
> magic-link once the **Resend** sending domain (`ytx.app`) is verified (§4
> Option B). Both modes are built; switching is just the `IDENTITY_MODE` var +
> secrets, no rebuild. Step 4 branches on this; step 7 (connector) is
> identity-agnostic.

---

## 1. Install deps

```bash
cd fastlink-relay
npm ci          # reproducible install from the committed package-lock.json
```

> Use `npm ci` (not `npm install`) for deploys — it installs the exact versions
> pinned in `package-lock.json`, so the security-critical OAuth provider can't
> silently jump to a newer release between deploys. `package-lock.json` is
> committed; regenerate it with `npm install --package-lock-only` only when you
> intentionally bump a dependency.

## 2. Create the D1 database + run the migration

```bash
npm run d1:create          # = wrangler d1 create fastlink-relay
```

Copy the printed `database_id` into **wrangler.toml** → `[[d1_databases]]` →
`database_id` (replace `REPLACE_ME_D1_DATABASE_ID`).

Apply the schema. There are **two** migrations authored by oauth —
`0001_init.sql` (users incl. `allow_evaluate`, pairing, devices, consent, audit)
and `0002_magic_links.sql` — and `wrangler d1 migrations apply` runs **all
pending migrations in order**, so one command does both:

```bash
npm run migrate:local      # optional: test against the local dev DB first
npm run migrate            # = wrangler d1 migrations apply fastlink-relay --remote
```

## 3. Create the OAuth KV namespace

`@cloudflare/workers-oauth-provider` stores clients/grants/tokens in KV.

```bash
npm run kv:create          # = wrangler kv namespace create OAUTH_KV
```

Copy the printed `id` into **wrangler.toml** → `[[kv_namespaces]]` → `id`
(replace `REPLACE_ME_OAUTH_KV_NAMESPACE_ID`). Optionally create a preview ns
for `wrangler dev` and set `preview_id`.

## 4. Choose identity mode + set secrets

`auth.js` authenticates the **human** behind one swappable `resolveUserId()`,
selected by the `IDENTITY_MODE` var (SPEC §4). Both modes are built — ship
**shared** to go live now, flip to **magic-link** once Resend is verified (no
rebuild). Secrets are NOT in wrangler.toml — set each with `wrangler secret put`
(pipe a random value straight in).

**Always required (every mode):**

```bash
# HMAC for the OAuth round-trip state cookie. REQUIRED — without it auth.js
# falls back to a known insecure default.
openssl rand -hex 32 | wrangler secret put COOKIE_SECRET
```

**Recommended (active-optional): vision/scout tier**

```bash
# Enables fast_scout/point/point_som/fill_vision/do/locate (SPEC §12, ported in
# task #7). OPTIONAL — without it those 6 tools return {disabled:true} and the
# relay still runs. Get a Gemini key from Google AI Studio. Operator pays for ALL
# users' vision calls — see the cost/abuse flag in SAFETY.md §11 before going
# multi-user.
wrangler secret put GEMINI_API_KEY
```

### Option A — Shared mode (recommended first deploy: single user, no email)

The fastest path to a live relay — no email provider needed. Keep
`IDENTITY_MODE = "shared"` (default) and `SHARED_USER_ID` (default `"owner"`) in
wrangler.toml, and set the gate secret the human types at `/authorize`:

```bash
openssl rand -hex 32 | wrangler secret put OWNER_SECRET       # canonical name; SHARED_SECRET is an accepted alias
```

Every grant resolves to the single `SHARED_USER_ID`. **Single-tenant — do NOT
open to other users in this mode** (they'd all share one DO/browser fleet).

### Option B — Magic-link mode (multi-user; needs Resend)

Set `IDENTITY_MODE = "magiclink"` in wrangler.toml. The `/authorize` page asks
for an email, mails a signed one-time link, and on callback sets `userId =
sha256(normalized email)` — full multi-user, multi-device.

```bash
openssl rand -hex 32 | wrangler secret put MAGICLINK_SECRET   # HMAC for link tokens (falls back to COOKIE_SECRET)
wrangler secret put MAIL_API_KEY                              # Resend API key
```

`MAIL_FROM` (var, default `login@ytx.app`) is the link's From address.

> **Email-provider prerequisite (team-lead TODO):** `auth.js` sends via
> **Resend**. The owner must: create a Resend account, **verify the `ytx.app`
> sending domain** (add the DKIM/SPF DNS records Resend provides), then set
> `MAIL_API_KEY`. Until that's done, run in **shared mode** (Option A). (auth.js
> reads `MAIL_API_KEY || RESEND_API_KEY` — standardize on `MAIL_API_KEY`.)

### Optional — BYO per-user Gemini key + operator eval (tasks #9/#10)

Advanced, additive — skip for a basic deploy. Lets each user supply their **own**
Gemini key (so the operator isn't funding everyone's vision calls — the per-user
answer to the cost flag in SAFETY.md §11), stored AES-GCM-encrypted at rest in D1.

```bash
openssl rand -hex 32 | wrangler secret put KEY_ENC_SECRET   # encrypts per-user Gemini keys at rest
```

`KEY_ENC_SECRET` is **one shared value**: oauth's db.js AES-GCM-encrypts each
user's BYO key with it, and relay-core's DO decrypts with the same secret
(`getUserGeminiKey(DB, userId, env.KEY_ENC_SECRET)`) — set it once, identically.
It's a secret, not a var (no wrangler.toml binding). Set it **before** enabling
BYO keys; if unset (or a user has no stored key), BYO decrypt returns `null` and
the relay **gracefully falls back** to the operator `GEMINI_API_KEY`. Optional
var `OPERATOR_EMAIL` (magic-link mode) marks one email `is_operator=1`, enabling
operator-only `fast_evaluate` test mode; in shared mode the bootstrap user is
operator automatically.

## 5. Public base URL (already set: relay.ytx.app)

The relay is served at the custom domain **`relay.ytx.app`** (zone `ytx.app`,
already on this account). wrangler.toml already has `RELAY_BASE =
"https://relay.ytx.app"`, the matching `[[routes]]` custom-domain entry, and
`ALLOWED_ORIGINS = "https://claude.ai"` — no edit needed unless the domain
changes.

## 6. Deploy

```bash
npm run deploy             # = wrangler deploy
```

Uploads the Worker, registers the `UserRelay` Durable Object (migration `v1`,
SQLite-backed), binds D1 + KV, and provisions the `relay.ytx.app` custom domain
(auto-creates the DNS record + managed TLS cert — first deploy may take a minute
for the cert to go live).

Sanity checks:

```bash
curl https://relay.ytx.app/health                                   # -> ok
curl https://relay.ytx.app/.well-known/oauth-authorization-server   # OAuth metadata JSON
npm run tail                                                        # live logs while you test
```

---

## 7. Add the custom connector in claude.ai

1. claude.ai → **Settings → Connectors → Add custom connector**.
2. **MCP server URL:** `https://relay.ytx.app/mcp`
   (`RELAY_BASE` + the OAuth-protected `/mcp` route).
3. claude.ai discovers OAuth via `/.well-known/oauth-authorization-server`,
   dynamic-registers at `/oauth/register` (RFC 7591), then opens `/authorize`
   with PKCE S256.
4. Complete the **authorize** screen — in magic-link mode `auth.js` emails a
   one-time link; click it to verify, deriving `userId = sha256(email)`, then it
   calls `completeAuthorization` and 302s back. (In shared mode you enter the
   `OWNER_SECRET` value instead.) On success claude.ai stores the token and the
   connector goes live.

> Discovery/registration error? Confirm `/health` and the metadata endpoint
> return 200 and that the provider's `authorizeEndpoint` / `tokenEndpoint` /
> `clientRegistrationEndpoint` resolve under `RELAY_BASE`. (OAuth flow owned by
> `oauth` — flag it to them.)

---

## 8. Install + pair the Chrome extension

The relay drives the **paired** browser; nothing happens until a browser dials in.

1. Load the FastLink extension (`fast-ext/`) — `chrome://extensions` →
   Developer mode → **Load unpacked** (or install the published build once
   listed).
2. Mint a one-time pairing code: as the signed-in user hit `POST /pair/new`
   (relay web UI) → short code, 10-min TTL (SPEC §4B).
3. In the extension popup, choose **relay mode** and paste the code → the
   extension `POST`s `/pair/claim`, receives `{ deviceToken, userId, wssUrl }`,
   stores them in `chrome.storage.local`, and dials
   `wss://relay.ytx.app/ext?token=<deviceToken>`.
4. The popup should show **connected** + current **mode**. A **"use local
   broker"** toggle restores the localhost path (don't regress it — Claude
   Code/Desktop rely on it).

> ⚠️ **v1 deployment posture — guardrails not yet live.** v1 ships
> **single-operator** (shared mode), so the consent guardrails described in
> SAFETY.md are the *design target*, **not active yet**: read-only default,
> per-origin consent prompts, the activity overlay, and a relay Stop/Disconnect
> kill switch all land with the **multi-user hardening (task #12)**. Until then,
> a connected session can drive the browser without per-action gating — keep the
> relay single-operator and trusted. Do **not** enable magic-link / multi-user
> before #12 ships.

---

## 9. End-to-end smoke test

1. In claude.ai (connector enabled), ask it to read the active tab → a
   snapshot/observe call should succeed.
2. Ask Claude to click/fill on a non-sensitive page → confirm it runs. (In v1
   this needs no per-origin approval — actions aren't gated yet; that gating +
   the activity overlay arrive with task #12.)
3. `npm run tail` should show the upgrade routed to a DO and `grants_audit`
   entries for the action (SAFETY.md §5).
4. To stop a session today, **unpair / toggle off relay mode in the extension
   popup** (this drops the WebSocket). A dedicated relay **Stop/Disconnect** kill
   switch lands with task #12.

---

## Redeploy / iterate

- Code change only: `npm run deploy`.
- New D1 migration (from oauth): `npm run migrate` then `npm run deploy`.
- Rotate a secret: re-run the matching `wrangler secret put …`.
- New DO class or rename: add a NEW `[[migrations]]` tag in wrangler.toml
  (never edit an applied tag) and redeploy.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `wrangler` asks to log in | token not in env | `export CLOUDFLARE_API_TOKEN=…`; `wrangler whoami` |
| Deploy fails: DO class not found | `UserRelay` not exported from `src/index.js` | relay-core: re-export the class from the main module |
| Deploy fails: migration mismatch | edited an applied tag | add a NEW `[[migrations]]` tag instead |
| Deploy fails: Node built-in missing | `nodejs_compat` not applied | confirm `compatibility_flags = ["nodejs_compat"]` + recent compat date |
| connector won't authorize | metadata 404 / non-absolute endpoints | fix `RELAY_BASE`; check `/.well-known/...` returns 200 |
| extension won't connect | wrong base URL / Origin rejected | check `ALLOWED_ORIGINS` var + popup relay URL + deviceToken |
| shared-mode `/authorize` always denies | bootstrap secret unset | `wrangler secret put OWNER_SECRET` (alias `SHARED_SECRET` also accepted) |
| auth "insecure default" warning | `COOKIE_SECRET` unset | `wrangler secret put COOKIE_SECRET` (required all modes) |
| vision tools return `{disabled:true}` | `GEMINI_API_KEY` unset | `wrangler secret put GEMINI_API_KEY` (optional but enables scout/vision) |
| `/mcp` CORS preflight fails in browser | OAuthProvider may reject the unauthenticated `OPTIONS` before relay-core's apiHandler runs | preflight carries no `Authorization`; if it never reaches the handler, oauth's defaultHandler must answer `OPTIONS /mcp` (204) — relay-core handles the case where it does reach it |

---

*Owned by infra-docs. OAuth-flow specifics (endpoints, scopes, secrets) owned by
`oauth`; DO/binding names owned by `relay-core`. Reconciled against the FINAL
SPEC.md + verified secret names from auth.js (via integrator).*
