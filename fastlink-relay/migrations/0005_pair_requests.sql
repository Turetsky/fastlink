-- FastLink Relay — pair_requests (migration v5)
-- Owned by: relay-auth. Backs magic-mode one-click extension sign-in (SIGNUP-SPEC §1.6).
--
-- PHASE 2 / DARK: NOT applied this sprint (hard no-deploy constraint). Apply only
-- in the later deploy window, together with enabling IDENTITY_MODE=magic.
--
-- Why this table exists: chrome.identity.launchWebAuthFlow opens an ISOLATED auth
-- window that only completes when IT navigates to the extension's chromiumapp.org
-- callback. A magic link clicked from the user's email opens in their NORMAL tab —
-- a different context — so it can't complete the auth window. We bridge the two
-- contexts server-side: the auth window serves a self-refreshing wait-page
-- (/ext/authorize/wait?pt=<poll_id>); the emailed link's callback mints a device
-- token and BINDS it here; the still-open wait-page sees the bound token and 302s to
-- chromiumapp.org with the token in the URL fragment.
--
-- Migration number coordinated with `hardening` (0004 = rate_limits → this is 0005).
-- Timestamps are epoch MILLISECONDS (Date.now()).

CREATE TABLE pair_requests (
  poll_id      TEXT PRIMARY KEY,        -- random id; the /ext/authorize/wait?pt= poll key
  redirect_uri TEXT NOT NULL,           -- pre-validated chromiumapp.org extension callback
  state        TEXT,                    -- opaque value echoed back to the extension (CSRF check)
  user_id      TEXT,                    -- NULL until the link is clicked; resolved relay userId
  device_token TEXT,                    -- NULL until bound; minted device bearer (== /pair/claim format)
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,        -- request lifetime (~15 min); expired rows are ignored + purged
  bound_at     INTEGER                  -- NULL until the device token is bound
);
CREATE INDEX idx_pair_requests_expires ON pair_requests(expires_at);
