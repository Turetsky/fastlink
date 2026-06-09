# FastLink Sign-up / Auto-pair — Integration & Verify Status

_Integrator: `integrator` (task #6). Date: 2026-06-08. Scope: reconcile + security re-audit of the signup batch (tasks #2 ext-auth, #3 relay-auth, #4 hardening, #5 webstore) against the live relay. **NOTHING DEPLOYED — verify only.** The relay at `relay.ytx.app` is LIVE and claude.ai is using it; all changes below are code-on-disk awaiting a future deploy window._

---

## Verdict

**Code is integrated, internally consistent, and safe to land — but do NOT deploy yet (human said claude.ai is busy).** Every cross-team contract reconciles; the new multi-user surface is sound. The currently-deployed shared-mode relay is unaffected by merging this code (all new gates are no-ops or fail-open until their migration + env flips happen).

### Verify results (all ✅)

| Check | Result |
|---|---|
| `node --check` — all 8 relay `src/*.js` + `tools.js` | ✅ pass |
| `node --check` — all ext JS (background, popup, options, onboarding, relayClient, all `src/actions/*`) | ✅ pass |
| `manifest.json` parses; v0.4.0, `identity`=true, `key`=true, description 123 ch (≤132 limit) | ✅ pass |
| Migration chain `0001 → 0002 → 0004 → 0005` applied to throwaway sqlite3 | ✅ clean; 9 tables |
| chrome.identity redirect/token contract (ext ⇄ relay) | ✅ exact match |
| Open-redirect guard on `/ext/authorize` | ✅ regex + `EXTENSION_ID` pin; re-validated from signed state at POST |
| Per-origin consent actually gates writes in `mcp.js` | ✅ enforced (not just scaffolded) |
| Rate limits on claim / ext-authorize / magic-send / register | ✅ wired, fixed-window correct, fail-open |
| `MAGICLINK_SECRET` fail-closed in magic mode | ✅ required, ≠ COOKIE_SECRET, ≥24 ch |
| Manual code-paste fallback intact | ✅ `/pair/claim` + `claimPairingCode` unchanged |
| Local-broker coexistence | ✅ `persistRelayPairing` sets both enabled; `startLocal`+`startRelay` idempotent |

---

## UPDATE 2026-06-09 — Google identity wired into one-click `/ext/authorize`

_Code-on-disk only. `node --check src/auth.js` ✅. No deploy._

The owner is switching to **Google sign-in** for multi-person. Google mode was previously wired only for the claude.ai `/authorize` flow and the manual `/pair/new` code flow — the one-click extension sign-in (`/ext/authorize`) returned **501 Unsupported** in google mode. It is now wired.

### How the google one-click flow works end to end
Google sign-in completes **inside** the `chrome.identity.launchWebAuthFlow` window (the user signs into Google there and Google 302s back), so it is the **SINGLE-WINDOW** pattern like `shared` — **no** email round-trip, **no** `/ext/authorize/wait` polling page.

```
ext  → GET {relay}/ext/authorize?redirect_uri=<…chromiumapp.org/>&state=<≥16ch>&label=<browser>
relay→ validExtRedirect(redirect_uri)  [exact-match chromiumapp.org + EXTENSION_ID pin; else error page, never redirect]
relay→ state' = signState({intent:'ext_pair', redirectUri, state, label})   [HMAC COOKIE_SECRET — anti-CSRF + tamper-proof]
relay→ 302 googleAuthUrl(env, state')        [reuses existing googleAuthUrl → accounts.google.com]
user → signs into Google IN the same window
google→ 302 {relay}/authorize/callback?code=…&state=state'
relay→ verifyState(state')  [reject if unsigned/tampered]  → exchangeGoogleCode(code)  [SERVER-SIDE code exchange at Google's token endpoint; never accepts a client id_token]
relay→ userId = identity.sub  (unchanged derivation); upsertUser; setOperator if OPERATOR_EMAIL matches (parity w/ magic)
relay→ st.intent==='ext_pair' branch: validExtRedirect(st.redirectUri) AGAIN  → createDevice (SAME path as shared one-click / /pair/claim) → 302
       302 <redirect_uri>#devicetoken=<256bit>&userId=<google sub>&wssUrl=wss://host/ext&state=<echo>   [extSuccessRedirect — fragment, not query]
ext  → verify state === sent → store devicetoken/userId/wssUrl → connect
```

A **normal** claude.ai `/authorize` google flow has **no** ext redirect in its state (`intent:'oauth'`, carries `req`), so it falls through to the unchanged `completeOAuth` path. The `intent:'pair'` `/pair/new` flow is likewise unchanged → `mintAndShowCode`. The magic-mode `intent:'ext_pair'` arrives via `ml=` through `handleMagicCallback` (signed with `MAGICLINK_SECRET`), a **different** code path that never reaches the google `code=` branch — no collision.

### Files changed
- **src/auth.js** — two edits, all via existing helpers:
  1. `handleExtAuthorize` GET, `mode==='google'`: sign `{intent:'ext_pair', redirectUri, state, label}` into the OAuth `state` and 302 to `googleAuthUrl(env, state)`. (POST in google mode is never used — Google completes via the callback — so it stays 501.)
  2. `handleUpstreamCallback` (google `code=` branch): after `exchangeGoogleCode` → `userId=identity.sub`, added an `st.intent==='ext_pair'` branch that re-validates `validExtRedirect`, `createDevice`s, audit-logs `pair_authorize {via:'google'}`, and 302s via `extSuccessRedirect`. Also added `OPERATOR_EMAIL` operator designation (parity with the magic callback — google previously never set operator).
- Shared + magic `/ext/authorize` paths **untouched**; manual `/pair/new` + `/pair/claim` still work in google mode (verified by inspection: `/pair/new` google branch signs `{intent:'pair'}` → callback `mintAndShowCode`; `/pair/claim` is mode-agnostic).

### Security
- **No client id_token accepted** — `exchangeGoogleCode` does the server-side auth-code exchange at `https://oauth2.googleapis.com/token` with `UPSTREAM_OAUTH_CLIENT_SECRET`; the callback only ever receives a `code`.
- **state validated before trust** — `verifyState` (HMAC `COOKIE_SECRET`) rejects unsigned/tampered state → anti-CSRF.
- **Open-redirect guard** — `validExtRedirect` runs at GET (before signing) **and again** in the callback before redirecting; exact-match `^https://[a-p]{32}.chromiumapp.org/?$` pinned to `EXTENSION_ID`.

### Google Cloud Console setup the OWNER must do (one-time, before flipping to google)
1. **OAuth consent screen** (APIs & Services → OAuth consent screen): User type **External**; fill app name / support email / developer contact; **scopes** = non-sensitive `.../auth/userinfo.email` (+ `openid`) — matches the relay's `openid email` request. **Do NOT add `.../auth/userinfo.profile`**: only `sub`+`email` are consumed (see note below). While in **Testing**, add each signer as a **Test user** (or **Publish** the app to allow any Google account; basic email scope needs no Google verification review).
2. **Create OAuth client** (APIs & Services → Credentials → Create credentials → OAuth client ID): Application type **Web application**. **Authorized redirect URI** = exactly `https://relay.ytx.app/authorize/callback` (no trailing slash, no path variations). Authorized JavaScript origins not required.
3. Copy the **Client ID** → `UPSTREAM_OAUTH_CLIENT_ID` and **Client secret** → `UPSTREAM_OAUTH_CLIENT_SECRET`.

> Note: the relay requests scope `openid email` (see `googleAuthUrl`); add `profile` to the relay's scope string later only if you actually need profile fields. `userId` is the Google `sub` (stable per account), so it does NOT depend on email scope beyond identity display.

### Deploy steps to flip to google (run LATER, when claude.ai is free)
1. `wrangler secret put UPSTREAM_OAUTH_CLIENT_ID` — the Web OAuth client ID from step 3.
2. `wrangler secret put UPSTREAM_OAUTH_CLIENT_SECRET` — the client secret (secret, not a plaintext var).
3. `wrangler secret put OPERATOR_EMAIL` — your Google account email, to retain operator/eval rights.
4. Set `IDENTITY_MODE=google` (var in `wrangler.toml [vars]`, replacing `"shared"`, or `wrangler secret put IDENTITY_MODE`).
   - `COOKIE_SECRET` must already be set (it signs the OAuth round-trip `state`). `MAGICLINK_SECRET`/`MAIL_*` are NOT needed in google mode.
   - `EXTENSION_ID` should match the published extension (already committed in `wrangler.toml`) so the redirect guard pins correctly.
5. `wrangler deploy`
6. Verify: trigger one-click sign-in from the extension → Google account chooser appears **in** the auth window → after sign-in it bounces straight back to the extension and connects. Manual `/pair/new` code paste remains a fallback.

### Residual risks
- **Google app verification** — basic `email`/`profile`/`openid` scopes are non-sensitive and need no Google verification, but while the consent screen is in **Testing** only listed **Test users** can sign in (others get `access_denied`). Publish the consent screen for open multi-person sign-up.
- **`prompt: 'select_account'`** is set in `googleAuthUrl`, so Google always shows the account chooser (no silent SSO) — expected for multi-person but worth noting it isn't a "one tap if already signed in" flow.
- **`redirect_uri` exact-match at Google** — if `RELAY_BASE` is ever something other than `https://relay.ytx.app`, the Google client's Authorized redirect URI must be updated to match `{RELAY_BASE}/authorize/callback` or Google returns `redirect_uri_mismatch`.
- **R2-style orphan device on double-trigger** does not apply here (single-window; no pair_request binding) — each callback mints exactly one device on a successful Google sign-in.

---

## What changed (by file)

### Extension (`fast-ext/`)
- **manifest.json** — `+"identity"` permission; v0.3.0→**0.4.0**; webstore's `key` (pins ID `ockcjadbkdfgfllidpcoamcepahfmlpf`) + 123-char description.
- **src/relayClient.js** — NEW `authorizeViaWebAuthFlow(relayBase)` (one-click sign-in via `chrome.identity.launchWebAuthFlow`); shared `persistRelayPairing()` tail (manual + web-auth both use it); `onMessage` stores `fastlinkPendingConsent` on inbound `{type:'consent_required'}`.
- **background.js** — idempotent `startLocal()`/`startRelay()`; `onInstalled(reason:'install')` opens `onboarding.html`; `{type:'fastlink:relay-paired'}` brings the relay up **live with no reload** (returns `{needsReload}` only if a relay was already running).
- **src/actions/index.js** — every dispatch result envelope is stamped with top-level `origin` (from the same target tab the action ran against) → relay's consent/audit origin source.
- **options.html/js, popup.html/js** — one-click "Sign in & connect" + manual code behind a disclosure; popup per-origin consent UI (Allow/Read-only/Block → POST `/consent`) + "Claude is driving" mirror line.
- **NEW onboarding.html/js** — 4-step first-run: sign in → optional BYO Gemini key → add-to-claude.ai connector → "watch Claude work".
- **N2 kill-switch (src/actions/index.js, src/relayClient.js, background.js, popup.js)** — `dispatchAction` refuses ALL actions while `chrome.storage.session['fastlink.drivingPaused']` (covers both transports); `stopRelay()` hard-disconnect; popup Stop/Resume + Disconnect/Reconnect; pause broadcast to relay via `driving_paused`/`driving_resumed` events.

### Relay (`fastlink-relay/`)
- **src/auth.js** — NEW `/ext/authorize` (+ dark magic `/ext/authorize/wait`), `/settings/gemini-key`, `/consent`. Open-redirect chokepoint `validExtRedirect`. M2/M5 rate limiters (`ipRateLimit`, `magicSendLimit`, `registerRateLimit`, `clientIp`). M3 mode-aware `magicSecret` (fail-closed in magic mode).
- **src/index.js** — `registerRateLimit` on `POST /oauth/register` before the OAuthProvider.
- **src/userRelay.js** — consent plumbing: `lastOrigin` cached from result frames, `currentOrigin`, `consentFor`, `consentDefault`, `notifyExtension`; removed the static `relay.readonly`; audit now logs origin.
- **src/mcp.js** — `consentVerdict()` gate in `dispatchTool` + per-step in `runBatch`; `fast_status` reports consent. **N2 kill-switch:** `dispatchTool` short-circuits every tool while `isDrivingPaused()` (except observable meta).
- **src/userRelay.js (N2)** — consumes `driving_paused`/`driving_resumed` frames (bare, `event`-wrapped, or `{drivingPaused:bool}`); `isDrivingPaused()`/`setDrivingPaused()` persist to DO storage (survives hibernation, in-memory cache).
- **src/db.js** — `hitRateLimit`/`purgeRateLimits`, `listSiteConsent`, `createPairRequest`/`bindPairRequest`/`claimPairRequest`.
- **migrations/0004_rate_limits.sql** (hardening), **0005_pair_requests.sql** (relay-auth, Phase-2/DARK).

---

## Security re-audit of the NEW surface

**No blockers found.** The audit items the batch was meant to close are confirmed closed:

- **Open redirect (`/ext/authorize`)** — `EXT_REDIRECT_RE = ^https://[a-p]{32}\.chromiumapp\.org/?$`, optionally pinned to `EXTENSION_ID`. Validated at GET (renders an error page, never redirects) **and** re-validated at POST from the **signed** `req` state (so a tampered form can't swap the target). Cancel/success/error all route through it. ✅
- **Device-token entropy** — 256-bit (`randomToken` = 32 random bytes). ✅
- **Consent-bypass** — `consentVerdict` runs before every page-touching tool and per batch step; `fast_evaluate` is both consent-gated and allowlist-gated; `/consent` is **device-token-authed and NOT an MCP tool** (Claude can only surface `consent_required`; the human approves in the popup → prompt-injection-resistant). ✅
- **Rate-limit correctness** — fixed-window read-then-write; resets on rolled-over window; `allowed = count ≤ limit`; fail-open on DB error / missing IP. The `/ext/authorize/wait` cap is deliberately generous (self-polling). ✅
- **`MAGICLINK_SECRET`** — in magic mode: required, must differ from `COOKIE_SECRET`, ≥24 chars; else 500. ✅

### Residual notes (non-blocking; address in the deploy window)
- **R1 (low) — consent TOCTOU via `lastOrigin` cache.** `consentVerdict` checks the cached prior-call origin. Effectively closed: the result-frame stamp updates immediately, navigation tools (`fast_nav`/`fast_tab`) are themselves gated, and page content can't change the active tab. Monitor; no fix required for launch.
- **R2 (low, Phase-2/DARK) — orphan device on double-clicked magic link.** `completeExtPairMagic` doesn't check `bindPairRequest`'s return, so a second click of the same email link can mint a never-delivered `devices` row. Not a security hole (token never leaves the relay). Tidy before flipping `IDENTITY_MODE=magic`.
- **R3 (info)** — `/consent` and `/settings/gemini-key` are device-token-authed but not IP-rate-limited; the 256-bit token makes brute force infeasible.
- **R4 (info)** — migration numbering has no `0003` (gap between `0002` and `0004`). Harmless: `wrangler d1 migrations` tracks applied migrations by filename, not by contiguous index.

---

## EXACT deploy steps — run LATER, only when the human confirms claude.ai is free

> Two independent stages. **Stage A** (ship the integrated code in shared mode) is low-risk and changes no behavior. **Stage B** (turn on multi-user magic-link auto-pair) is the bigger flip and has prerequisites.

### Stage A — ship the code (still shared mode, no behavior change)
From `<repo>/fastlink-relay/` (wrangler on PATH, `CLOUDFLARE_API_TOKEN` set):
1. **Apply migration 0004 only** (rate-limit table — until applied, all limiters fail-open / no-op):
   `wrangler d1 migrations apply fastlink-relay --remote`
   _(0005 is Phase-2/DARK — do NOT apply it in Stage A.)_
2. **`EXTENSION_ID` is ALREADY committed** in `wrangler.toml [vars]` (= `ockcjadbkdfgfllidpcoamcepahfmlpf`, line 112) so the open-redirect guard pins to the published extension automatically on deploy — no secret to set. **Just confirm** it matches the ID you actually publish (Stage C); if the key is swapped, update this var first.
3. **(optional) `CONSENT_DEFAULT`** — leave unset in shared mode (defaults to `allow`). `IDENTITY_MODE` is committed as `"shared"` (line 98) — Stage B flips it.
4. **Deploy:** `wrangler deploy`
5. **Smoke-test (live):** the S2 CORS preflight is only verifiable at runtime —
   `curl -i -X OPTIONS https://relay.ytx.app/mcp -H 'Origin: https://claude.ai' -H 'Access-Control-Request-Method: POST'` → expect **204** + `Access-Control-Allow-Origin: https://claude.ai`. Confirm claude.ai's existing connector still works.
6. **Reload the extension** (chrome://extensions) — or publish v0.4.0 (Stage C) — so `identity` + the one-click flow are live. Manual code paste keeps working regardless.

### Stage B — enable multi-user magic-link auto-pair
1. **Resend account + DNS** ready (see prereqs below).
2. **Apply migration 0005** (pair_requests, for magic one-click bridge):
   `wrangler d1 migrations apply fastlink-relay --remote`
3. **Set secrets:**
   - `wrangler secret put MAGICLINK_SECRET` — dedicated, ≥24 chars, **different from `COOKIE_SECRET`** (magic mode 500s otherwise — intentional, audit M3).
   - `wrangler secret put MAIL_API_KEY` — Resend API key.
   - `wrangler secret put MAIL_FROM` — e.g. `login@ytx.app` (must match a Resend-verified domain).
   - `wrangler secret put OPERATOR_EMAIL` — your email, to retain operator (eval-test) rights.
4. **Flip identity mode:** set `IDENTITY_MODE=magic` (var in `wrangler.toml` or `wrangler secret put`). `CONSENT_DEFAULT` auto-becomes `prompt` (first-touch approval) in magic mode — override only if intended.
5. **Deploy:** `wrangler deploy`
6. **Verify:** request a magic link to your own email, complete sign-in, confirm `/ext/authorize` one-click and per-origin consent prompts behave. (Cross-device caveat: complete the email click on the **same device** that started sign-in.)
7. **(recommended)** Wire a cron trigger to call `purgeRateLimits` + expired `magic_links`/`pairing_codes` cleanup (audit T6).

### Stage C — Chrome Web Store (independent of A/B)
- Build: `cd fast-ext && scripts/package.sh` → `dist/fastlink-0.4.0.zip`.
- Host `fast-ext/store/PRIVACY-POLICY.md` at a public URL (required field).
- Submit per `fast-ext/store/STORE-LISTING.md`. Private signing key stays at `<repo>/fastlink-extension-signing-key.pem` (gitignored, never packaged).

---

## Human account prerequisites (before Stage B / C)

1. **Resend (email)** — create account, **verify the sending domain** (`ytx.app` or chosen `MAIL_FROM` domain) by adding the SPF/DKIM DNS records Resend provides; generate an API key for `MAIL_API_KEY`.
2. **Chrome Web Store** — a paid CWS **developer account** ($5 one-time). Decide CWS-listed vs. self-hosted given the `debugger` + `<all_urls>` review risk (flagged in `fast-ext/store/PERMISSIONS-JUSTIFICATION.md`).
3. **Privacy policy hosting** — a public URL serving `PRIVACY-POLICY.md` (CWS requires it; also referenced by the onboarding page).
4. **Extension key decision** — ratify or replace the key webstore pinned (ID `ockcjadbkdfgfllidpcoamcepahfmlpf`); whatever ID ships must equal the `EXTENSION_ID` relay secret (Stage A step 2) or the redirect-URI guard rejects sign-in.

---

## Snapshot of contract reconciliation (for the record)

```
ext  →  GET {relayBase}/ext/authorize?redirect_uri=<getRedirectURL()>&state=<16B b64url>&label=<browser>
relay →  302  <redirect_uri>#devicetoken=<256bit>&userId=<sha256(email)|shared-user>&wssUrl=wss://host/ext&state=<echo>
ext  →  verify state === sent → read devicetoken/userId/wssUrl → persistRelayPairing → live (no reload)
cancel/err → 302 <redirect_uri>#error=access_denied&state=<echo>
guard → redirect_uri must match ^https://[a-p]{32}.chromiumapp.org/?$  (+ pinned to EXTENSION_ID)
```
Param names, fragment-not-query, lowercase `devicetoken`, and state-before-token all match between `fast-ext/src/relayClient.js` and `fastlink-relay/src/auth.js`. Manual `/pair/claim` path is byte-for-byte unchanged.
