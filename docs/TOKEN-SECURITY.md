# Relay device-token security

How the FastLink Chrome extension authenticates to the cloud relay (`/ext`), what
the current exposure is, and the recommended hardening. The logging-redaction
half is **done**; the token-out-of-the-URL half is **not** — it's an auth change
and must be implemented supervised.

## Current model

- Pairing (HTTPS, one-time) mints a long-lived **device token** stored in
  `chrome.storage.local.deviceToken` (see `claimPairingCode` /
  `authorizeViaWebAuthFlow` in `fast-ext/src/relayClient.js`).
- The extension dials the relay with the token in the **URL query string**:
  `wss://relay.ytx.app/ext?token=<TOKEN>` (`connect()` builds this at
  `relayClient.js`). Browsers **cannot** set an `Authorization` (or any custom)
  header on a WebSocket handshake, so today the token has to ride the URL.
- The relay validates it in `fastlink-relay/src/auth.js → handleExtUpgrade`:
  reads `searchParams.get('token')`, looks the device up in D1, and on
  unknown/revoked closes the socket with WS code **4401** (the extension's
  "clear token + prompt re-pair" signal).

### Exposure

- **On the wire:** safe. The connection is TLS (`wss://`), so the query string is
  encrypted in transit — no network sniffer sees the token.
- **Client logs:** the token used to be printable to the browser console via any
  `console.*` that logged the connect URL. **Fixed (this change):** every logged
  string in `relayClient.js` now goes through a `redact()` helper that rewrites
  `token=<value>` to `token=<first4>***`. The live `new WebSocket(url)` still
  uses the **real** token — only logged strings are redacted.
  - **Caveat — not fully fixable from JS:** when a handshake fails, the browser
    itself prints `WebSocket connection to 'wss://relay.ytx.app/ext?token=…'
    failed` to the console, including the full URL. That message is emitted by
    the browser, not our code, and **cannot be intercepted or redacted from
    JavaScript.** This is the exposure the user actually saw, and it is the
    strongest reason to move the token out of the URL entirely (below).
- **Server logs:** Cloudflare / Worker access logs may capture the request URL,
  including `?token=…`, regardless of client-side redaction. Only the hardening
  below removes this.

## Recommended hardening (implement SUPERVISED — it's an auth change)

Move the token **out of the URL** and send it as the **first WebSocket message**
after the socket opens. The handshake URL then carries no secret, so it never
appears in the browser's native failure log or in server access logs.

Browsers cannot set `Authorization` headers on a WS handshake, so the two
standard patterns are:

1. **First-message auth** (recommended here — simplest, fully under our control).
2. `Sec-WebSocket-Protocol` subprotocol smuggling (token as a fake subprotocol).
   Works but abuses a header meant for protocol negotiation and is fiddlier to
   validate; prefer option 1.

### Coordinated change (both sides must ship together)

**Extension — `fast-ext/src/relayClient.js`:**

- `connect()`: dial **without** the token in the URL — just `cfg.wssUrl` (e.g.
  `wss://relay.ytx.app/ext`). No `?token=` appended.
- `ws.onopen`: send the token as the very first frame, e.g.
  `ws.send(JSON.stringify({ type: 'auth', token: cfg.deviceToken }))` — sent
  **before** the existing `hello` frame.
- Keep `redact()` (harmless once the URL has no token; still guards any future
  log that touches the token).

**Relay — `fastlink-relay/src/auth.js → handleExtUpgrade` (+ the DO accept path):**

- Accept the upgrade **without** requiring `?token=`.
- After accept, require the first inbound message to be `{type:'auth', token}`
  **within a short timeout** (e.g. 3–5 s). Validate the token exactly as the
  query path does today (D1 `lookupDevice`, revoked check); on
  absent/invalid/timeout, close with **4401** (same signal the extension already
  handles).
- **Migration fallback:** during rollout, keep the existing query-string token
  path working — if `?token=` is present, validate it the old way; otherwise
  wait for the first-message auth. Drop the query fallback once all extensions
  have updated.

### Why first-message over subprotocol

`Sec-WebSocket-Protocol` is echoed by the server and visible in the handshake
response; it's also length/charset constrained and meant for protocol names.
First-message auth keeps the secret out of every header and URL, is trivial to
rotate, and reuses the relay's existing JSON message plumbing and the 4401 close
signal — no new client error path.

---

**Status:** logging redaction shipped in `relayClient.js`. Token-in-URL →
first-message migration is **not** implemented; do it supervised because a
mistake locks every paired browser out of the relay.
