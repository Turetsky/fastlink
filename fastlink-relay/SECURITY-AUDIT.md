# FastLink Relay — Security Audit

_Auditor: `oauth` (task #8). Date: 2026-06-08. Scope: the whole `fastlink-relay/` surface (auth.js, db.js, index.js, userRelay.js, mcp.js, scout.js, composite.js, migrations, wrangler.toml) + the extension's `fast-ext/src/relayClient.js`. Method: manual review + `node --check`; **nothing deployed/run live**, so runtime-only issues (library behavior, claude.ai handshake) are called out as assumptions._

## How to read this

Findings are tiered by **when they must be fixed**, because v1 ships in two stages:

- **🔴 BLOCKER-for-shared-deploy** — unsafe even for the single trusted operator (v1 `IDENTITY_MODE=shared`).
- **🟠 BLOCKER-for-multi-user** — must fix before `IDENTITY_MODE=magiclink` opens the relay to strangers.
- **🟡 NICE-TO-HAVE** — hardening; not gating.

**Bottom line:** the shared-mode deploy is in good shape — the two shared blockers (S1 secret hard-default, S2 `/mcp` CORS preflight) are **fixed**; remaining operator steps are setting `COOKIE_SECRET` + a live preflight smoke-test. Tenant isolation, SQL safety, token entropy, and pairing atomicity are all sound. The multi-user surface still has real gaps that must close before letting strangers in: **M1 (PKCE-plain) and M6 (BYO-key bug) are now fixed by relay-core**; **M2–M5 remain** (consent is inert, no rate-limiting on magic-link sends or `/pair/claim`, magic secret must be strong).

---

---

## Re-audit — Pass 2 (full sweep, 2026-06-08)

Second full pass over the **current** tree (post #10 wiring, post S1/S2/M1/M6 fixes), now including files pass 1 only skimmed (`composite.js`, full `scout.js`, `package.json`, `DEPLOY.md`, `SAFETY.md`, and the extension `options.js`/`relayClient.js`).

**Confirmations (re-verified in current code):**
- **S1 ✅** secrets fail closed (`requireSecret`, auth.js). **S2 ✅** `/mcp` OPTIONS answered before the provider (index.js). **M1 ✅** `allowPlainPKCE:false` (index.js). **M6 ✅** `getUserGeminiKey(DB,userId,env.KEY_ENC_SECRET)` (userRelay.js:230). BYO key is AES-256-GCM, random IV, fails safe to operator key.
- Tenant isolation, SQL parameterization, 256-bit tokens, atomic single-use pairing/magic-link — all still sound.
- **Good touches found:** `fast_do` has a submit-word guard (won't auto-click pay/submit/delete unless the intent authorizes it); `getEvalPolicy` forces `allowAll=false` for non-operators by construction; scout's Gemini URL uses an operator-env model name (not user input → no SSRF); audit logs arg KEYS only.

**New findings (not in pass 1):**

### N1. `innerHTML` XSS sink in the extension options page — ✅ FIXED `(fast-ext/options.js)`
> **Resolved by extension.** The paired-status line is now built with DOM nodes (`replaceChildren` + `<code>` elements via `.textContent`), so `relayBase`/`relayUserId` can't be parsed as HTML. Extension confirms no `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write` sinks remain. Original finding below.

#### (original) `innerHTML` XSS sink `(fast-ext/options.js:33-35)`
```js
detail.innerHTML = `Paired to <code>${c.relayBase}</code> as user <code>${c.relayUserId}</code> …`;
```
`relayBase` is user-typed and `relayUserId` comes from the relay's `/pair/claim` response — both rendered via `innerHTML` into the **privileged extension options page** (has `chrome.*` access). In normal use the values are benign (a URL the user typed; a sha256-hex or operator userId), so practical risk is low — but a rogue/compromised relay could return a `relayUserId` containing markup, and self-typed `relayBase` is an injection sink. In an extension page that's worse than a web page, and **CWS review flags `innerHTML`**.
- **Fix (extension):** build with `textContent` / DOM nodes instead of `innerHTML` (or escape). Cheap. Do before Chrome Web Store submission; not a shared-launch blocker (operator pairs with their own relay).

### N2. 🟠 SAFETY-spec'd runtime guardrails are doc-only, not wired (multi-user)
`SAFETY.md` §2/§3 and `DEPLOY.md` §8/§9 describe **read-only-by-default**, a popup **Stop/Disconnect kill switch**, a **visible "who is driving" relay indicator**, and **per-origin/sensitive-origin gating** as MUST(v1). In code: `relay.readonly` is always false (M4), and `options.js` exposes only Pair + "use local broker" — there's no relay-session kill switch, no "currently driving" indicator, no read-only default. The connection badge is a partial indicator; "use local" + reload is a coarse disconnect. SAFETY itself scopes these to "before any non-author user," so this is consistent with shared/operator v1 — but it's the **multi-user gate** and is currently unimplemented (extends M4). Tracking under task #12.
- **Fix (extension + relay-core, #12):** real read-only default, a popup Stop/Disconnect that severs the WS + revokes the session, and an active-session indicator; wire per-origin consent (M4).

### N3. 🟡 Doc vs. runtime drift — DEPLOY/SAFETY imply guardrails are live
`DEPLOY.md` §8.4/§9 read as if read-only default + per-origin grants + the activity overlay are active in v1; they're inert/deferred (#12). Harmless for the operator who knows, but could mislead. Add a one-line "v1 = single-operator; consent/read-only land with multi-user (#12)" caveat to both docs.

### N4. 🟡 No lockfile; `^` dependency ranges `(package.json)`
`@cloudflare/workers-oauth-provider ^0.7.2` + `wrangler ^3.90.0` with no committed lockfile → a deploy could silently pull a newer minor/patch (supply-chain + reproducibility). Commit `package-lock.json` (or pin exact versions) so deploys are reproducible — especially relevant since the OAuth provider is security-critical and unverified-at-runtime.

**Net verdict unchanged:** shared deploy is code-clear (both blockers fixed); the multi-user surface (M2–M5 + N2) must close before magic-link. N1/N3/N4 are hardening (N1 before CWS).

---

## 🔴 BLOCKER-for-shared-deploy

### S1. Secrets fell back to a hardcoded insecure default — ✅ FIXED `(auth.js)`
> **Resolved during this audit.** `cookieSecret`/`magicSecret` now call `requireSecret()`, which throws (→ 500 via the handler's try/catch) when the secret is missing or equals the dev default. The relay now fails closed instead of running on a forgeable key. For `wrangler dev`, set the secret in `.dev.vars`. Original finding below for the record.

```js
const cookieSecret = (env) => env.COOKIE_SECRET || 'dev-insecure-secret-change-me';
const magicSecret  = (env) => env.MAGICLINK_SECRET || env.COOKIE_SECRET || 'dev-insecure-secret-change-me';
```
If `COOKIE_SECRET` is unset, the HMAC that protects the OAuth round-trip `state` (and, in magiclink mode, the **magic-link login token itself**) is signed with a value that is public in this repo. Anyone could then forge signed state / login tokens.
- **Shared mode impact:** medium — the `OWNER_SECRET` form is still the real gate, so this is defense-in-depth here. But it's foundational and trivially avoided.
- **Multi-user impact:** CRITICAL (see M3) — a known signing key = forge any user's magic-link login.
- **Fix:** (a) DEPLOY already lists `COOKIE_SECRET` as required — keep that. (b) **Harden the code**: refuse to run on the dev default in production — e.g. throw (or 500) when `env.COOKIE_SECRET` is missing/equals the dev string, rather than silently using it. Fail closed, don't fall back.

### S2. `/mcp` CORS preflight was rejected before the api handler — ✅ FIXED `(index.js)`
> claude.ai web is a browser MCP client and sends an **unauthenticated** `OPTIONS /mcp` preflight before the real POST. `/mcp` is a token-protected `apiRoute`, and the OAuthProvider only auto-answers CORS for its **own** endpoints (token/register/metadata) — not the app's apiRoute — so the preflight 401'd before `FastlinkApiHandler` ran, and it never reaches the `defaultHandler` either (the path matches apiRoute). The browser connector would fail to connect. **Functional blocker, not a vuln, but a hard pre-deploy gate** (folded into this tier per team-lead).
> **Fixed (task #11):** wrapped the OAuthProvider in `index.js` so an `OPTIONS /mcp` is answered (204 + CORS via the allowlist) *before* the provider sees it; everything else passes through unchanged. Also confirmed M1 (`allowPlainPKCE:false`) is now set in the same config. **Must be confirmed by a live preflight smoke-test at deploy** (library OPTIONS behavior is only verifiable at runtime).

### Verified-safe for shared deploy (positives — no action)
- **SQL injection: none.** Every D1 call in `db.js` uses `prepare().bind(...)`; no string interpolation into SQL. ✓
- **Device-token entropy: strong.** 32 random bytes (256-bit) base64url (`auth.js randomToken`). ✓
- **Pairing claim is atomic + single-use.** `claimPairingCode` flips `used_at` with `UPDATE ... WHERE used_at IS NULL AND expires_at > ?` and checks `meta.changes === 1` — no double-claim race. ✓ Magic links use the same pattern.
- **Tenant isolation is structural.** The DO is keyed by `idFromName(userId)` where `userId` comes from the OAuth grant (`ctx.props.userId`, /mcp) or the device-token→D1 lookup (/ext) — never a request parameter. `X-Fastlink-User-Id` is set by the trusted apiHandler purely for labeling and matches the DO's own identity; DO stubs aren't externally addressable. No cross-tenant path found. ✓
- **`fast_evaluate` is OFF by default** and now gated (`db.getEvalPolicy` + `checkEvalAllowed`), with `allowAll` forced false for non-operators inside the helper. ✓

---

## 🟠 BLOCKER-for-multi-user (before `IDENTITY_MODE=magiclink`)

### M1. PKCE `plain` was not disabled — ✅ FIXED `(index.js)`
The `OAuthProvider` defaulted `allowPlainPKCE` to **true**, accepting the `plain` code-challenge method; OAuth 2.1 wants **S256 only**.
- **Fixed (relay-core, task #10):** `allowPlainPKCE: false` added to the `new OAuthProvider({...})` options. S256-only now.

### M2. No rate-limit on magic-link sends → email bombing + Resend cost `(auth.js startMagicLogin via /authorize, /pair/new)`
In magiclink mode, an unauthenticated POST to `/authorize` or `/pair/new` with any email triggers a real Resend send + a `magic_links` row. No throttle, captcha, or per-email/IP cap. An attacker can spam arbitrary inboxes and burn the operator's Resend quota.
- **Fix:** rate-limit by email + client IP (e.g. a short-TTL counter in KV/D1; N sends per email per hour). Optionally cap `magic_links` rows per email. Add expired-row cleanup.

### M3. `MAGICLINK_SECRET` must be set to a strong, dedicated value
The magic-link token IS the authentication in magiclink mode. If it's signed with the S1 dev default (or an attacker-known value), **anyone can forge a login for any email → full account takeover**. The `MAGICLINK_SECRET || COOKIE_SECRET || dev-default` fallback chain means a missing secret silently downgrades security.
- **Fix:** require a dedicated high-entropy `MAGICLINK_SECRET` before enabling magiclink (DEPLOY + the S1 fail-closed check should cover it). Treat "running on fallback" as a deploy error in magiclink mode.

### M4. Per-origin consent / read-only mode is INERT `(mcp.js readonly path; userRelay.readonly always false)`
`relay.readonly` is hardcoded false and nothing wires `site_consent` → `readonly`; there's no `consent_required` first-touch flow. **Any paired site is fully actionable** as soon as OAuth + pairing succeed. Acceptable for one trusted operator; NOT acceptable when strangers' live, logged-in sessions (banking, email) are drivable with no per-site approval — this is also the main prompt-injection containment.
- **Fix:** wire `db.getSiteConsent(userId, origin)` → block/readonly/allow in `dispatchTool`, returning a `consent_required` result on first touch of a new origin. (Needs the extension to report the active tab origin — see M-note below; the origin plumbing also unblocks the audit-origin gap T4.)

### M5. Pairing-code brute force: no rate-limit on `/pair/claim` `(auth.js handlePairClaim)`
Pairing codes are 8 chars over a 30-symbol alphabet (~39 bits), single-use, 10-min TTL — but `/pair/claim` has no attempt throttle. A successful guess of a live code yields a device token bound to that user. The space is large and codes are short-lived, so risk is modest, but with many users/automation it's worth closing.
- **Fix:** rate-limit `/pair/claim` by IP; optionally lock a code after a few failed attempts. (Lengthening the code or shortening TTL also helps.)

### M6. CORRECTNESS BUG — BYO per-user Gemini key didn't decrypt — ✅ FIXED `(userRelay.js)`
`db.getUserGeminiKey(db, userId, keyEncSecret)` needs the AES key material as its **3rd argument**; an earlier call site passed only two, so it always fell back to the operator key (failed safe, but BYO keys did nothing).
- **Fixed (relay-core, task #10):** the call now passes `this.env.KEY_ENC_SECRET` (userRelay.js:230) — per-user keys decrypt. _(My audit snapshot predated relay-core's fix.)_ Not a security hole; listed for completeness.

### Multi-user notes
- **Open DCR:** the library's `/oauth/register` is open (required for claude.ai). Combined with M2, registration is another unauthenticated write surface — include it in rate-limiting.
- **Magic-link cross-device (known, accepted by team-lead for v1):** the grant completes in whichever browser clicks the email link; desktop-start + phone-click won't complete on desktop (claude.ai holds the PKCE verifier there). Same-device is the normal path. Document in DEPLOY.

---

## 🟡 NICE-TO-HAVE (hardening)

- **T1. Add CSP to the HTML pages** (`auth.js htmlPage`). No reflected-XSS was found — all dynamic values go through `escapeHtml`/`escapeAttr`, the signed token is base64url, email isn't reflected into attributes — but a strict `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` on these tiny pages is cheap defense-in-depth.
- **T2. Don't echo internal errors.** `makeDefaultHandler`'s catch returns `relay error: ${e.message}` (500), and "Email failed: …" surfaces the Resend response body to the user. Return generic messages; log details server-side only.
- **T3. `fast_evaluate` origin TOCTOU** (`userRelay.checkEvalAllowed` → separate `callExtension('fast_evaluate')`). The allowlist is checked against the active-tab origin, then the eval runs as a separate round-trip; the active tab could change between. Low risk (a page can't switch the active tab), but ideally the extension enforces the origin at execution, or the origin is pinned and passed to the eval call.
- **T4. Audit log has no `origin` and no values** (`userRelay.audit`). Key-only logging is good for secret/PII hygiene (keep it), but with no origin you can't answer "what did Claude do, and where." Add `origin` once the extension reports it (shares plumbing with M4). No audit-viewing UI yet.
- **T5. Device token rides the WS URL query** (`relayClient.js` connect; forced by the browser WS API). Over TLS this is fine, but `[observability] enabled = true` means query strings may land in logs. Treat `?token=` as sensitive: scrub it from any retained logs.
- **T6. No cleanup of expired `magic_links` / used `pairing_codes`** — unbounded slow growth. Add a periodic purge (cron trigger or opportunistic delete).
- **T7. Don't set `ALLOW_EVALUATE` in production.** `userRelay.evalPolicy()` falls back to treating `ALLOW_EVALUATE` as operator allow-all when DB/userId are absent. That path shouldn't be reachable in prod (userId is always present on /mcp), but leaving the env unset removes any chance of it bypassing the per-user gate.
- **T8. Google path `decodeJwtPayload` does not verify the id_token signature** (`auth.js`, dormant). Safe today because the token comes straight from Google's token endpoint over TLS and the path is dormant — but verify the signature (or use the userinfo endpoint) before ever enabling `IDENTITY_MODE=google`.

---

## Suggested fix order
1. **S1** (fail-closed on secret default) — before any deploy. One-liner.
2. Ship shared mode.
3. Before flipping to magiclink: **M1, M2, M3, M4, M5** (+ M6 if BYO keys are wanted), then the 🟡 items.

_Findings reference current line numbers; they may drift as relay-core lands task #10. S1 and M1 are in relay-core/oauth files respectively — owners noted inline._
