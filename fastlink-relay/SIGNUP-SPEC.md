# FastLink — Seamless Signup & Auto-Pair Spec

_Owner: architect. Status: contract (no code yet, NOTHING deployed). Builders: **ext-auth**, **relay-auth**, **hardening**, **webstore**. This doc is the source of truth; where it conflicts with SPEC.md, this wins for the signup/pairing surface._

## 0. Goal

A brand-new user goes: **install → sign in (email magic-link) → browser auto-pairs (NO copying codes) → add the claude.ai connector → driving.** The pairing-code copy/paste flow (`/pair/new` + `/pair/claim` + the options-page code box) is **replaced** for new users by an in-extension `chrome.identity.launchWebAuthFlow` round-trip that ends with the relay handing the extension a device token directly. The old code path stays as a manual fallback.

Two identity modes share ONE pairing mechanism:
- **shared** (live today, `IDENTITY_MODE` unset/`shared`): single operator proves `OWNER_SECRET`.
- **magic** (`IDENTITY_MODE=magic`): any user signs in by email magic-link.

Non-goals here: changing the claude.ai↔relay OAuth flow (unchanged), changing the `/ext` WSS transport (unchanged), changing device-token format or revoke (unchanged — we REUSE `db.createDevice` / `lookupDevice` / `revokeDeviceAndClose`).

---

## 0.1 PHASING (authoritative — set by team-lead)

**Everything is BUILT this sprint; the deploy is one later batch.** The relay is LIVE and the user is on it via claude.ai right now, so **NOTHING deploys this sprint.** Code all of it now (node --check clean), gate/dark the Phase-2 parts behind `IDENTITY_MODE`/env so a single future deploy turns them on.

- **PHASE 1 — code now, ships in the later deploy window, SHARED mode, single operator:**
  - relay-auth: `/ext/authorize` over the **EXISTING `devices` table** (GET = `OWNER_SECRET` form, POST = mint deviceToken via `createDevice`, 302 to `<extid>.chromiumapp.org/#devicetoken=…`). **No `pair_requests` table needed in Phase 1** (shared resolves in one window — §1.5).
  - ext-auth: `launchWebAuthFlow` + `"identity"` permission + stable manifest `"key"`; the full onboarding UI (sign-in button, connected state, BYO-Gemini-key step, connector-URL copy, side-by-side guidance).
  - webstore: stable ID/key, packaging, policy, justifications (can finalize listing later, but pin the key now).
  - **Not in Phase 1:** magic mode, the polling wait-page, `pair_requests`, rate-limits, per-origin consent enforcement — all dark.

- **PHASE 2 — DEPLOY-GATED (bundled into the one later deploy, after the human frees claude.ai + does Resend/DNS):**
  - relay-auth: magic-mode auto-pair — the `pair_requests` table + `/ext/authorize/wait` polling page + `intent:'ext_pair'` (§1.5, §1.6); `IDENTITY_MODE=magic`, `MAIL_API_KEY`/`MAGICLINK_SECRET`.
  - hardening: migration for rate-limit tables + per-origin consent enforcement (M2–M5), `/consent` endpoint gate.
  - webstore: actual Chrome Web Store publish.
  - Code it all NOW as marked scaffolding; it just doesn't deploy this sprint.

Each builder: your §3 row is tagged **[P1]** / **[P2]**. Build both; keep P2 inert behind its gate.

---

## 1. The auto-pair handshake (`chrome.identity.launchWebAuthFlow`)

### 1.1 Why launchWebAuthFlow
`chrome.identity.launchWebAuthFlow({url, interactive})` opens a browser-controlled window, drives the user through an arbitrary web auth UI on **our relay**, and resolves to the **final redirect URL** the moment that window navigates to `https://<extension-id>.chromiumapp.org/*`. Chrome intercepts that navigation *before* it hits the network and extracts the URL for us. The extension parses the device token out of it. No code is ever shown to or typed by the user.

- Manifest: add `"identity"` to `permissions`.
- The redirect URI is **fixed** and derived from the extension ID: `chrome.identity.getRedirectURL()` → `https://<extension-id>.chromiumapp.org/`. We pass it to the relay as `redirect_uri`; the relay 302s back to it.
- **Hard dependency (webstore) — DONE:** the extension ID is now PINNED via a manifest `"key"`. **ID = `ockcjadbkdfgfllidpcoamcepahfmlpf`**, so the redirect URI is `https://ockcjadbkdfgfllidpcoamcepahfmlpf.chromiumapp.org/`. (Private PEM kept outside `fast-ext/`, gitignored. Docs: `fast-ext/store/EXTENSION-ID.md`. Subject to human ratification — open question #1.)

### 1.2 Endpoints (relay-auth adds these to `auth.js`'s path switch)

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/ext/authorize` | Render the human-auth UI (secret form in shared; email form in magic). Params below. |
| `POST` | `/ext/authorize` | Complete auth. Shared: verify secret → mint token → 302. Magic: email the link, then show a self-polling "waiting" page. |
| `GET`  | `/ext/authorize/wait` | Magic only. The waiting page held INSIDE the launchWebAuthFlow window; meta-refreshes every ~2s; 302s to `redirect_uri` once the email link has been clicked and a token bound. |

`handleMagicCallback` (existing) gains a new `intent: 'ext_pair'` branch (§1.5).

**`GET /ext/authorize` params:**
- `redirect_uri` (required) — **MUST exact-match our pinned extension**, not any chromiumapp.org subdomain. Default to `https://${EXTENSION_ID}.chromiumapp.org/` with `EXTENSION_ID=ockcjadbkdfgfllidpcoamcepahfmlpf` (env, already referenced for the deep link); fall back to the regex `^https:\/\/[a-p]{32}\.chromiumapp\.org\/?$` ONLY if `EXTENSION_ID` is unset. **Security rationale:** the generic regex would let a *rogue* extension run its own `launchWebAuthFlow` against `/ext/authorize` and capture a device token if the user authenticates (types `OWNER_SECRET` / clicks the magic link) in that window. Pinning the exact ID closes that. Reject mismatches with 400.
- `state` (required) — opaque ≥16-char token the extension generated; echoed back verbatim in the redirect. CSRF / response-fixation guard.
- `label` (optional) — device label for the devices list (default `deviceLabel()` server-side).

### 1.3 The redirect / token contract (THE cross-boundary interface)

On successful human auth, the relay mints a device token (`randomToken()` → `db.createDevice(userId, token, label)` → `db.logAudit(userId, 'pair_authorize', …)`) and 302s the launchWebAuthFlow window to:

```
https://<extension-id>.chromiumapp.org/#devicetoken=<token>&userId=<userId>&wssUrl=<wss>&state=<state>
```

- Token data rides the **URL fragment** (`#…`), not the query. Chrome still delivers the full URL (fragment included) to `launchWebAuthFlow`'s callback, but the fragment is NOT written into the relay's 302 `Location` access logs the way a query string is → satisfies audit **T5** (token-in-logs hygiene). `?devicetoken=` is acceptable but fragment is the spec'd default.
- `wssUrl` = `wssBase(env) + '/ext'` — same value `/pair/claim` returns today.
- `userId` is informational (the extension shows it; isolation is enforced server-side by the device-token→DO lookup, never by this value).

**Token format is UNCHANGED:** 32 random bytes, base64url, identical to `/pair/claim`. So `/ext` upgrade, `lookupDevice`, `touchDevice`, and `revokeDeviceAndClose` all work on these tokens with zero changes.

### 1.4 Extension side (ext-auth)
```
const redirectUri = chrome.identity.getRedirectURL();          // https://<id>.chromiumapp.org/
const state = base64url(crypto.getRandomValues(16 bytes));
const url = `${relayBase}/ext/authorize`
          + `?redirect_uri=${enc(redirectUri)}&state=${enc(state)}&label=${enc(deviceLabel())}`;
const ret = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
const p = new URLSearchParams(new URL(ret).hash.slice(1));     // parse the fragment
if (p.get('state') !== state) throw new Error('state mismatch');   // CSRF guard
const deviceToken = p.get('devicetoken');                       // REQUIRED
// store + flip flags + reload (reuse the tail of claimPairingCode):
await chrome.storage.local.set({
  fastlinkMode:'relay', deviceToken, relayBase,
  relayWssUrl: p.get('wssUrl') || `${relayBase.replace(/^http/,'ws')}/ext`,
  relayUserId: p.get('userId') || null, relayAuthError:null,
  localEnabled:true, relayEnabled:true,
});
chrome.runtime.reload();
```
`launchWebAuthFlow` runs fine from the MV3 service worker, but call it from a **user-gesture context** (the options/onboarding page button) so `interactive:true` is allowed to open the window. Wrap rejections (`"The user did not approve…"`, window closed) into a friendly retry.

### 1.5 Shared vs. magic completion (the one tricky bit)

- **Shared mode — single window, resolves directly.** `GET /ext/authorize` renders the `OWNER_SECRET` form (reuse `authorizeShared`'s markup, POST to `/ext/authorize` with hidden `redirect_uri`+`state`). On correct secret → mint token → 302 to chromiumapp.org. The whole flow is inside the launchWebAuthFlow window, so it resolves immediately. **This is the live path; ship it first.**

- **Magic mode — the email click cannot return to the launchWebAuthFlow window** (the user clicks the link in their mail app / another tab / another device, which is NOT the auth window). So we **bridge with a self-polling waiting page**:
  1. `POST /ext/authorize` (email submitted): create a `pair_request` row keyed by a random `pollId` (carry `redirect_uri`, `state`, `expiresAt`). `startMagicLogin(env, email, { intent:'ext_pair', pollId, redirect_uri, state })`. Respond by **302→`/ext/authorize/wait?pt=<pollId>`** (stays in the auth window).
  2. `/ext/authorize/wait` renders "Check your email — waiting…" with `<meta http-equiv="refresh" content="2">` (or a JS poll). Each hit checks the `pair_request`: if a device token has been bound, **302 to `redirect_uri#devicetoken=…&state=…`** — and because this 302 happens INSIDE the launchWebAuthFlow window, the flow resolves. Else re-render the waiting page. Expire after `MAGIC_TTL_SEC`.
  3. The email link is the existing `/authorize/callback?ml=…`. `handleMagicCallback` sees `intent:'ext_pair'`: resolve `userId` from email, mint the device token, **bind it to the `pollId`** (`db.bindPairRequest(pollId, userId, deviceToken)`), and render a plain "✓ Signed in — return to the extension window" page (this page is in the email-click tab; it does NOT redirect anywhere).

This keeps **one mechanism** (`launchWebAuthFlow`) for both modes and works same-device OR cross-device, unlike the claude.ai OAuth magic flow (which is pinned to PKCE in the original browser).

### 1.6 New DB helpers (relay-auth, in `db.js` + a migration)
- `createPairRequest(db, pollId, {redirectUri, state}, ttlSec)`
- `bindPairRequest(db, pollId, userId, deviceToken)` — set bound fields; idempotent-safe.
- `claimPairRequest(db, pollId)` → `{ status:'pending' } | { status:'ready', redirectUri, state, deviceToken, userId } | null(expired/unknown)`. (Reads, does not delete; the `/wait` 302 is the terminal step. Add to the T6 purge.)

New table `pair_requests(poll_id PK, redirect_uri, state, user_id, device_token, created_at, expires_at, bound_at)`. Mirror the `magic_links`/`pairing_codes` atomic-update style.

---

## 2. End-to-end new-user narrative

1. **Install** the extension from the Chrome Web Store. Toolbar icon = red (no transport paired).
2. Onboarding page opens (first-run; ext-auth) with one primary button: **“Sign in & connect.”**
3. Click → `launchWebAuthFlow` opens the relay's `/ext/authorize`.
   - **magic:** type email → "check your email" → click the link (any device) → the waiting window flips to ✓ and closes.
   - **shared:** type the relay secret → submit → window closes.
4. Extension stores the device token, reloads, dials `/ext` over WSS. Icon → green. Onboarding page shows **“✓ Browser connected.”**
5. Onboarding page step 2 (**optional, BYO vision key**): **“Enable vision (optional) — paste your Gemini API key.”** Without it, the scout/vision/prewarm tier returns `{disabled:true}` and FastLink runs **DOM-only** (fully functional — make this explicit: *"Works without it. Add a key only for the vision/scout speed tier."*). BYO-key is already built (per-user AES-encrypted key, `db.setUserGeminiKey`); the onboarding posts to a device-token-authed relay endpoint (`POST /settings/gemini-key`, relay-auth, Phase 1) so the user never leaves the browser. See §5.3.
6. Onboarding page step 3: **“Add FastLink to claude.ai”** — a copy-able relay URL (`https://relay.ytx.app/mcp`) + a "How to add a custom connector" link. (This is the claude.ai OAuth side — unchanged; it 302s through the SAME identity, so in magic mode the user signs in with the same email and lands on the same DO.)
7. Onboarding page step 4 (**workflow teaching, §5.4**): **“Watch Claude work.”** Tell the user to keep claude.ai in one window and put the target tab in a **second window side-by-side** — the target-tab PIN holds the tab even when unfocused, so Claude drives the background tab without stealing focus and the user stays in the chat. The activity overlay annotates each action on the target; a "Claude is driving this tab" indicator shows on the target (and, if feasible, a mirror indicator on the chat side).
8. User opens claude.ai, adds the connector, authorizes (magic-link again, same email → same `userId` → same DO the browser is already on). Done — Claude can now drive the tab.
9. First action on a new site (Phase 2 / consent enforced): a one-time **consent prompt** (§7). Then driving.

---

## 3. File-ownership split (4 builders)

### ext-auth — `fast-ext/` sign-in + onboarding UI
- **[P1]** `manifest.json`: add `"identity"` permission; add the stable `"key"` (§6); bump version.
- **[P1]** `src/relayClient.js`: add `authorizeViaWebAuthFlow(relayBase)` next to `claimPairingCode` (share the storage-write tail). Keep `claimPairingCode` as the manual fallback.
- **[P1]** `options.js` / new `onboarding.html`+`onboarding.js`: the 4-step onboarding from §2 — (1) primary **“Sign in & connect”** button (new flow), connected state; (2) optional **“Enable vision: paste your Gemini key”** with the clear *works-without-it DOM-only* note → `POST /settings/gemini-key`; (3) **“Add to claude.ai”** connector-URL copy panel; (4) **“Watch Claude work”** side-by-side guidance (§5.4). Keep the manual code box behind a “have a pairing code?” disclosure.
- **[P1]** First-run: open onboarding on `chrome.runtime.onInstalled` (reason `install`).
- **[P1]** Driving indicator: surface a "Claude is driving this tab" state (overlay exists) + popup line (§5.4); coordinate the kill-switch with hardening.
- **[P2]** Consent UI: popup surface to approve a pending origin (§4.2), posting to `POST /consent`.
- **[P2]** Emit active-tab `origin` on action results (§5.2) — closes T3/T4; shared with hardening.

### relay-auth — `auth.js` / `db.js` redirect + token issuance
- **[P1]** `auth.js`: add `/ext/authorize` (GET+POST) over the EXISTING `devices` table — shared path only (OWNER_SECRET form → `createDevice` → 302 with token in fragment); strict `redirect_uri` allowlist regex; reuse `randomToken`/`db.createDevice`/`logAudit`.
- **[P1]** `POST /settings/gemini-key` (device-token-authed) → `db.setUserGeminiKey` (§5.3).
- **[P2]** `auth.js`: add `/ext/authorize/wait`; extend `handleMagicCallback` with `intent:'ext_pair'`; reuse `signMagic`/`startMagicLogin`.
- **[P2]** `db.js` + migration: `pair_requests` table + the three helpers (§1.6).
- **[P1 endpoint / P2 enforced]** `/consent` endpoint (device-token-authenticated) → `db.setSiteConsent` (§4.2). You own the endpoint; hardening owns the gate.

### hardening — M2–M5 + per-origin consent enforcement (**all [P2]**, dark until the deploy)
- **M2:** rate-limit magic-link sends (`/authorize`, `/pair/new`, `/ext/authorize` POST) by email+IP. **Add `/oauth/register`** (open DCR) to the same limiter.
- **M3:** require a strong dedicated `MAGICLINK_SECRET` before magic can be enabled (extend the `requireSecret` fail-closed; treat fallback-to-`COOKIE_SECRET` as a deploy error in magic mode).
- **M4 (the big one):** wire `db.getSiteConsent` → block/readonly/allow in `mcp.js dispatchTool` + `runBatch`; emit `consent_required` on first touch; **undecided origin defaults READ-ONLY** (§4.2). Flip `relay.readonly` per-origin instead of the hardcoded `false`. Needs origin plumbing (§5.2). `site_consent` table already exists (db.js) — your migration is mainly the rate-limit table; coordinate its number with relay-auth (relay-auth's `pair_requests` migration is also P2).
- **M5:** rate-limit `/pair/claim` AND `/ext/authorize`/`/ext/authorize/wait` by IP.
- Also lands the SAFETY/N2 runtime guardrails (read-only default, Stop/Disconnect, “who’s driving” indicator) — coordinate with ext-auth on the popup/§5.4 indicator.

### webstore — packaging, policy, listing
- **[P1]** Stable `"key"`/ID (critical path — pin NOW, tell ext-auth + relay-auth); permission justifications (esp. `<all_urls>` + `debugger` + `webRequest` + `identity`); zip/build step; draft privacy policy + data-handling form.
- **[P2]** Actual Chrome Web Store publish; final listing/screenshots. See §6.

---

## 4. Cross-boundary interfaces (normative)

### 4.1 Redirect/token contract (ext-auth ↔ relay-auth)
- **ext→relay:** `GET {relayBase}/ext/authorize?redirect_uri=<https://[a-p]{32}.chromiumapp.org/>&state=<≥16ch>&label=<str>`.
- **relay→ext (success):** `302 Location: <redirect_uri>#devicetoken=<b64url-32B>&userId=<str>&wssUrl=<wss://…/ext>&state=<echo>`.
- **relay→ext (failure):** the launchWebAuthFlow window stays on a relay error page (never redirects to chromiumapp.org); the extension surfaces a timeout/cancel. Optionally `…#error=<code>&state=<echo>` to redirect with a machine-readable error.
- **Invariants:** `state` echoed exactly; `redirect_uri` rejected unless it matches the regex; token is single-mint per successful auth; token === `/pair/claim`’s format.

### 4.2 Consent contract (hardening ↔ relay-auth ↔ ext-auth)
- **MCP first-touch result** (mcp.js → Claude), a normal `textResult` (so Claude relays it to the human):
  ```json
  { "consentRequired": true, "origin": "https://bank.example",
    "modesOffered": ["allow","readonly"],
    "message": "FastLink needs your approval to act on https://bank.example. Approve it in the extension popup (Allow / Read-only)." }
  ```
  The tool is NOT executed on this turn.
- **Grant path (primary, in-browser):** extension popup shows the pending origin with **Allow / Read-only / Block** → `POST {relayBase}/consent` `{ deviceToken, origin, mode }`. Relay resolves `userId = lookupDevice(deviceToken).userId`, calls `db.setSiteConsent(userId, origin, mode)`, audits it. (Device-token auth — the extension already holds it; no extra OAuth.)
- **Grant path (fallback):** a relay settings page lists origins and writes the same rows.
- **Enforcement (mcp.js):** before any tool, resolve the active `origin` (§5.2), then:
  - `block` → refuse (all tools).
  - `readonly` → refuse `MUTATING_TOOLS` with the existing `readonlyBlocked` shape; reads pass.
  - `allow` → proceed (read + write).
  - `null` (undecided) → **DEFAULT IS READ-ONLY** (confirmed by team-lead). Reads pass; a mutating tool returns `{consent_required:true, origin}` so Claude tells the human to approve in the extension popup. The single trusted operator MAY opt out for convenience by setting `CONSENT_DEFAULT=allow` (Phase 1 shared only); the spec default everywhere else is consent-required/read-only.

**Grant path is HUMAN-ONLY (prompt-injection containment):** consent is granted via the device-token-authed `POST /consent` from the **extension popup** — it is NOT an MCP tool Claude can call. Claude can only *surface* the `consent_required` result; the human clicks Approve. `GET /consent` lists origins; `POST /consent {deviceToken, origin, mode}` grants/revokes. Modes: `allow` = read+write, `readonly` = reads only (writes = the existing `MUTATING_TOOLS` set blocked), `block` = everything blocked. Origin source for v1 = `relay.activeOrigin()` (cheap `fast_list`, no CDP); the known T3 active-tab TOCTOU is accepted for v1 and closed in Phase 2 by the extension stamping `origin` onto every result.

---

## 5. How the pieces plug in

### 5.1 Magic-link mode (`IDENTITY_MODE=magic`)
Already built behind the gate; this spec only ADDS the `intent:'ext_pair'` branch and the `/ext/authorize` + `/wait` bridge. Switching `IDENTITY_MODE=magic` (no rebuild) turns on email sign-in for BOTH the claude.ai OAuth side (existing `authorizeMagic`) and the extension pairing side (new). Same `resolveUserId(email)=sha256(email)` → the browser and the claude.ai connector converge on one DO. **Gate:** magic must not flip on until hardening's M2/M3/M5 land (rate-limits + strong `MAGICLINK_SECRET`).

### 5.2 Per-origin consent (currently inert) — making it real
Today `relay.readonly` is hardcoded `false` and nothing reads `site_consent`. To enforce:
1. **Origin plumbing.** The extension stamps the active-tab origin onto every action result (an `origin` field on the result envelope) — authoritative, free, and it also fixes the eval TOCTOU (audit T3) and the empty audit origin (T4). `userRelay` caches it as `this.lastOrigin`; `mcp.js`/`checkEvalAllowed`/`audit` consult it. (Cheaper than today’s extra `fast_list` round-trip per check.)
2. **Gate in `dispatchTool`** (and `runBatch`) per §4.2 enforcement.
3. **`CONSENT_DEFAULT` env** decides the `null` (undecided) case: `allow` (shared/operator v1 — current behavior) vs `prompt` (multi-user/magic — return `consent_required`) vs `readonly`. Bind the default to identity mode: **shared ⇒ `allow`, magic ⇒ `prompt`.**
4. **Revisit-free:** once a row exists, no prompt. Block/readonly editable from the popup or settings page.

### 5.3 BYO Gemini key + prewarm/vision for extension-only users
- The relay already ports `fast_prewarm` + the scout/vision speed tier (mcp.js/composite.js), but **cloud prewarm is "on-demand," not background** — Workers can't hold a warm process between calls, so `fast_prewarm` is informational and the scout actually warms on the first real `fast_scout`/`fast_point`. **Optional enhancement (Phase 2, propose-only):** the DO already receives a `'navigated'` event from the extension; firing a background scout read on that event would approximate true prewarm (pre-build the page map before Claude asks). Costs a Gemini call per navigation — gate it behind a per-user toggle.
- **All of scout/vision/prewarm return `{disabled:true}` without a Gemini key.** So onboarding has an **optional BYO-key step** (§2 step 2): `POST /settings/gemini-key {deviceToken, key}` (relay-auth, Phase 1; device-token-authed) → `db.setUserGeminiKey(userId, key, KEY_ENC_SECRET)` (already built, AES-GCM at rest). The per-user key wins over the operator `GEMINI_API_KEY` via the existing `resolveGeminiKey()`. UI copy must make clear FastLink is **fully usable DOM-only without a key**.
- **Cost decision (open question, §7):** operator-funded vision (shared `GEMINI_API_KEY`, simplest UX, operator pays per user) vs BYO-only (each user supplies a key, zero operator cost) vs hybrid (operator key as a capped trial, BYO to remove the cap).

### 5.4 "Watch Claude drive another tab" — first-run workflow guidance
The target-tab **PIN** lets Claude drive a specific tab even when it's unfocused, so the user can stay on the claude.ai chat while the action happens elsewhere. Onboarding teaches this (§2 step 4): claude.ai in one window, the **target tab in a second window side-by-side**; the pin holds the target unfocused; the **activity overlay** annotates each action. Add a **"Claude is driving this tab" indicator** on the target (overlay already exists) and, if feasible, surface a mirror indicator/popup line on the chat side so the user always knows what's being driven. This also doubles as the SAFETY "who is driving" requirement (N2) — coordinate with hardening's kill-switch/indicator work.

---

## 6. Web Store requirements (webstore)

- **Stable extension ID** — add `"key"` to `manifest.json` (the base64 public key matching the CWS upload key) so dev and published builds share one ID. Everything downstream (chromiumapp.org subdomain, the relay `redirect_uri` allowlist, the optional `EXTENSION_ID` deep link) depends on this. **Decide the ID before relay-auth ships the allowlist regex if we want to also pin to our specific ID.**
- **Permissions to justify (high scrutiny):** `<all_urls>` host permission, `debugger`, `webRequest`, `scripting`, plus the new `identity`. `debugger`+`<all_urls>` is the riskiest combo and commonly triggers manual review / delays — prepare a crisp single-purpose justification ("user-directed browser automation of the user's own active tab on behalf of their AI assistant").
- **No remote code:** MV3 forbids remotely-hosted code. `fast_evaluate` runs JS the user/Claude supplies into the user's own page via the debugger — that is user content, not extension code, but call it out in the review notes; keep it OFF by default (it already is).
- **Privacy policy (required):** disclose that page content/DOM/screenshots are sent to the user's relay and (if enabled) to Gemini; that email (magic mode) and a device token are stored; the device token is a bearer credential; no sale of data. Host the policy at a stable URL.
- **Data-handling form:** declare "Authentication information" (email, device token) and "Website content" (DOM/screenshots) as collected/transmitted; mark not-sold, used only to operate the feature.
- **Listing:** single-purpose description, screenshots of the onboarding + a drive demo, support email, the relay homepage.
- **Packaging:** a `zip` of `fast-ext/` at the bumped version, icons present (they are), no stray dev files. Add a `build`/`package` script.

---

## 7. Key decisions & open questions (for the human)

**Decisions baked in (override if you disagree):**
- Auto-pair uses `launchWebAuthFlow`; token returns in the **URL fragment** (`#devicetoken=…`) for log hygiene.
- Magic mode completes via a **self-polling waiting page** held in the launchWebAuthFlow window (email click elsewhere just flips a server flag) — one mechanism for both modes, works cross-device.
- Device token format/issuance/revoke are **reused unchanged** from `/pair/claim` (so `/ext`, revoke, multi-device all keep working).
- Manual code flow (`/pair/new` + `/pair/claim` + options code box) is **kept as a fallback**, not deleted.
- Consent default is **bound to identity mode**: shared⇒`allow`, magic⇒`prompt` (first-touch approval).
- Consent is granted **in the extension popup** (device-token-auth `POST /consent`), not by leaving the browser.

- **Phasing:** P1 = shared one-click sign-in over the existing `devices` table (code now, ships in the later deploy). P2 = magic auto-pair + consent + rate-limits + CWS publish (coded now, dark, lands in the same one deploy). §0.1.
- **Consent default = READ-ONLY** for undecided origins; human grants via the extension popup (`POST /consent`), never via an MCP tool.
- **Vision is optional/BYO:** FastLink is fully usable DOM-only; a Gemini key only lights the scout/vision tier.

**Open / needs a human call:**
1. **Stable extension ID** — generate now and pin via `"key"`? (Blocks the relay redirect allowlist + CWS.) Recommend: yes, generate before relay-auth hard-codes anything.
7. **Vision cost model** — operator-funded (shared `GEMINI_API_KEY`, operator pays per user) vs BYO-only (each user supplies a key) vs hybrid (operator key as a capped trial → BYO removes the cap)? Affects the onboarding step 2 copy + whether the `'navigated'` background-prewarm enhancement is worth wiring (§5.3).
8. **Background prewarm** — wire the DO `'navigated'` → background scout read to approximate true prewarm (Phase 2), or leave prewarm on-demand only?
2. **Web Store vs. self-host** — `debugger`+`<all_urls>` may draw a long manual review or rejection. Acceptable, or do we ship "Load unpacked"/enterprise/`.crx` self-distribution for now and CWS later?
3. **Consent granularity** — per-origin only (spec'd), or also a sensitive-origin denylist (banking/email auto-readonly) per SAFETY?
4. **Magic in production** — confirm Resend/`MAIL_FROM` (`login@ytx.app`) domain is verified and `MAGICLINK_SECRET` is set before flipping `IDENTITY_MODE=magic`.
5. **`/consent` ownership** — relay-auth or hardening? (Spec leans relay-auth for the endpoint, hardening for the gate.)
6. **launchWebAuthFlow gesture** — confirm we trigger it from the onboarding page button (user gesture) rather than auto on install, so `interactive:true` reliably opens.
```
```

---

_End of contract. Builders: read your §3 row + the §4 interface that touches you. Ping architect on any seam ambiguity before writing code. NO DEPLOYS._
