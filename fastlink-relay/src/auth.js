// src/auth.js — OAuth 2.1 authorize UI + device pairing + /ext upgrade routing.
// Owned by: oauth. Implements the OAuthProvider `defaultHandler` (SPEC.md §3b, §4).
//
// The @cloudflare/workers-oauth-provider library is the Worker entrypoint (src/index.js).
// It implements /oauth/token, /oauth/register and /.well-known/oauth-authorization-server
// itself, and routes EVERYTHING ELSE to this default handler. So we own:
//   GET/POST /authorize            — authenticate the human, then completeAuthorization()
//   GET      /authorize/callback   — upstream IdP (Google) redirect target
//   GET/POST /pair/new             — a logged-in human mints a one-time pairing code
//   POST     /pair/claim           — the extension exchanges a code for a device token
//   *        /ext                  — WSS upgrade; resolve device token -> user's DO
//   GET      /  /health            — health check
//
// Identity is PLUGGABLE, isolated behind identityMode() + resolveUserId(). Mode is
// chosen by env.IDENTITY_MODE:
//   - 'magic'  (FINAL per SPEC §4): email magic-link. The human enters their email,
//              we email a signed one-time link (MAGICLINK_SECRET) via Resend
//              (MAIL_API_KEY || RESEND_API_KEY, from MAIL_FROM). userId = sha256(email)
//              so repeat logins / multiple claude.ai sessions collide on one DO.
//   - 'shared' (first-deploy / dev): a shared secret (env.SHARED_SECRET) gates a fixed
//              userId (env.SHARED_USER_ID || 'shared-user'). Used to prove the pipeline
//              before email-provider setup is done.
//   - 'google' (LEGACY/DORMANT): upstream Google OAuth (sub -> userId). Kept compiling
//              but unused unless IDENTITY_MODE=google + UPSTREAM_OAUTH_CLIENT_ID/SECRET.
// Default when IDENTITY_MODE is unset: 'shared' (safe single-user) unless Google creds
// are present. Flip IDENTITY_MODE=magic once the email provider is configured — no rebuild.

import * as db from './db.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const PAIR_TTL_SEC = 600; // pairing code lifetime: 10 minutes
const MAGIC_TTL_SEC = 900; // magic-link lifetime: 15 minutes
const CODE_LEN = 8; // pairing code length
const DEVICE_TOKEN_BYTES = 32; // 256 bits of entropy
const OAUTH_SCOPE = ['browser.drive'];
// Unambiguous alphabet (Crockford-ish, no 0/1/I/O/L/U) for human-typed codes.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

// --- Rate-limit tunables (audit M2/M5) -------------------------------------
// Fixed-window counters backed by db.hitRateLimit (D1 table rate_limits, 0004).
const RL_WINDOW_SEC = 3600;        // 1-hour window for all limiters below
const MAGIC_EMAIL_LIMIT = 5;       // magic-link sends per email / hour
const MAGIC_IP_LIMIT = 20;         // magic-link sends per client IP / hour (covers small offices/NAT)
const PAIR_CLAIM_IP_LIMIT = 30;    // /pair/claim attempts per IP / hour (~39-bit codes, single-use)
const EXTAUTH_IP_LIMIT = 30;       // /ext/authorize attempts per IP / hour
// /ext/authorize/wait self-polls every ~2s for up to MAGIC_TTL_SEC (~450 hits per
// sign-in), so its IP cap must be GENEROUS or legit polling trips it. This is only
// a runaway backstop (the pollId is a 256-bit unguessable token; each hit is a
// single indexed read), so a high ceiling is safe.
const EXTAUTH_WAIT_IP_LIMIT = 2000;
const REGISTER_IP_LIMIT = 20;      // open DCR (/oauth/register) per IP / hour
// Magic mode (M3): the magic-link token IS authentication, so require a dedicated,
// strong MAGICLINK_SECRET — refuse to reuse COOKIE_SECRET or run on a short value.
const MAGICLINK_MIN_LEN = 24;

// ===========================================================================
// Public: the OAuthProvider defaultHandler
// ===========================================================================
export function makeDefaultHandler() {
  return {
    async fetch(request, env, ctx) {
      try {
        const url = new URL(request.url);
        switch (url.pathname) {
          case '/authorize':
            return handleAuthorize(request, env);
          case '/authorize/callback':
            return handleUpstreamCallback(request, env);
          case '/pair/new':
            return handlePairNew(request, env);
          case '/pair/claim':
            return handlePairClaim(request, env);
          case '/ext/authorize':
            return handleExtAuthorize(request, env);
          case '/ext/authorize/wait':
            return handleExtAuthorizeWait(request, env);
          case '/settings/gemini-key':
            return handleSettingsGeminiKey(request, env);
          case '/consent':
            return handleConsent(request, env);
          case '/ext':
            return handleExtUpgrade(request, env);
          case '/':
          case '/health':
            return new Response('ok', { headers: { 'content-type': 'text/plain' } });
          default:
            return new Response('not found', { status: 404 });
        }
      } catch (e) {
        return new Response(`relay error: ${e && e.message ? e.message : e}`, { status: 500 });
      }
    },
  };
}

// ===========================================================================
// /authorize — claude.ai sends the user here (OAuth 2.1 + PKCE)
// ===========================================================================
async function handleAuthorize(request, env) {
  const mode = identityMode(env);

  // Parse the incoming claude.ai OAuth authorization request (carries PKCE
  // code_challenge, client_id, redirect_uri, state, scope). The library tracks
  // PKCE for us; we just need to call completeAuthorization() once we know who
  // the human is.
  let oauthReqInfo;
  if (request.method === 'GET') {
    try {
      oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch (e) {
      return htmlPage('Invalid request', `<p>Not a valid OAuth authorization request.</p>`, 400);
    }
    if (!oauthReqInfo || !oauthReqInfo.clientId) {
      return htmlPage('Invalid request', `<p>Missing client_id.</p>`, 400);
    }
  }

  if (mode === 'shared') {
    return authorizeShared(request, env, oauthReqInfo);
  }
  if (mode === 'magic') {
    return authorizeMagic(request, env, oauthReqInfo);
  }
  // mode === 'google' (legacy/dormant): bounce the human to Google, carrying the
  // (signed) OAuth request in `state` so the callback can finish completeAuthorization().
  const state = await signState(env, { intent: 'oauth', req: oauthReqInfo });
  return Response.redirect(googleAuthUrl(env, state), 302);
}

// Shared-secret dev mode: GET renders a tiny consent/login form; POST verifies
// the secret and completes authorization for a single fixed user.
async function authorizeShared(request, env, oauthReqInfo) {
  if (request.method === 'GET') {
    const reqToken = await signState(env, { req: oauthReqInfo });
    return htmlPage(
      'Authorize FastLink',
      `<p>Claude (claude.ai) is requesting permission to drive your browser.</p>
       <form method="POST" action="/authorize">
         <input type="hidden" name="req" value="${escapeAttr(reqToken)}" />
         <label>Relay secret<br/>
           <input type="password" name="secret" autocomplete="current-password" required />
         </label>
         <p><button type="submit">Authorize</button></p>
       </form>
       <p class="muted">Bootstrap mode (single-user). Set IDENTITY_MODE=magiclink for multi-user email sign-in.</p>`
    );
  }
  if (request.method === 'POST') {
    const form = await request.formData();
    const secret = String(form.get('secret') || '');
    const st = await verifyState(env, String(form.get('req') || ''));
    if (!st || !st.req) return htmlPage('Session expired', `<p>Please retry from claude.ai.</p>`, 400);
    const owner = ownerSecret(env);
    if (!owner || !timingSafeEqual(secret, owner)) {
      return htmlPage('Denied', `<p>Incorrect secret.</p>`, 401);
    }
    const userId = sharedUserId(env);
    await db.upsertUser(env.DB, userId, {});
    await db.setOperator(env.DB, userId, true); // bootstrap single-user IS the operator
    return completeOAuth(env, st.req, userId);
  }
  return new Response('method not allowed', { status: 405 });
}

// Magic-link mode: GET renders an email-entry form; POST emails a one-time link.
// The link target is /authorize/callback?ml=<signed token> which finishes the flow.
async function authorizeMagic(request, env, oauthReqInfo) {
  if (request.method === 'GET') {
    const reqToken = await signState(env, { req: oauthReqInfo });
    return emailEntryPage('/authorize', reqToken);
  }
  if (request.method === 'POST') {
    const form = await request.formData();
    const email = normalizeEmail(form.get('email'));
    const st = await verifyState(env, String(form.get('req') || ''));
    if (!st || !st.req) return htmlPage('Session expired', `<p>Please retry from claude.ai.</p>`, 400);
    if (!email) return htmlPage('Invalid email', `<p>Please enter a valid email address.</p>`, 400);
    return startMagicLogin(env, email, { intent: 'oauth', req: st.req }, request);
  }
  return new Response('method not allowed', { status: 405 });
}

// Issue + email a one-time magic link. `payload` carries intent ('oauth' | 'pair'
// | 'ext_pair') and, for 'oauth', the original claude.ai OAuth request (`req`).
// `request` (optional) is used only to derive the client IP for rate-limiting —
// the per-email cap applies regardless. This is the single chokepoint for ALL
// magic-link sends (/authorize, /pair/new, /ext/authorize), so M2 lives here.
async function startMagicLogin(env, email, payload, request) {
  // M2: throttle sends by email + client IP to stop inbox bombing + Resend cost.
  const rl = await magicSendLimit(env, email, request);
  if (!rl.allowed) {
    return htmlPage(
      'Too many requests',
      `<p>Too many sign-in emails were requested. Please wait about ${Math.ceil(rl.retryAfterSec / 60)} minute(s) and try again.</p>`,
      429,
      { 'retry-after': String(rl.retryAfterSec) }
    );
  }
  const jti = randomToken();
  const exp = Date.now() + MAGIC_TTL_SEC * 1000;
  await db.createMagicLink(env.DB, jti, email, MAGIC_TTL_SEC);
  const token = await signMagic(env, { ...payload, email, jti, exp });
  const url = relayBase(env) + '/authorize/callback?ml=' + encodeURIComponent(token);
  try {
    await sendMagicLink(env, email, url);
  } catch (e) {
    return htmlPage('Email failed', `<p>Could not send the sign-in email: ${escapeHtml(String(e.message || e))}</p>`, 502);
  }
  return htmlPage(
    'Check your email',
    `<p>We emailed a sign-in link to <strong>${escapeHtml(email)}</strong>.</p>
     <p class="muted">The link expires in 15 minutes. You can close this tab.</p>`
  );
}

// ===========================================================================
// /authorize/callback — magic-link target (ml=) OR Google redirect (code=)
// ===========================================================================
async function handleUpstreamCallback(request, env) {
  const url = new URL(request.url);
  // Magic-link callback takes precedence when present.
  if (url.searchParams.get('ml')) return handleMagicCallback(request, env);

  const err = url.searchParams.get('error');
  if (err) return htmlPage('Login failed', `<p>Upstream login error: ${escapeHtml(err)}</p>`, 400);

  const code = url.searchParams.get('code');
  const st = await verifyState(env, url.searchParams.get('state'));
  if (!code || !st) return htmlPage('Invalid callback', `<p>Bad or expired login state.</p>`, 400);

  let identity;
  try {
    identity = await exchangeGoogleCode(env, code);
  } catch (e) {
    return htmlPage('Login failed', `<p>Could not verify Google login: ${escapeHtml(String(e.message || e))}</p>`, 502);
  }
  // userId derivation UNCHANGED: Google `sub` (stable per-account). The id_token was
  // obtained by exchangeGoogleCode server-side (auth-code exchange at Google's token
  // endpoint) — we never accept a client-supplied id_token.
  const userId = identity.sub;
  await db.upsertUser(env.DB, userId, { email: identity.email });
  // Designate the operator (enables operator-only eval test mode) if configured —
  // parity with the magic-link callback.
  if (env.OPERATOR_EMAIL && identity.email && normalizeEmail(env.OPERATOR_EMAIL) === normalizeEmail(identity.email)) {
    await db.setOperator(env.DB, userId, true);
  }

  if (st.intent === 'pair') {
    // Resuming a /pair/new flow: mint the code now that we know who the user is.
    return mintAndShowCode(env, userId);
  }
  if (st.intent === 'ext_pair') {
    // One-click extension sign-in (google mode) completing IN the launchWebAuthFlow
    // window. Re-validate the ext redirect target (EXACT-match chromiumapp.org +
    // EXTENSION_ID guard — never trust state blindly), mint a device token via the
    // SAME createDevice path as shared one-click / /pair/claim, then 302 to the
    // extension carrying the token in the URL fragment.
    const redirectUri = validExtRedirect(env, st.redirectUri);
    if (!redirectUri) return htmlPage('Invalid request', `<p>Invalid redirect target.</p>`, 400);
    const label = String(st.label || 'browser');
    const deviceToken = randomToken();
    await db.createDevice(env.DB, userId, deviceToken, label);
    await db.logAudit(env.DB, userId, 'pair_authorize', { label, via: 'google', tab: !!st.pollId });
    // Tab-poll fallback: this is a REGULAR tab (not a launchWebAuthFlow window), so
    // a chromiumapp.org 302 would dead-end on a placeholder page. Park the token
    // under the extension-supplied pollId instead; the extension's JSON poll
    // (POST /ext/authorize/wait) collects it. Token stays out of the Location URL.
    if (st.pollId) {
      try {
        await db.parkPairRequest(env.DB, st.pollId, { redirectUri, state: st.state }, userId, deviceToken, PAIR_REQUEST_TTL_SEC);
      } catch {
        return htmlPage('Not available yet', `<p>Tab sign-in isn't enabled on this relay yet. Please use a pairing code instead.</p>`, 501);
      }
      return extTabSuccessPage();
    }
    return redirectResponse(extSuccessRedirect(env, redirectUri, deviceToken, userId, st.state));
  }
  // Resuming the claude.ai OAuth flow.
  if (!st.req) return htmlPage('Session expired', `<p>Please retry from claude.ai.</p>`, 400);
  return completeOAuth(env, st.req, userId);
}

// Magic-link callback: verify the signed token, atomically consume it (single-use),
// derive userId from the email, then resume whatever the link was for.
async function handleMagicCallback(request, env) {
  const token = new URL(request.url).searchParams.get('ml');
  const st = await verifyMagic(env, token);
  if (!st || !st.jti || !st.email) return htmlPage('Invalid link', `<p>This sign-in link is invalid.</p>`, 400);
  if (!st.exp || st.exp < Date.now()) return htmlPage('Link expired', `<p>This sign-in link has expired — please request a new one.</p>`, 400);

  // Single-use: claim the jti in D1 (also re-checks DB expiry). Stops link replay.
  const claim = await db.claimMagicLink(env.DB, st.jti);
  if (!claim) return htmlPage('Link already used', `<p>This sign-in link was already used or has expired.</p>`, 400);

  const userId = await resolveUserId(st.email);
  await db.upsertUser(env.DB, userId, { email: st.email });
  // Designate the operator (enables operator-only eval test mode) if configured.
  if (env.OPERATOR_EMAIL && normalizeEmail(env.OPERATOR_EMAIL) === st.email) {
    await db.setOperator(env.DB, userId, true);
  }

  if (st.intent === 'pair') return mintAndShowCode(env, userId);
  // Phase 2 (DARK): one-click extension sign-in (SIGNUP-SPEC §1.5 step 3). Mint the
  // device token now and BIND it to the pair_request keyed by pollId, so the still-
  // open auth window (refreshing /ext/authorize/wait) can perform the final cross-
  // context 302 to the extension's chromiumapp.org callback. This tab (the email
  // click) does NOT redirect — it just confirms.
  if (st.intent === 'ext_pair') return completeExtPairMagic(env, userId, st.pollId);
  if (!st.req) return htmlPage('Session expired', `<p>Please retry from claude.ai.</p>`, 400);
  return completeOAuth(env, st.req, userId);
}

// Phase 2 (DARK): finish a magic-mode /ext/authorize by minting the device token and
// binding it to the pair_request. The user clicked the link in their normal tab; the
// OTHER (auth) window is refreshing /ext/authorize/wait and performs the final redirect.
async function completeExtPairMagic(env, userId, pollId) {
  if (!pollId) return htmlPage('Session expired', `<p>Please retry sign-in from the extension.</p>`, 400);
  const pr = await db.claimPairRequest(env.DB, pollId);
  if (!pr) return htmlPage('Link expired', `<p>This sign-in session has expired — please retry from the extension.</p>`, 400);
  const deviceToken = randomToken();
  await db.createDevice(env.DB, userId, deviceToken, 'browser');
  await db.bindPairRequest(env.DB, pollId, String(userId), deviceToken);
  await db.logAudit(env.DB, userId, 'pair_authorize', { via: 'magic' });
  return htmlPage(
    'Signed in',
    `<p>✓ Signed in. Return to the extension window — it'll connect automatically.</p>
     <p class="muted">You can close this tab.</p>`
  );
}

// Finish the claude.ai authorization grant -> 302 back to claude.ai with the code.
// props.userId is exactly what FastlinkApiHandler reads from ctx.props.
//
// We ALSO stamp `idm` = the identity mode this grant was minted under. The MCP api
// handler (index.js) re-checks it on every request: if the relay's IDENTITY_MODE
// later changes, an old token's userId names a DO the (re-paired) extension no
// longer attaches to — claude.ai would silently talk to an empty DO. Stamping the
// mode lets the api handler reject such a stale token (401 invalid_token) so
// claude.ai re-authorizes cleanly under the current mode instead of failing silently.
async function completeOAuth(env, oauthReqInfo, userId) {
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: String(userId),
    scope: OAUTH_SCOPE,
    metadata: { ts: Date.now() },
    props: { userId: String(userId), idm: identityMode(env) },
  });
  return Response.redirect(redirectTo, 302);
}

// ===========================================================================
// /pair/new — a signed-in human mints a one-time pairing code
// ===========================================================================
async function handlePairNew(request, env) {
  const mode = identityMode(env);

  if (mode === 'shared') {
    if (request.method === 'GET') {
      // If the owner already proved the secret recently (valid signed session
      // cookie), skip re-typing it and offer a one-click "Generate code" button.
      if (await hasPairSession(request, env)) {
        return htmlPage(
          'Pair your browser',
          `<p>You're signed in to the relay. Generate a one-time pairing code for your extension.</p>
           <form method="POST" action="/pair/new">
             <p><button type="submit">Generate code</button></p>
           </form>
           <p class="muted">This shortcut lasts 30 minutes. Pairing codes still expire in 10 minutes and are single-use.</p>`
        );
      }
      return htmlPage(
        'Pair your browser',
        `<p>Enter the relay secret to generate a pairing code for your extension.</p>
         <form method="POST" action="/pair/new">
           <label>Relay secret<br/>
             <input type="password" name="secret" autocomplete="current-password" required />
           </label>
           <p><button type="submit">Generate code</button></p>
         </form>`
      );
    }
    if (request.method === 'POST') {
      const form = await request.formData();
      const owner = ownerSecret(env);
      const secretOk = !!owner && timingSafeEqual(String(form.get('secret') || ''), owner);
      const sessionOk = await hasPairSession(request, env);
      // Accept either a correct secret OR a still-valid session cookie. The cookie
      // never WEAKENS the secret check — it only persists a prior success. Minting
      // a code is itself low-risk (single-use, 10-min TTL).
      if (!secretOk && !sessionOk) {
        return htmlPage('Denied', `<p>Incorrect secret.</p>`, 401);
      }
      // On a fresh secret submit, (re)issue the short-TTL signed session cookie so
      // subsequent code generations are one-click. One-click mints don't extend it.
      const headers = secretOk ? { 'set-cookie': await pairSessionCookie(env) } : {};
      return mintAndShowCode(env, sharedUserId(env), headers);
    }
    return new Response('method not allowed', { status: 405 });
  }

  if (mode === 'magic') {
    if (request.method === 'GET') return emailEntryPage('/pair/new', '');
    if (request.method === 'POST') {
      const form = await request.formData();
      const email = normalizeEmail(form.get('email'));
      if (!email) return htmlPage('Invalid email', `<p>Please enter a valid email address.</p>`, 400);
      return startMagicLogin(env, email, { intent: 'pair' }, request);
    }
    return new Response('method not allowed', { status: 405 });
  }

  // google mode (legacy/dormant): send the human through Google, then mint on callback.
  const state = await signState(env, { intent: 'pair' });
  return Response.redirect(googleAuthUrl(env, state), 302);
}

async function mintAndShowCode(env, userId, extraHeaders = {}) {
  await db.upsertUser(env.DB, userId, {}); // ensure FK target exists
  const code = randomCode();
  await db.createPairingCode(env.DB, userId, code, PAIR_TTL_SEC);
  const grouped = code.slice(0, 4) + '-' + code.slice(4);

  // Optional one-click deep link into the extension's options page (relay URL +
  // code pre-filled). Only rendered when EXTENSION_ID is configured. Chrome blocks
  // web→chrome-extension:// navigation, so it's shown as copyable text, not a link.
  const deepLink = extDeepLink(env, relayBase(env), grouped);
  const deepLinkHtml = deepLink
    ? `<p class="muted">Shortcut: paste this into your address bar to open the extension with everything pre-filled.</p>
       <p class="code2">${escapeHtml(deepLink)}</p>
       <p><button type="button" class="copybtn ghost" data-copy="${escapeAttr(deepLink)}">Copy link</button></p>`
    : '';

  return htmlPage(
    'Pair your browser',
    `<p>Open the FastLink extension's options page and paste this code (the Relay URL is already pre-filled there):</p>
     <p class="code" id="code">${escapeHtml(grouped)}</p>
     <div class="row">
       <button type="button" class="copybtn primary" data-copy="${escapeAttr(grouped)}">Copy code</button>
       <form method="POST" action="/pair/new" style="display:inline">
         <button type="submit" class="ghost">Generate another code</button>
       </form>
     </div>
     <p class="muted">Expires in 10 minutes. Single use.</p>
     ${deepLinkHtml}
     <script>
       document.querySelectorAll('.copybtn').forEach(function(b){
         b.addEventListener('click', function(){
           if(!navigator.clipboard) return;
           navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function(){
             var t=b.textContent; b.textContent='Copied!';
             setTimeout(function(){ b.textContent=t; }, 1200);
           });
         });
       });
     </script>`,
    200,
    extraHeaders
  );
}

// Build the optional extension deep link. Requires env.EXTENSION_ID to be the
// 32-char Chrome extension id (a–p). Returns '' when unset/invalid.
function extDeepLink(env, base, code) {
  const id = String(env.EXTENSION_ID || '');
  if (!/^[a-p]{32}$/.test(id)) return '';
  return `chrome-extension://${id}/options.html?relay=${encodeURIComponent(base)}&code=${encodeURIComponent(code)}`;
}

// ===========================================================================
// /pair/claim — the extension exchanges a code for a long-lived device token
// (POSTed from the extension's background service worker / popup)
// ===========================================================================
async function handlePairClaim(request, env) {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);

  // M5: throttle pairing-code brute force by client IP (codes are ~39-bit).
  const rl = await ipRateLimit(env, request, 'claim', PAIR_CLAIM_IP_LIMIT, RL_WINDOW_SEC);
  if (!rl.allowed) return jsonResponse({ error: 'rate_limited', retryAfter: rl.retryAfterSec }, 429);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }
  const code = normalizeCode(body && body.code);
  if (!code) return jsonResponse({ error: 'invalid_or_expired_code' }, 400);

  const claim = await db.claimPairingCode(env.DB, code);
  if (!claim) return jsonResponse({ error: 'invalid_or_expired_code' }, 400);

  const deviceToken = randomToken();
  const label = (body && (body.label || body.deviceId)) ? String(body.label || body.deviceId) : 'browser';
  await db.createDevice(env.DB, claim.userId, deviceToken, label);
  await db.logAudit(env.DB, claim.userId, 'pair_claim', { label });

  return jsonResponse({
    deviceToken,
    userId: claim.userId,
    wssUrl: wssBase(env) + '/ext',
  });
}

// ===========================================================================
// /settings/gemini-key — device-token-authed BYO Gemini key (SIGNUP-SPEC §5.3, P1).
// The onboarding page (ext-auth, step 2) POSTs the user's own Gemini key so the
// scout/vision/prewarm tier works for extension-only users without leaving the
// browser. The device token the extension already holds IS the auth — no extra
// OAuth. Key is stored AES-GCM encrypted at rest (db.setUserGeminiKey). FastLink is
// fully usable DOM-only WITHOUT a key; this is purely the optional speed tier.
//   POST { deviceToken, key }  -> { ok:true, hasKey } (empty/missing key clears it)
//   GET  ?deviceToken=...      -> { hasKey, effective, source } (never the key itself)
//     hasKey    = a personal BYO key is stored for this user
//     effective = vision actually works — own key OR the relay's operator-level
//                 GEMINI_API_KEY/GOOGLE_API_KEY fallback (mirrors userRelay.js),
//                 so the UI doesn't show "add a key" when vision is already live
//     source    = 'own' | 'shared' | null
// ===========================================================================
async function handleSettingsGeminiKey(request, env) {
  if (request.method === 'OPTIONS') return corsPreflight();

  // Resolve identity from the device token (same bearer the extension holds).
  async function userFromToken(token) {
    const device = await db.lookupDevice(env.DB, token);
    if (!device || device.revoked) return null;
    return device.userId;
  }

  if (request.method === 'GET') {
    const token = new URL(request.url).searchParams.get('deviceToken');
    const userId = await userFromToken(token);
    if (!userId) return jsonResponse({ error: 'invalid_device_token' }, 401);
    const key = await db.getUserGeminiKey(env.DB, userId, env.KEY_ENC_SECRET);
    // Same operator-key fallback userRelay.js uses when serving vision calls —
    // a user without a personal key still has vision if the shared key exists.
    const shared = !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
    return jsonResponse({
      hasKey: !!key,
      effective: !!key || shared,
      source: key ? 'own' : (shared ? 'shared' : null),
    });
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'invalid_json' }, 400);
    }
    const userId = await userFromToken(body && body.deviceToken);
    if (!userId) return jsonResponse({ error: 'invalid_device_token' }, 401);
    const key = body && body.key != null ? String(body.key).trim() : '';
    // Empty/missing key clears any stored key (db treats falsy as clear).
    await db.setUserGeminiKey(env.DB, userId, key || null, env.KEY_ENC_SECRET);
    await db.logAudit(env.DB, userId, key ? 'gemini_key_set' : 'gemini_key_clear', {});
    return jsonResponse({ ok: true, hasKey: !!key });
  }

  return jsonResponse({ error: 'method_not_allowed' }, 405);
}

// ===========================================================================
// /consent — per-origin consent grant/revoke (SIGNUP-SPEC §4.2). relay-auth OWNS
// this endpoint; hardening owns the ENFORCEMENT gate in mcp.js (which READS the
// site_consent rows this writes). Device-token-authed (the extension already holds
// the token) so the human grants from the extension popup WITHOUT leaving the
// browser — this is the HUMAN-ONLY grant path (prompt-injection containment): it is
// NOT an MCP tool Claude can call. Claude can only surface a `consent_required`
// result; the human clicks Allow/Read-only/Block here.
//   POST { deviceToken, origin, mode∈allow|readonly|block } -> { ok, origin, mode }
//   GET  ?deviceToken=...  -> { origins: [{ origin, mode, updatedAt }] }
// ===========================================================================
const CONSENT_MODES = ['allow', 'readonly', 'block'];

async function handleConsent(request, env) {
  if (request.method === 'OPTIONS') return corsPreflight();

  // Resolve identity from the device token (same bearer the extension holds).
  async function userFromToken(token) {
    const device = await db.lookupDevice(env.DB, token);
    if (!device || device.revoked) return null;
    return device.userId;
  }

  if (request.method === 'GET') {
    const token = new URL(request.url).searchParams.get('deviceToken');
    const userId = await userFromToken(token);
    if (!userId) return jsonResponse({ error: 'invalid_device_token' }, 401);
    const origins = await db.listSiteConsent(env.DB, userId);
    return jsonResponse({ origins });
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'invalid_json' }, 400);
    }
    const userId = await userFromToken(body && body.deviceToken);
    if (!userId) return jsonResponse({ error: 'invalid_device_token' }, 401);
    const origin = normalizeOrigin(body && body.origin);
    if (!origin) return jsonResponse({ error: 'invalid_origin' }, 400);
    const mode = String((body && body.mode) || '');
    if (!CONSENT_MODES.includes(mode)) return jsonResponse({ error: 'invalid_mode' }, 400);
    await db.setSiteConsent(env.DB, userId, origin, mode);
    await db.logAudit(env.DB, userId, 'consent_set', { origin, mode });
    return jsonResponse({ ok: true, origin, mode });
  }

  return jsonResponse({ error: 'method_not_allowed' }, 405);
}

// Normalize a site origin to its canonical scheme://host[:port] form (drops any
// path/query/fragment). Returns '' if it isn't a valid absolute http(s) origin —
// so a malformed origin can't silently create a junk consent row.
function normalizeOrigin(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let u;
  try { u = new URL(raw); } catch { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  return u.origin;
}

// ===========================================================================
// /ext/authorize — one-click extension sign-in via chrome.identity.launchWebAuthFlow.
// (SIGNUP-SPEC.md §1.) The extension opens this URL in an isolated auth window:
//   GET /ext/authorize?redirect_uri=<chromiumapp.org>&state=<≥16ch>&label=<name>
// We authenticate the HUMAN (shared [P1]: OWNER_SECRET form / fl_pair cookie; magic
// [P2, dark]: email round-trip bridged by /ext/authorize/wait), mint a device token
// (db.createDevice — same format/path as /pair/claim), then 302 back to the
// extension's redirect_uri carrying the token in the URL FRAGMENT (kept out of the
// relay's 302 Location access logs — audit T5):
//   302 -> <redirect_uri>#devicetoken=..&userId=..&wssUrl=wss://host/ext&state=..
// On cancel we 302 to <redirect_uri>#error=<code>&state=.. (SIGNUP-SPEC §4.1).
//
// TAB-POLL FALLBACK (all modes): when the extension can't use launchWebAuthFlow it
// opens this URL in a REGULAR tab with an extra &poll=<extension-generated id>.
// A regular tab can't complete via the chromiumapp.org redirect, so the completion
// path PARKS the minted token in pair_requests under the pollId instead, and the
// extension collects it once via POST /ext/authorize/wait. Same auth, same
// createDevice path, same validExtRedirect guard — only the delivery leg differs.
//
// SECURITY: redirect_uri must match ^https://[a-p]{32}.chromiumapp.org/?$ (and is
// pinned to EXTENSION_ID when configured) BEFORE we ever redirect — an invalid
// target renders an error page, never a redirect. This is the open-redirect guard
// (SIGNUP-SPEC §1.2, §4.1). The manual /pair/new + /pair/claim path stays as the
// fallback. Token format/issuance/revoke are UNCHANGED from /pair/claim.
// ===========================================================================

// chrome.identity.getRedirectURL() yields exactly https://<32-char a–p id>.chromiumapp.org/.
// Normative redirect_uri regex (SIGNUP-SPEC §1.2 / §4.1): root only, optional trailing slash.
const EXT_REDIRECT_RE = /^https:\/\/[a-p]{32}\.chromiumapp\.org\/?$/;

// Validate an extension redirect URI against the normative regex (and pin to
// EXTENSION_ID when configured). Returns the string unchanged, or null. The single
// open-redirect chokepoint.
function validExtRedirect(env, raw) {
  if (!raw || typeof raw !== 'string' || !EXT_REDIRECT_RE.test(raw)) return null;
  const id = String(env.EXTENSION_ID || '');
  if (/^[a-p]{32}$/.test(id) && raw !== `https://${id}.chromiumapp.org/` && raw !== `https://${id}.chromiumapp.org`) {
    return null;
  }
  return raw;
}

// Append result params to a (pre-validated) redirect_uri as a URL fragment.
function extRedirectWithFragment(redirectUri, params) {
  const frag = new URLSearchParams(params).toString();
  return redirectUri.split('#')[0] + '#' + frag;
}

// 302 with optional extra headers (Response.redirect can't carry Set-Cookie).
function redirectResponse(location, extraHeaders = {}) {
  return new Response(null, { status: 302, headers: { location, ...extraHeaders } });
}

// Build the success fragment redirect. Param NAMES are normative (SIGNUP-SPEC §1.3/§4.1):
// devicetoken, userId, wssUrl, state.
function extSuccessRedirect(env, redirectUri, deviceToken, userId, state) {
  return extRedirectWithFragment(redirectUri, {
    devicetoken: deviceToken,
    userId: String(userId),
    wssUrl: wssBase(env) + '/ext',
    state: String(state || ''),
  });
}

const PAIR_REQUEST_TTL_SEC = MAGIC_TTL_SEC; // magic-mode poll session lifetime (15 min)

async function handleExtAuthorize(request, env) {
  const mode = identityMode(env);

  // M5: throttle one-click sign-in attempts by client IP (the POST also funnels
  // magic-link sends through startMagicLogin's per-email/IP limiter).
  const rl = await ipRateLimit(env, request, 'extauth', EXTAUTH_IP_LIMIT, RL_WINDOW_SEC);
  if (!rl.allowed) {
    return htmlPage('Too many requests', `<p>Too many sign-in attempts. Please wait a few minutes and try again.</p>`, 429, { 'retry-after': String(rl.retryAfterSec) });
  }

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const redirectUri = validExtRedirect(env, url.searchParams.get('redirect_uri'));
    // No safe redirect target → must NOT redirect (open-redirect guard). Render an error.
    if (!redirectUri) {
      return htmlPage(
        'Invalid request',
        `<p>Missing or invalid <code>redirect_uri</code>. Expected a Chrome extension <code>chromiumapp.org</code> callback.</p>`,
        400
      );
    }
    const state = String(url.searchParams.get('state') || '');
    const label = url.searchParams.get('label') ? String(url.searchParams.get('label')) : 'browser';
    // Tab-poll fallback: an extension-generated, unguessable poll key (≥128-bit
    // base64url/hex). When present, the completion path PARKS the minted token under
    // it (instead of 302ing to chromiumapp.org, which only works inside a
    // launchWebAuthFlow window) and the extension collects it via POST
    // /ext/authorize/wait. Carried only inside the HMAC-signed state — never trusted
    // from a later request. Malformed values degrade to the redirect flow.
    const pollId = validPollId(url.searchParams.get('poll'));

    if (mode === 'shared') {
      // Sign the ext-auth context so the POST can trust redirect_uri/state/label.
      const reqToken = await signState(env, { x: 'ext_pair', redirectUri, state, label, pollId });
      const oneClick = await hasPairSession(request, env);
      return extAuthorizeSharedForm(reqToken, oneClick);
    }

    if (mode === 'magic') {
      // --- Phase 2 (DARK until the pair_requests migration + a deploy) ---------
      // The email link can't complete the isolated launchWebAuthFlow window, so the
      // POST will create a pair_request + serve a self-polling /ext/authorize/wait
      // page that 302s once the link is clicked elsewhere (SIGNUP-SPEC §1.5).
      const reqToken = await signState(env, { x: 'ext_pair', redirectUri, state, label, pollId });
      return emailEntryPage('/ext/authorize', reqToken);
    }

    if (mode === 'google') {
      // SINGLE-WINDOW pattern (like 'shared'): the user signs into Google INSIDE this
      // launchWebAuthFlow window and Google 302s back to /authorize/callback — no
      // email round-trip, no polling/wait-page needed. Stash the (already-validated)
      // extension redirect_uri + state + label into the signed OAuth `state` we hand
      // Google (intent:'ext_pair'); the callback re-validates them, mints a device
      // token, and 302s to the chromiumapp.org redirect (or parks it under pollId in
      // the tab-poll flow). `state` is HMAC-signed (COOKIE_SECRET) → anti-CSRF +
      // tamper-proof through Google.
      const oauthState = await signState(env, { intent: 'ext_pair', redirectUri, state, label, pollId });
      return Response.redirect(googleAuthUrl(env, oauthState), 302);
    }

    // other modes: not wired for one-click.
    return htmlPage('Unsupported', `<p>One-click sign-in isn't available in this identity mode.</p>`, 501);
  }

  if (request.method === 'POST') {
    const form = await request.formData();
    const st = await verifyState(env, String(form.get('req') || ''));
    if (!st || st.x !== 'ext_pair') {
      return htmlPage('Session expired', `<p>Please retry sign-in from the extension.</p>`, 400);
    }
    const redirectUri = validExtRedirect(env, st.redirectUri);
    if (!redirectUri) return htmlPage('Invalid request', `<p>Invalid redirect target.</p>`, 400);
    const state = String(st.state || '');
    const label = String(st.label || 'browser');

    // Explicit cancel → bounce to the extension with an error fragment (SIGNUP-SPEC §4.1).
    // Tab-poll flow: no auth window to complete — render a plain page (the extension's
    // poll simply never resolves; closing the tab aborts it client-side).
    if (form.get('cancel')) {
      if (st.pollId) {
        return htmlPage('Canceled', `<p>Sign-in was canceled. You can close this tab and retry from the FastLink settings page.</p>`);
      }
      return redirectResponse(extRedirectWithFragment(redirectUri, { error: 'access_denied', state }));
    }

    if (mode === 'shared') {
      const owner = ownerSecret(env);
      const secretOk = !!owner && timingSafeEqual(String(form.get('secret') || ''), owner);
      const sessionOk = await hasPairSession(request, env);
      // Wrong/absent secret: re-render the form (don't redirect access_denied on a
      // typo — only an explicit Cancel ends the flow with an error).
      if (!secretOk && !sessionOk) {
        return extAuthorizeSharedForm(String(form.get('req') || ''), false, 'Incorrect secret.');
      }
      const userId = sharedUserId(env);
      await db.upsertUser(env.DB, userId, {});
      await db.setOperator(env.DB, userId, true); // bootstrap single-user IS the operator
      const deviceToken = randomToken();
      await db.createDevice(env.DB, userId, deviceToken, label);
      await db.logAudit(env.DB, userId, 'pair_authorize', { label, via: 'shared', tab: !!st.pollId });
      const headers = secretOk ? { 'set-cookie': await pairSessionCookie(env) } : {};
      // Tab-poll fallback: park the token for the extension's JSON poll instead of
      // 302ing to chromiumapp.org (dead-end placeholder outside launchWebAuthFlow).
      if (st.pollId) {
        try {
          await db.parkPairRequest(env.DB, st.pollId, { redirectUri, state }, userId, deviceToken, PAIR_REQUEST_TTL_SEC);
        } catch {
          return htmlPage('Not available yet', `<p>Tab sign-in isn't enabled on this relay yet. Please use a pairing code instead.</p>`, 501);
        }
        return extTabSuccessPage(headers);
      }
      return redirectResponse(extSuccessRedirect(env, redirectUri, deviceToken, userId, state), headers);
    }

    if (mode === 'magic') {
      // Phase 2 (dark): create a pair_request, email the link, 302 to the wait-page
      // (stays inside the auth window). The link's callback binds the token; the
      // wait-page then 302s to chromiumapp.org. (SIGNUP-SPEC §1.5 step 1.)
      // Tab-poll fallback: the extension supplied its own pollId (signed state), so
      // reuse it — the emailed link's callback binds the token to it as usual, and
      // the EXTENSION's JSON poll collects it (no self-polling wait-page needed;
      // this tab just shows "check your email").
      const email = normalizeEmail(form.get('email'));
      if (!email) return htmlPage('Invalid email', `<p>Please enter a valid email address.</p>`, 400);
      const pollId = st.pollId || randomToken();
      try {
        await db.createPairRequest(env.DB, pollId, { redirectUri, state }, PAIR_REQUEST_TTL_SEC);
      } catch {
        return htmlPage(
          'Not available yet',
          `<p>One-click email sign-in isn't enabled on this relay yet. Please use a pairing code instead.</p>`,
          501
        );
      }
      const sent = await startMagicLogin(env, email, { intent: 'ext_pair', pollId, redirect_uri: redirectUri, state }, request);
      // If startMagicLogin short-circuited (rate-limited 429 / email send failure),
      // surface that page instead of bouncing to a wait-page that will never resolve.
      if (sent && sent.status >= 400) return sent;
      if (st.pollId) return sent;
      return redirectResponse('/ext/authorize/wait?pt=' + encodeURIComponent(pollId));
    }

    return htmlPage('Unsupported', `<p>One-click sign-in isn't available in this identity mode.</p>`, 501);
  }

  return new Response('method not allowed', { status: 405 });
}

// Shared-mode consent/secret form rendered inside the launchWebAuthFlow window.
function extAuthorizeSharedForm(reqToken, oneClick, errorMsg) {
  const err = errorMsg ? `<p style="color:#c00">${escapeHtml(errorMsg)}</p>` : '';
  const cancelForm = `<form method="POST" action="/ext/authorize" style="display:inline">
       <input type="hidden" name="req" value="${escapeAttr(reqToken)}" />
       <input type="hidden" name="cancel" value="1" />
       <button type="submit" class="ghost">Cancel</button>
     </form>`;
  if (oneClick) {
    return htmlPage(
      'Connect your browser',
      `${err}<p>Claude wants to connect this browser to your FastLink relay.</p>
       <div class="row">
         <form method="POST" action="/ext/authorize" style="display:inline">
           <input type="hidden" name="req" value="${escapeAttr(reqToken)}" />
           <button type="submit" class="primary">Connect</button>
         </form>
         ${cancelForm}
       </div>
       <p class="muted">You're already signed in to the relay — one click connects the extension.</p>`
    );
  }
  return htmlPage(
    'Connect your browser',
    `${err}<p>Enter the relay secret to connect this browser to FastLink.</p>
     <form method="POST" action="/ext/authorize">
       <input type="hidden" name="req" value="${escapeAttr(reqToken)}" />
       <label>Relay secret<br/>
         <input type="password" name="secret" autocomplete="current-password" required />
       </label>
       <div class="row">
         <button type="submit" class="primary">Connect</button>
         ${cancelForm}
       </div>
     </form>`
  );
}

// --- Phase 2 (DARK): magic-mode self-polling wait-page (SIGNUP-SPEC §1.5 step 2) -
// Held INSIDE the launchWebAuthFlow window. Each GET checks the pair_request keyed
// by `pt`: once the emailed-link callback has bound a device token, 302 to
// redirect_uri#devicetoken=..&state=.. (completing the auth window from a different
// context than the email click); otherwise re-render with a ~2s meta-refresh.
// Needs the pair_requests table (future migration + deploy).
async function handleExtAuthorizeWait(request, env) {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }
  // M5: generous IP cap (both the HTML wait-page and the extension's JSON poll
  // self-poll every ~2s; a tight limit would break them). One shared bucket.
  const rl = await ipRateLimit(env, request, 'extauthwait', EXTAUTH_WAIT_IP_LIMIT, RL_WINDOW_SEC);
  if (!rl.allowed) {
    if (request.method === 'POST') return jsonResponse({ error: 'rate_limited', retryAfter: rl.retryAfterSec }, 429);
    return htmlPage('Too many requests', `<p>Too many requests — please retry sign-in from the extension.</p>`, 429, { 'retry-after': String(rl.retryAfterSec) });
  }
  if (request.method === 'POST') return extAuthorizeWaitPoll(request, env);
  const pollId = String(new URL(request.url).searchParams.get('pt') || '');
  if (!pollId) return htmlPage('Invalid request', `<p>Missing poll id.</p>`, 400);

  let pr;
  try {
    pr = await db.claimPairRequest(env.DB, pollId);
  } catch {
    // Table not present (pre-migration) — degrade gracefully.
    return htmlPage('Not available yet', `<p>One-click email sign-in isn't enabled on this relay yet.</p>`, 501);
  }
  if (!pr) {
    return htmlPage('Link expired', `<p>This sign-in session has expired — please retry from the extension.</p>`, 400);
  }
  if (pr.status === 'ready' && pr.deviceToken) {
    const redirectUri = validExtRedirect(env, pr.redirectUri);
    if (!redirectUri) return htmlPage('Invalid request', `<p>Invalid redirect target.</p>`, 400);
    return redirectResponse(extSuccessRedirect(env, redirectUri, pr.deviceToken, pr.userId, pr.state));
  }
  // Still pending — re-render with a ~2s refresh that re-hits this same URL. The
  // HTTP Refresh header + an in-body meta refresh both target this same /wait?pt=
  // URL, so the next GET re-checks the pair_request (SIGNUP-SPEC §1.5 step 2).
  const waitUrl = '/ext/authorize/wait?pt=' + encodeURIComponent(pollId);
  return htmlPage(
    'Check your email',
    `<meta http-equiv="refresh" content="2;url=${escapeAttr(waitUrl)}" />
     <p>Waiting for you to click the sign-in link… keep this window open.</p>
     <p class="muted">This page checks automatically every couple of seconds.</p>`,
    200,
    { refresh: `2; url=${waitUrl}` }
  );
}

// Tab-poll JSON branch of /ext/authorize/wait (POST {pollId} from the extension,
// every ~2s). RELEASES, never mints: it only hands out a token an authenticated
// sign-in already parked under this pollId, exactly once (consumePairRequest
// deletes the row atomically — a replayed pollId gets nothing). The token rides
// the JSON response BODY, never a URL, so it stays out of access logs (audit T5).
// Pending and unknown/expired are both {status:'pending'} — an unguessable-pollId
// probe learns nothing; the extension applies its own overall timeout.
async function extAuthorizeWaitPoll(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }
  const pollId = validPollId(body && body.pollId);
  if (!pollId) return jsonResponse({ error: 'invalid_poll_id' }, 400);
  let pr;
  try {
    pr = await db.consumePairRequest(env.DB, pollId);
  } catch {
    // Table not present (pre-migration) — the extension falls back to the code path.
    return jsonResponse({ error: 'not_supported' }, 501);
  }
  if (!pr) return jsonResponse({ status: 'pending' });
  // Param names mirror extSuccessRedirect (SIGNUP-SPEC §1.3/§4.1): devicetoken, userId, wssUrl.
  return jsonResponse({
    devicetoken: pr.deviceToken,
    userId: String(pr.userId),
    wssUrl: wssBase(env) + '/ext',
  });
}

// Rendered in the REGULAR sign-in tab once the token is parked (tab-poll flow).
// The extension's poll collects the token and closes this tab best-effort.
function extTabSuccessPage(extraHeaders = {}) {
  return htmlPage(
    'Signed in',
    `<p>✓ Connected. FastLink will finish pairing automatically — this tab closes itself in a moment.</p>
     <p class="muted">If it doesn't, you can close it and return to the FastLink settings page.</p>`,
    200,
    extraHeaders
  );
}

// Extension-generated poll key: base64url/hex, ≥22 chars (≥128 bits at base64url
// density). Anything else is treated as absent so the flow degrades to the
// redirect path instead of trusting a malformed key.
const POLL_ID_RE = /^[A-Za-z0-9_-]{22,128}$/;
function validPollId(raw) {
  const s = String(raw || '');
  return POLL_ID_RE.test(s) ? s : '';
}

// ===========================================================================
// /ext — extension WSS upgrade. Validate the device token (query param,
// because browser WebSocket cannot set request headers), resolve userId, and
// forward the upgrade to that user's Durable Object (the DO acceptWebSocket's).
// ===========================================================================
export async function handleExtUpgrade(request, env) {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('expected websocket upgrade', { status: 426 });
  }
  const token = new URL(request.url).searchParams.get('token');
  const device = await db.lookupDevice(env.DB, token); // { userId, label, revoked } | null
  // Reject AFTER the upgrade with WS close 4401 (not an HTTP 401): a browser
  // WebSocket cannot read the HTTP status of a failed handshake — it just sees a
  // generic 1006. relayClient.js listens for code 4401 as its "token rejected/
  // revoked → stop reconnecting, clear token, prompt re-pair" signal, so emit
  // exactly that. (A thrown DB error still yields an HTTP 500 above, which the
  // extension treats as a transient drop and retries — only a genuinely unknown/
  // revoked token clears the device.)
  if (!device || device.revoked) return wsReject(4401, 'device token rejected');

  // Best-effort last_seen bump (don't block the upgrade on it).
  try { await db.touchDevice(env.DB, token); } catch { /* non-fatal */ }

  const stub = env.USER_RELAY.get(env.USER_RELAY.idFromName(String(device.userId)));
  const u = new URL(request.url);
  u.pathname = '/__ext'; // tag so the DO routes this to its WS-accept path
  return stub.fetch(new Request(u, request)); // pass the Upgrade through unchanged
}

// Revoke a device everywhere: mark it revoked in D1 AND signal the owner's DO to
// close any LIVE socket for that token with WS code 4401 (so the extension clears
// the token + prompts re-pair immediately, not on next dial). Cold revoke (device
// offline) is a D1-only no-op at the DO. Call this from a revoke UI/endpoint.
export async function revokeDeviceAndClose(env, deviceToken) {
  const device = await db.lookupDevice(env.DB, deviceToken);
  await db.revokeDevice(env.DB, deviceToken);
  if (device && device.userId) {
    try { await db.logAudit(env.DB, device.userId, 'device_revoke', { tokenSuffix: String(deviceToken).slice(-4) }); } catch { /* non-fatal */ }
    try {
      const stub = env.USER_RELAY.get(env.USER_RELAY.idFromName(String(device.userId)));
      const u = new URL('https://relay.internal/__revoke'); // DO routes by pathname; host is ignored
      u.searchParams.set('token', deviceToken);
      await stub.fetch(new Request(u.toString(), { method: 'POST' }));
    } catch { /* DO offline / device not connected — already revoked in D1 */ }
  }
  return { revoked: true };
}

// ===========================================================================
// Identity plumbing (isolated so the upstream IdP can be swapped)
// ===========================================================================
function identityMode(env) {
  const raw = env.IDENTITY_MODE || (env.UPSTREAM_OAUTH_CLIENT_ID ? 'google' : 'shared');
  // Accept the architect's canonical 'magiclink' as an alias of internal 'magic'.
  return raw === 'magiclink' ? 'magic' : raw;
}

function sharedUserId(env) {
  return env.SHARED_USER_ID || 'shared-user';
}

// The shared/bootstrap-mode secret. Canonical name is OWNER_SECRET (per SPEC §8);
// SHARED_SECRET accepted as an alias so already-wired configs keep working.
function ownerSecret(env) {
  return env.OWNER_SECRET || env.SHARED_SECRET || '';
}

// Deterministic userId from an email — sha256(normalized email) hex. Stable across
// logins, so the same human (any number of claude.ai sessions / browsers) maps to one
// DO. THE single place identity is derived; swap this to change the identity model.
async function resolveUserId(email) {
  const norm = normalizeEmail(email);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm));
  return hex(new Uint8Array(buf));
}

// Light normalization: trim + lowercase. (We deliberately do NOT collapse gmail dots
// etc. — keep it predictable; one canonical form per typed address.)
function normalizeEmail(email) {
  if (!email) return '';
  const e = String(email).trim().toLowerCase();
  // Minimal sanity check — a single @ with non-empty local/domain parts.
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : '';
}

// Send the magic-link email. Abstracted so the provider is swappable; default is
// Resend (https://resend.com). Reads MAIL_API_KEY (preferred) or RESEND_API_KEY, and
// MAIL_FROM (default login@ytx.app). Throws on misconfig / send failure.
async function sendMagicLink(env, email, url) {
  const key = env.MAIL_API_KEY || env.RESEND_API_KEY;
  const from = env.MAIL_FROM || 'login@ytx.app';
  if (!key) throw new Error('no mail API key configured (set MAIL_API_KEY / RESEND_API_KEY)');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: `FastLink <${from}>`,
      to: [email],
      subject: 'Your FastLink sign-in link',
      html: `<p>Click to sign in to FastLink:</p>
             <p><a href="${escapeAttr(url)}">Sign in</a></p>
             <p>This link expires in 15 minutes. If you didn't request it, ignore this email.</p>`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`mail provider ${res.status} ${body.slice(0, 200)}`);
  }
}

function relayBase(env) {
  // e.g. https://relay.example.com  (no trailing slash)
  return String(env.RELAY_BASE || '').replace(/\/+$/, '');
}

function wssBase(env) {
  return relayBase(env).replace(/^http/i, 'ws'); // https->wss, http->ws
}

function googleAuthUrl(env, state) {
  const params = new URLSearchParams({
    client_id: env.UPSTREAM_OAUTH_CLIENT_ID,
    redirect_uri: relayBase(env) + '/authorize/callback',
    response_type: 'code',
    scope: 'openid email',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

// Exchange a Google auth code for identity. Returns { sub, email }.
async function exchangeGoogleCode(env, code) {
  const body = new URLSearchParams({
    code,
    client_id: env.UPSTREAM_OAUTH_CLIENT_ID,
    client_secret: env.UPSTREAM_OAUTH_CLIENT_SECRET,
    redirect_uri: relayBase(env) + '/authorize/callback',
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`google token endpoint ${res.status}`);
  const tok = await res.json();
  if (!tok.id_token) throw new Error('no id_token from Google');
  // The id_token came directly from Google's token endpoint over TLS, so its
  // payload is trustworthy without re-verifying the signature here.
  const claims = decodeJwtPayload(tok.id_token);
  if (!claims || !claims.sub) throw new Error('id_token missing sub');
  return { sub: String(claims.sub), email: claims.email || null };
}

function decodeJwtPayload(jwt) {
  try {
    const seg = jwt.split('.')[1];
    return JSON.parse(b64urlDecodeStr(seg));
  } catch {
    return null;
  }
}

// ===========================================================================
// Signed state (HMAC-SHA256) — tamper-proof round-trip through the upstream IdP
// ===========================================================================
async function hmacKeyFromSecret(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function signWith(secret, obj) {
  const data = b64urlEncodeStr(JSON.stringify(obj));
  const key = await hmacKeyFromSecret(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return data + '.' + b64urlEncodeBytes(sig);
}

async function verifyWith(secret, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const key = await hmacKeyFromSecret(secret);
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', key, b64urlToBytes(sig), new TextEncoder().encode(data));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    return JSON.parse(b64urlDecodeStr(data));
  } catch {
    return null;
  }
}

// FAIL CLOSED: refuse to sign/verify on a missing or known-default secret rather
// than silently running insecure (security audit S1). A thrown error is caught by
// makeDefaultHandler → 500, so a misconfigured deploy fails loudly instead of
// accepting forgeable state / magic-link tokens. For `wrangler dev`, put the
// secret in .dev.vars.
const INSECURE_DEFAULT = 'dev-insecure-secret-change-me';
function requireSecret(value, name) {
  if (!value || value === INSECURE_DEFAULT) {
    throw new Error(`${name} is not configured — set it via "wrangler secret put ${name}" (refusing to run on an insecure default)`);
  }
  return value;
}

// OAuth round-trip state is signed with COOKIE_SECRET (required).
const cookieSecret = (env) => requireSecret(env.COOKIE_SECRET, 'COOKIE_SECRET');
const signState = (env, obj) => signWith(cookieSecret(env), obj);
const verifyState = (env, token) => verifyWith(cookieSecret(env), token);

// ---------------------------------------------------------------------------
// Pairing session cookie (shared mode): after the owner proves OWNER_SECRET at
// /pair/new, persist a SIGNED, short-TTL cookie so re-typing the secret for the
// next code is unnecessary. Signed with COOKIE_SECRET (same HMAC as signState),
// HttpOnly+Secure+SameSite=Lax, scoped to /pair, 30-min hard expiry baked into
// the payload AND the cookie Max-Age. It only persists a prior secret success —
// it never substitutes for the secret for a first-time/cookieless visitor.
const PAIR_SESSION_TTL_SEC = 1800; // 30 minutes

function parseCookies(request) {
  const out = {};
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

async function pairSessionCookie(env) {
  const token = await signState(env, { p: 'pair', exp: Date.now() + PAIR_SESSION_TTL_SEC * 1000 });
  return `fl_pair=${token}; HttpOnly; Secure; SameSite=Lax; Path=/pair; Max-Age=${PAIR_SESSION_TTL_SEC}`;
}

async function hasPairSession(request, env) {
  const token = parseCookies(request)['fl_pair'];
  if (!token) return false;
  const st = await verifyState(env, token);
  return !!(st && st.p === 'pair' && st.exp && st.exp > Date.now());
}

// Magic-link tokens are signed with MAGICLINK_SECRET. In MAGIC mode the token IS
// the authentication, so we FAIL CLOSED (audit M3): require a dedicated, strong
// MAGICLINK_SECRET — reject the COOKIE_SECRET fallback and reject a short value, so
// a forgeable-login misconfig 500s instead of silently downgrading. In non-magic
// modes (magic links are dormant) the COOKIE_SECRET fallback is still accepted.
function magicSecret(env) {
  if (identityMode(env) === 'magic') {
    const v = requireSecret(env.MAGICLINK_SECRET, 'MAGICLINK_SECRET');
    if (env.COOKIE_SECRET && v === env.COOKIE_SECRET) {
      throw new Error('MAGICLINK_SECRET must be distinct from COOKIE_SECRET in magic mode (refusing to sign login tokens with the cookie key)');
    }
    if (v.length < MAGICLINK_MIN_LEN) {
      throw new Error(`MAGICLINK_SECRET must be at least ${MAGICLINK_MIN_LEN} characters in magic mode (the magic link is the login credential)`);
    }
    return v;
  }
  return requireSecret(env.MAGICLINK_SECRET || env.COOKIE_SECRET, 'MAGICLINK_SECRET (or COOKIE_SECRET)');
}
const signMagic = (env, obj) => signWith(magicSecret(env), obj);
const verifyMagic = (env, token) => verifyWith(magicSecret(env), token);

// Constant-time string comparison (avoids leaking the shared secret via timing).
function timingSafeEqual(a, b) {
  const ab = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));
  // Compare a fixed-length digest so length itself doesn't branch early.
  let res = ab.length === bb.length ? 0 : 1;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) res |= (ab[i] || 0) ^ (bb[i] || 0);
  return res === 0;
}

// ===========================================================================
// Rate limiting (audit M2/M5) — fixed-window counters in D1 (db.hitRateLimit).
// FAIL OPEN: if the limiter DB errors or the IP/DB is unavailable, allow the
// request rather than locking users out of a live relay. The audit accepts the
// residual brute-force risk; the goal here is flood/cost control, not a hard gate.
// ===========================================================================

// Best-effort client IP (Cloudflare sets CF-Connecting-IP; X-Forwarded-For is a
// fallback). '' when unavailable (e.g. local dev) → IP-dimension checks are skipped.
function clientIp(request) {
  if (!request || !request.headers) return '';
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf.trim();
  const xff = request.headers.get('X-Forwarded-For');
  return xff ? String(xff).split(',')[0].trim() : '';
}

// Generic per-IP limiter. `scope` namespaces the bucket. Returns { allowed, retryAfterSec }.
export async function ipRateLimit(env, request, scope, limit, windowSec) {
  const ip = clientIp(request);
  if (!env || !env.DB || !ip) return { allowed: true, retryAfterSec: 0 };
  try {
    const r = await db.hitRateLimit(env.DB, `${scope}:ip:${ip}`, limit, windowSec);
    return { allowed: r.allowed, retryAfterSec: r.retryAfterSec };
  } catch {
    return { allowed: true, retryAfterSec: 0 }; // fail open on limiter error
  }
}

// Magic-link send limiter (M2): caps by email AND client IP. The email cap is the
// primary anti-bombing control (applies even when no IP is available). Returns
// { allowed, retryAfterSec }; the most-restrictive tripped bucket wins.
export async function magicSendLimit(env, email, request) {
  if (!env || !env.DB) return { allowed: true, retryAfterSec: 0 };
  const buckets = [];
  if (email) buckets.push([`magicsend:email:${email}`, MAGIC_EMAIL_LIMIT]);
  const ip = clientIp(request);
  if (ip) buckets.push([`magicsend:ip:${ip}`, MAGIC_IP_LIMIT]);
  for (const [bucket, limit] of buckets) {
    try {
      const r = await db.hitRateLimit(env.DB, bucket, limit, RL_WINDOW_SEC);
      if (!r.allowed) return { allowed: false, retryAfterSec: r.retryAfterSec };
    } catch { /* fail open on limiter error */ }
  }
  return { allowed: true, retryAfterSec: 0 };
}

// Open DCR limiter (M2): the library's /oauth/register is unauthenticated; cap it
// by IP. Called from index.js BEFORE the OAuthProvider sees the request.
export const registerRateLimit = (env, request) =>
  ipRateLimit(env, request, 'register', REGISTER_IP_LIMIT, RL_WINDOW_SEC);

// ===========================================================================
// Random codes / tokens
// ===========================================================================
function randomCode() {
  const r = crypto.getRandomValues(new Uint8Array(CODE_LEN));
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[r[i] % CODE_ALPHABET.length];
  return out;
}

function randomToken() {
  return b64urlEncodeBytes(crypto.getRandomValues(new Uint8Array(DEVICE_TOKEN_BYTES)));
}

// Normalize a user-typed code: uppercase, strip anything not in our alphabet.
function normalizeCode(input) {
  if (!input) return '';
  const up = String(input).toUpperCase().replace(/[^0-9A-Z]/g, '');
  // Drop characters outside our alphabet (e.g. accidental I/O/L/U typos won't match anyway).
  let out = '';
  for (const ch of up) if (CODE_ALPHABET.includes(ch)) out += ch;
  return out.length === CODE_LEN ? out : out; // length-checked at claim time via DB miss
}

// ===========================================================================
// base64url helpers
// ===========================================================================
function b64urlEncodeBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlEncodeStr(str) {
  return b64urlEncodeBytes(new TextEncoder().encode(str));
}

function b64urlDecodeStr(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}

function hex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

// ===========================================================================
// HTTP response helpers
// ===========================================================================
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      // Extension SW fetches usually bypass CORS via host_permissions, but a
      // permissive header lets a popup page POST /pair/claim too.
      'access-control-allow-origin': '*',
    },
  });
}

// Reject a WebSocket dial by completing the upgrade and immediately closing the
// server side with an application close code the extension can read. Runs at the
// Worker edge (not in the DO), so it uses the plain `server.accept()` path.
function wsReject(code, reason) {
  const pair = new WebSocketPair();
  const server = pair[1];
  try {
    server.accept();
    server.close(code, reason);
  } catch {
    return new Response('unauthorized', { status: 401 });
  }
  return new Response(null, { status: 101, webSocket: pair[0] });
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    },
  });
}

function htmlPage(title, bodyHtml, status = 200, extraHeaders = {}) {
  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)} — FastLink</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; }
  .code { font: 700 2rem/1.2 ui-monospace, monospace; letter-spacing: .15em; padding: .5rem 0; }
  .code2 { font: .85rem/1.4 ui-monospace, monospace; word-break: break-all; background: #8881; padding: .5rem .6rem; border-radius: 6px; }
  .muted { color: #888; font-size: .9rem; }
  .row { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin: .5rem 0; }
  input[type=password] { font-size: 1rem; padding: .4rem; width: 100%; box-sizing: border-box; }
  button { font-size: 1rem; padding: .5rem 1rem; cursor: pointer; border-radius: 6px; border: 1px solid transparent; }
  button.primary { background: #2b6cee; color: #fff; }
  button.ghost { background: transparent; border: 1px solid #999; color: inherit; }
</style></head><body>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
</body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...extraHeaders } });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}

// Magic-link email-entry form. `action` is the POST target ('/authorize' | '/pair/new');
// `reqToken` (signed OAuth req) is carried as a hidden field for the /authorize flow.
function emailEntryPage(action, reqToken) {
  const hidden = reqToken ? `<input type="hidden" name="req" value="${escapeAttr(reqToken)}" />` : '';
  return htmlPage(
    'Sign in to FastLink',
    `<p>Enter your email and we'll send you a one-time sign-in link.</p>
     <form method="POST" action="${escapeAttr(action)}">
       ${hidden}
       <label>Email<br/>
         <input type="email" name="email" autocomplete="email" required style="width:100%;font-size:1rem;padding:.4rem;box-sizing:border-box" />
       </label>
       <p><button type="submit">Email me a link</button></p>
     </form>`
  );
}
