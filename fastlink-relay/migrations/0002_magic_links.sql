-- FastLink Relay — magic-link sign-in (migration v2)
-- Owned by: oauth. Supports IDENTITY_MODE=magic (email magic-link, SPEC §4 FINAL).
-- Apply with: wrangler d1 migrations apply fastlink-relay
--
-- A row is created when a sign-in link is emailed and consumed (single-use) when
-- the link is clicked. `jti` is a random id embedded in the signed link token; the
-- token itself (which also carries the OAuth request) is never stored server-side.
-- Timestamps are epoch MILLISECONDS (Date.now()).

CREATE TABLE magic_links (
  jti         TEXT PRIMARY KEY,        -- random id embedded in the signed link token
  email       TEXT NOT NULL,           -- the address the link was sent to
  expires_at  INTEGER NOT NULL,        -- link lifetime (~15 min)
  used_at     INTEGER                  -- NULL until clicked (single-use)
);
CREATE INDEX idx_magic_links_expires ON magic_links(expires_at);
