// src/db.js — D1 query helpers for the FastLink relay.
// Owned by: oauth. Signatures are normative (SPEC.md §3c).
//
// Rules:
//   - Pure async functions; FIRST ARG is always the D1 binding `env.DB`.
//   - No module-level state.
//   - All timestamps are epoch MILLISECONDS (Date.now()), matching 0001_init.sql.
//
// D1 API used: db.prepare(sql).bind(...).run() | .first() | .all()
//   - .run()   -> { success, meta:{ changes, ... } }
//   - .first() -> first row object (or column value if column name passed) | null
//   - .all()   -> { results: [...], success, meta }

const now = () => Date.now();

// --- users -----------------------------------------------------------------

// Insert or update a user. profile may carry { email }.
export async function upsertUser(db, userId, profile = {}) {
  const email = profile && profile.email != null ? String(profile.email) : null;
  await db
    .prepare(
      `INSERT INTO users (user_id, email, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         email = COALESCE(excluded.email, users.email)`
    )
    .bind(String(userId), email, now())
    .run();
}

// --- pairing codes ---------------------------------------------------------

// Create a one-time pairing code valid for ttlSec seconds.
// `code` should already be normalized (uppercase, no separators).
export async function createPairingCode(db, userId, code, ttlSec) {
  const expiresAt = now() + Number(ttlSec) * 1000;
  await db
    .prepare(
      `INSERT INTO pairing_codes (code, user_id, expires_at, used_at)
       VALUES (?, ?, ?, NULL)`
    )
    .bind(String(code), String(userId), expiresAt)
    .run();
  return { code: String(code), expiresAt };
}

// Atomically claim a pairing code (single-use). Returns { userId } or null.
// Returns null if the code is unknown, already used, or expired.
export async function claimPairingCode(db, code) {
  const ts = now();
  // Atomic compare-and-set: only flips used_at if currently unused AND unexpired.
  const upd = await db
    .prepare(
      `UPDATE pairing_codes
          SET used_at = ?
        WHERE code = ? AND used_at IS NULL AND expires_at > ?`
    )
    .bind(ts, String(code), ts)
    .run();
  if (!upd.meta || upd.meta.changes !== 1) return null;
  const row = await db
    .prepare(`SELECT user_id FROM pairing_codes WHERE code = ?`)
    .bind(String(code))
    .first();
  return row ? { userId: row.user_id } : null;
}

// --- devices ---------------------------------------------------------------

// Register a paired device with its long-lived bearer token.
export async function createDevice(db, userId, deviceToken, label) {
  await db
    .prepare(
      `INSERT INTO devices (device_token, user_id, label, created_at, last_seen, revoked)
       VALUES (?, ?, ?, ?, NULL, 0)`
    )
    .bind(String(deviceToken), String(userId), label != null ? String(label) : null, now())
    .run();
}

// Resolve a device token -> owning user. Returns { userId, label, revoked } | null.
export async function lookupDevice(db, deviceToken) {
  if (!deviceToken) return null;
  const row = await db
    .prepare(`SELECT user_id, label, revoked FROM devices WHERE device_token = ?`)
    .bind(String(deviceToken))
    .first();
  if (!row) return null;
  return { userId: row.user_id, label: row.label, revoked: !!row.revoked };
}

// Bump last_seen for a device (called on each successful /ext upgrade).
// Not in the original SPEC signature list, but harmless additive helper so
// listDevices() can show meaningful "last connected" data.
export async function touchDevice(db, deviceToken) {
  if (!deviceToken) return;
  await db
    .prepare(`UPDATE devices SET last_seen = ? WHERE device_token = ?`)
    .bind(now(), String(deviceToken))
    .run();
}

// Revoke a device token (extension can no longer dial /ext with it).
export async function revokeDevice(db, deviceToken) {
  await db
    .prepare(`UPDATE devices SET revoked = 1 WHERE device_token = ?`)
    .bind(String(deviceToken))
    .run();
}

// List a user's devices for a management UI. Device token is MASKED (last 4).
export async function listDevices(db, userId) {
  const res = await db
    .prepare(
      `SELECT device_token, label, last_seen, revoked
         FROM devices
        WHERE user_id = ?
        ORDER BY created_at DESC`
    )
    .bind(String(userId))
    .all();
  const rows = (res && res.results) || [];
  return rows.map((r) => ({
    deviceToken: maskToken(r.device_token),
    label: r.label,
    lastSeen: r.last_seen,
    revoked: !!r.revoked,
  }));
}

function maskToken(t) {
  if (!t) return '';
  const s = String(t);
  return s.length <= 4 ? '****' : '****' + s.slice(-4);
}

// --- audit -----------------------------------------------------------------

// Append-only action log. `detail` may be any JSON-serializable value.
export async function logAudit(db, userId, action, detail) {
  let detailStr = null;
  if (detail != null) detailStr = typeof detail === 'string' ? detail : JSON.stringify(detail);
  await db
    .prepare(
      `INSERT INTO grants_audit (user_id, ts, action, detail)
       VALUES (?, ?, ?, ?)`
    )
    .bind(String(userId), now(), String(action), detailStr)
    .run();
}

// --- per-origin consent ----------------------------------------------------

// Returns 'allow' | 'readonly' | 'block' | null (null = never decided).
export async function getSiteConsent(db, userId, origin) {
  const row = await db
    .prepare(`SELECT mode FROM site_consent WHERE user_id = ? AND origin = ?`)
    .bind(String(userId), String(origin))
    .first();
  return row ? row.mode : null;
}

// Set/replace consent for (user, origin). mode: 'allow' | 'readonly' | 'block'.
export async function setSiteConsent(db, userId, origin, mode) {
  await db
    .prepare(
      `INSERT INTO site_consent (user_id, origin, mode, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, origin) DO UPDATE SET
         mode = excluded.mode,
         updated_at = excluded.updated_at`
    )
    .bind(String(userId), String(origin), String(mode), now())
    .run();
}

// List a user's per-origin consent decisions (for the GET /consent management view).
// Returns [{ origin, mode, updatedAt }] ordered most-recently-updated first.
export async function listSiteConsent(db, userId) {
  const res = await db
    .prepare(
      `SELECT origin, mode, updated_at
         FROM site_consent
        WHERE user_id = ?
        ORDER BY updated_at DESC`
    )
    .bind(String(userId))
    .all();
  const rows = (res && res.results) || [];
  return rows.map((r) => ({ origin: r.origin, mode: r.mode, updatedAt: r.updated_at }));
}

// --- fast_evaluate capability flag (per-user, OFF by default) ---------------

// Returns true only if the user has explicitly opted in to fast_evaluate.
export async function getAllowEvaluate(db, userId) {
  const row = await db
    .prepare(`SELECT allow_evaluate FROM users WHERE user_id = ?`)
    .bind(String(userId))
    .first();
  return !!(row && row.allow_evaluate);
}

// Set the per-user fast_evaluate opt-in. Upserts the user row if needed.
export async function setAllowEvaluate(db, userId, allowed) {
  await db
    .prepare(
      `INSERT INTO users (user_id, email, created_at, allow_evaluate)
       VALUES (?, NULL, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET allow_evaluate = excluded.allow_evaluate`
    )
    .bind(String(userId), now(), allowed ? 1 : 0)
    .run();
}

// --- magic links (email sign-in, single-use) --------------------------------

// Record a pending magic link, valid for ttlSec seconds. `jti` is a random id
// embedded in the signed link token; the token itself is never stored.
export async function createMagicLink(db, jti, email, ttlSec) {
  const expiresAt = now() + Number(ttlSec) * 1000;
  await db
    .prepare(
      `INSERT INTO magic_links (jti, email, expires_at, used_at)
       VALUES (?, ?, ?, NULL)`
    )
    .bind(String(jti), String(email), expiresAt)
    .run();
}

// Atomically consume a magic link (single-use). Returns { email } or null if the
// jti is unknown, already used, or expired.
export async function claimMagicLink(db, jti) {
  const ts = now();
  const upd = await db
    .prepare(
      `UPDATE magic_links
          SET used_at = ?
        WHERE jti = ? AND used_at IS NULL AND expires_at > ?`
    )
    .bind(ts, String(jti), ts)
    .run();
  if (!upd.meta || upd.meta.changes !== 1) return null;
  const row = await db
    .prepare(`SELECT email FROM magic_links WHERE jti = ?`)
    .bind(String(jti))
    .first();
  return row ? { email: row.email } : null;
}

// --- pair requests (magic-mode one-click pairing) ---------------------------
// PHASE 2 / DARK (SIGNUP-SPEC §1.6): backs the launchWebAuthFlow self-polling
// wait-page. The auth window can't be completed by a magic link clicked in the
// user's normal tab (different context), so we persist the pending request keyed by
// `pollId`; the link's callback BINDS a minted device token, and the still-open auth
// window (refreshing /ext/authorize/wait → claimPairRequest) performs the final
// redirect. Requires the pair_requests table — NOT YET MIGRATED/DEPLOYED. Call sites
// are try/catch-guarded so a pre-migration relay degrades to "use a pairing code".

// Create a pending pair request valid for ttlSec seconds.
export async function createPairRequest(db, pollId, { redirectUri, state }, ttlSec) {
  const expiresAt = now() + Number(ttlSec) * 1000;
  await db
    .prepare(
      `INSERT INTO pair_requests (poll_id, redirect_uri, state, user_id, device_token, created_at, expires_at, bound_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL)`
    )
    .bind(String(pollId), String(redirectUri), String(state || ''), now(), expiresAt)
    .run();
}

// Bind a minted device token + owning user to a pending request (idempotent-safe:
// only binds a still-pending, unexpired row). Returns true if it transitioned.
export async function bindPairRequest(db, pollId, userId, deviceToken) {
  const ts = now();
  const upd = await db
    .prepare(
      `UPDATE pair_requests
          SET user_id = ?, device_token = ?, bound_at = ?
        WHERE poll_id = ? AND device_token IS NULL AND expires_at > ?`
    )
    .bind(String(userId), String(deviceToken), ts, String(pollId), ts)
    .run();
  return !!(upd.meta && upd.meta.changes === 1);
}

// Read a pair request's status (does NOT delete — the /wait 302 is the terminal step;
// expired rows are swept by the T6 purge). Returns
//   { status:'pending' }
//   | { status:'ready', redirectUri, state, deviceToken, userId }
//   | null (unknown or expired).
export async function claimPairRequest(db, pollId) {
  if (!pollId) return null;
  const row = await db
    .prepare(
      `SELECT redirect_uri, state, user_id, device_token, expires_at
         FROM pair_requests WHERE poll_id = ?`
    )
    .bind(String(pollId))
    .first();
  if (!row) return null;
  if (!row.expires_at || row.expires_at < now()) return null; // expired
  if (!row.device_token) return { status: 'pending' };
  return {
    status: 'ready',
    redirectUri: row.redirect_uri,
    state: row.state,
    deviceToken: row.device_token,
    userId: row.user_id,
  };
}

// --- rate limiting (fixed window) -------------------------------------------
// Backs M2 (magic-link send flood / Resend cost) and M5 (/pair/claim +
// /ext/authorize brute force). One bucket per (scope, dimension, value), e.g.
// "magicsend:email:user@x", "claim:ip:1.2.3.4". Read-then-write: a tiny race
// under bursty concurrency may undercount by a hit or two, which is fine for
// throttling. Returns { allowed, count, limit, retryAfterSec }.
export async function hitRateLimit(db, bucket, limit, windowSec) {
  const ts = now();
  const windowMs = Number(windowSec) * 1000;
  const cutoff = ts - windowMs; // a window that started at/before this has rolled over
  const expiresAt = ts + windowMs;

  const row = await db
    .prepare(`SELECT count, window_start FROM rate_limits WHERE bucket = ?`)
    .bind(String(bucket))
    .first();

  let count;
  let windowStart;
  if (!row || row.window_start <= cutoff) {
    // No bucket yet, or the prior window expired → start a fresh window at 1.
    count = 1;
    windowStart = ts;
    await db
      .prepare(
        `INSERT INTO rate_limits (bucket, count, window_start, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(bucket) DO UPDATE SET
           count = excluded.count,
           window_start = excluded.window_start,
           expires_at = excluded.expires_at`
      )
      .bind(String(bucket), count, windowStart, expiresAt)
      .run();
  } else {
    count = row.count + 1;
    windowStart = row.window_start;
    await db
      .prepare(`UPDATE rate_limits SET count = ? WHERE bucket = ?`)
      .bind(count, String(bucket))
      .run();
  }

  const lim = Number(limit);
  const allowed = count <= lim;
  const retryAfterSec = allowed ? 0 : Math.max(1, Math.ceil((windowStart + windowMs - ts) / 1000));
  return { allowed, count, limit: lim, retryAfterSec };
}

// T6 purge helper: drop expired rate-limit buckets. Safe to call from a cron
// trigger alongside magic_links / pairing_codes cleanup. Returns rows deleted.
export async function purgeRateLimits(db) {
  const r = await db.prepare(`DELETE FROM rate_limits WHERE expires_at <= ?`).bind(now()).run();
  return (r && r.meta && r.meta.changes) || 0;
}

// --- operator flag ----------------------------------------------------------

export async function isOperator(db, userId) {
  const row = await db
    .prepare(`SELECT is_operator FROM users WHERE user_id = ?`)
    .bind(String(userId))
    .first();
  return !!(row && row.is_operator);
}

// Designate (or clear) a user as the relay operator. Upserts the user row.
export async function setOperator(db, userId, isOp) {
  await db
    .prepare(
      `INSERT INTO users (user_id, email, created_at, is_operator)
       VALUES (?, NULL, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET is_operator = excluded.is_operator`
    )
    .bind(String(userId), now(), isOp ? 1 : 0)
    .run();
}

// --- BYO Gemini key (encrypted at rest, AES-GCM) ----------------------------
// keyEncSecret comes from env.KEY_ENC_SECRET (passed in by the caller so db.js
// stays free of module-level state/secrets). Returns the decrypted key or null.

export async function getUserGeminiKey(db, userId, keyEncSecret) {
  const row = await db
    .prepare(`SELECT gemini_key_enc FROM users WHERE user_id = ?`)
    .bind(String(userId))
    .first();
  if (!row || !row.gemini_key_enc) return null;
  try {
    return await aesGcmDecrypt(row.gemini_key_enc, keyEncSecret);
  } catch {
    return null; // unreadable (wrong/rotated KEY_ENC_SECRET) — treat as no key
  }
}

// Store (or clear, when key is falsy) a user's Gemini key, encrypted at rest.
export async function setUserGeminiKey(db, userId, key, keyEncSecret) {
  const enc = key ? await aesGcmEncrypt(String(key), keyEncSecret) : null;
  await db
    .prepare(
      `INSERT INTO users (user_id, email, created_at, gemini_key_enc)
       VALUES (?, NULL, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET gemini_key_enc = excluded.gemini_key_enc`
    )
    .bind(String(userId), now(), enc)
    .run();
}

// --- fast_evaluate policy (allowlist) ---------------------------------------

// Composite policy for relay-core's gate. fast_evaluate fires only when
// allowEvaluate && (allowAll || origin ∈ origins). allowAll is operator-only.
export async function getEvalPolicy(db, userId) {
  const u = await db
    .prepare(`SELECT allow_evaluate, eval_allow_all, is_operator FROM users WHERE user_id = ?`)
    .bind(String(userId))
    .first();
  const res = await db
    .prepare(`SELECT origin FROM eval_allowed_origins WHERE user_id = ?`)
    .bind(String(userId))
    .all();
  const origins = ((res && res.results) || []).map((r) => r.origin);
  const isOp = !!(u && u.is_operator);
  return {
    allowEvaluate: !!(u && u.allow_evaluate),
    // allow_all only honored for the operator — strangers can never get blanket eval.
    allowAll: isOp && !!(u && u.eval_allow_all),
    isOperator: isOp,
    origins,
  };
}

export async function setEvalAllowAll(db, userId, allowAll) {
  await db
    .prepare(
      `INSERT INTO users (user_id, email, created_at, eval_allow_all)
       VALUES (?, NULL, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET eval_allow_all = excluded.eval_allow_all`
    )
    .bind(String(userId), now(), allowAll ? 1 : 0)
    .run();
}

export async function addEvalOrigin(db, userId, origin) {
  await db
    .prepare(
      `INSERT INTO eval_allowed_origins (user_id, origin, added_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, origin) DO NOTHING`
    )
    .bind(String(userId), String(origin), now())
    .run();
}

export async function removeEvalOrigin(db, userId, origin) {
  await db
    .prepare(`DELETE FROM eval_allowed_origins WHERE user_id = ? AND origin = ?`)
    .bind(String(userId), String(origin))
    .run();
}

// --- AES-GCM helpers (encrypt-at-rest for the BYO Gemini key) ---------------
// Key is derived from keyEncSecret via SHA-256 (32-byte AES-256 key). Output is
// base64( iv(12) || ciphertext+tag ). Throws if keyEncSecret is missing.

async function aesKey(keyEncSecret) {
  if (!keyEncSecret) throw new Error('KEY_ENC_SECRET not configured');
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(keyEncSecret)));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function aesGcmEncrypt(plaintext, keyEncSecret) {
  const key = await aesKey(keyEncSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return bytesToB64(out);
}

async function aesGcmDecrypt(b64, keyEncSecret) {
  const key = await aesKey(keyEncSecret);
  const buf = b64ToBytes(b64);
  const iv = buf.slice(0, 12);
  const ct = buf.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToBytes(b64) {
  const bin = atob(String(b64));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
