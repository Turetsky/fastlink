-- FastLink Relay — rate-limit counters (migration v4)
-- Owned by: hardening. Backs audit M2 (magic-link send flood / Resend cost) and
-- M5 (/pair/claim + /ext/authorize brute force) via a simple fixed-window counter.
-- Apply with: wrangler d1 migrations apply fastlink-relay
--
-- One row per (scope, key) bucket, e.g.
--   magicsend:email:user@example.com   magicsend:ip:1.2.3.4
--   claim:ip:1.2.3.4                    register:ip:1.2.3.4
-- `window_start` is the epoch-ms start of the current fixed window; when a hit
-- arrives after window_start + windowMs the counter resets to 1. `expires_at`
-- exists only so the T6 purge can sweep stale buckets. Timestamps are epoch
-- MILLISECONDS (Date.now()), matching the rest of the schema.

CREATE TABLE rate_limits (
  bucket       TEXT PRIMARY KEY,    -- "<scope>:<dimension>:<value>"
  count        INTEGER NOT NULL,    -- hits in the current window
  window_start INTEGER NOT NULL,    -- epoch ms when this window began
  expires_at   INTEGER NOT NULL     -- epoch ms; safe to delete after this (purge)
);
CREATE INDEX idx_rate_limits_expires ON rate_limits(expires_at);
