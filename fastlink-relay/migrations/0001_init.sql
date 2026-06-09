-- FastLink Relay — D1 schema (migration v1)
-- Owned by: oauth. Matches SPEC.md §6 verbatim.
-- Apply with: wrangler d1 migrations apply fastlink-relay
--
-- Timestamp columns are stored as INTEGER epoch MILLISECONDS (Date.now()).

CREATE TABLE users (
  user_id        TEXT PRIMARY KEY,      -- stable id: sha256(email) for magic-link, or IdP sub
  email          TEXT,
  created_at     INTEGER NOT NULL,
  allow_evaluate INTEGER NOT NULL DEFAULT 0,  -- per-user fast_evaluate opt-in (OFF by default)
  eval_allow_all INTEGER NOT NULL DEFAULT 0,  -- operator-only: allow fast_evaluate on ANY origin (test mode)
  is_operator    INTEGER NOT NULL DEFAULT 0,  -- the relay operator (own/trusted); gates allow_all test mode
  gemini_key_enc TEXT                         -- per-user Gemini key, AES-GCM encrypted at rest; NULL => operator key
);

-- Per-user allowlist of origins where fast_evaluate is permitted (non-operator path).
-- fast_evaluate fires only when allow_evaluate AND (eval_allow_all OR origin in this set).
CREATE TABLE eval_allowed_origins (
  user_id   TEXT NOT NULL,
  origin    TEXT NOT NULL,             -- e.g. https://app.example.com
  added_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, origin)
);

CREATE TABLE pairing_codes (
  code        TEXT PRIMARY KEY,         -- short one-time code (normalized: uppercase, no separators)
  user_id     TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,                  -- NULL until claimed (single-use)
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE devices (
  device_token TEXT PRIMARY KEY,        -- long-lived bearer the extension holds (>=128 bits entropy)
  user_id      TEXT NOT NULL,
  label        TEXT,
  created_at   INTEGER NOT NULL,
  last_seen    INTEGER,
  revoked      INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);
CREATE INDEX idx_devices_user ON devices(user_id);

CREATE TABLE site_consent (             -- per-user, per-origin consent (SAFETY)
  user_id     TEXT NOT NULL,
  origin      TEXT NOT NULL,            -- e.g. https://mail.google.com
  mode        TEXT NOT NULL,            -- 'allow' | 'readonly' | 'block'
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, origin)
);

CREATE TABLE grants_audit (             -- append-only action log (SAFETY)
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  action      TEXT NOT NULL,            -- tool name, e.g. fast_click
  detail      TEXT                      -- JSON: {origin, argsSummary, ok}
);
CREATE INDEX idx_audit_user_ts ON grants_audit(user_id, ts);
