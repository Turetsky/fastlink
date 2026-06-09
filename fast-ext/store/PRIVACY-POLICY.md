# FastLink — Privacy Policy

_Last updated: 2026-06-08_

FastLink is a browser extension that lets **your own** Claude assistant (Claude
Code, Claude Desktop, or claude.ai on the web) read and operate the browser tab
you point it at, on your behalf. This policy explains exactly what data moves,
where it goes, and what is — and isn't — stored.

**Plain-language summary:** FastLink is a pipe between your browser and your
Claude assistant. It does not sell your data, show ads, profile you, or use your
data to train any model. Page content travels only to the Claude assistant you
have connected, plus (for visual tools) Google's Gemini API, so Claude can do
what you asked it to do.

---

## Who operates FastLink
FastLink is an independent developer tool. The extension connects to one or both
of these back ends, which you choose:

1. **Local broker (default).** A WebSocket server on your own machine
   (`ws://127.0.0.1`) used by Claude Code / Claude Desktop. Data sent this way
   **never leaves your computer** except as part of your normal Claude session.
2. **Cloud relay (optional, only if you pair it).** A Cloudflare-hosted relay
   that lets claude.ai on the web drive your browser. Data sent this way transits
   the relay. See "Cloud relay" below.

---

## What data FastLink handles

### Page / browsing data (only while you have Claude act)
When you ask Claude to do something with a tab, FastLink may capture and send to
your connected Claude assistant:
- **DOM / accessibility snapshots and visible text** of the active/target tab.
- **Screenshots** of the active/target tab.
- **Console messages** from the page (for debugging tools).
- **Network request metadata** — URLs and timing of requests the page makes
  (used for the network log and "wait for idle"). FastLink observes this
  read-only; it never blocks or alters requests.
- **The current tab's URL and title.**

This data is captured **on demand**, to fulfill the action you requested through
Claude. FastLink does not continuously record your browsing.

### Visual (Gemini) processing
Some FastLink tools that locate elements or read screenshots visually
(`fast_scout`, `fast_point`, `fast_fill_vision`, `fast_do`, `fast_locate`) send
the relevant **screenshot/image and your instruction** to Google's Gemini
Generative Language API for processing, then use the result to act on the page.
Screenshots are held in memory as data and returned inline — they are **not**
written to disk by the relay. Google's handling of API requests is governed by
Google's API terms/privacy policy.

### Credentials and configuration (stored locally on your device)
Stored in `chrome.storage.local` / `chrome.storage.session` on your machine:
- A **device token** — a bearer credential identifying this browser to your own
  relay account (only if you pair the cloud relay).
- Relay configuration (relay base URL, your relay user id).
- **Macros** you save.
- The pinned target-tab id and connection status for the toolbar UI.

No page content is persisted in extension storage.

---

## Cloud relay: what it stores
If — and only if — you pair the optional cloud relay, the relay (Cloudflare D1
database) stores the following account/operational data:
- **Account:** a user id (derived as a hash of your sign-in email),
  your email, and account flags.
- **Devices:** your device token(s), an optional device label, and last-seen
  time, so paired browsers can connect and so you can revoke them.
- **Pairing / sign-in:** short-lived one-time pairing codes and magic-link
  records (consumed on use).
- **Per-origin consent:** your `allow` / `readonly` / `block` choice per website
  origin.
- **Audit log:** an append-only record of actions taken (tool name, origin, a
  short argument summary, success/failure) so you can see what was done.
- **Your Gemini API key**, *if you choose to provide one* — stored **encrypted
  at rest** (AES-GCM).

The relay routes live commands and page data between claude.ai and your browser
**in transit**; it does not store your page snapshots, screenshots, or page
content as part of normal operation.

---

## What FastLink does NOT do
- ❌ No selling or renting of your data.
- ❌ No advertising and no ad/tracking networks.
- ❌ No use of your data to train any AI model (FastLink-operated).
- ❌ No analytics/telemetry beyond the operational audit log described above.
- ❌ No background or continuous collection — capture happens only when you have
  Claude act.

---

## Data sharing
Your data is shared only as needed to perform the action you requested:
- with **the Claude assistant you connected** (Anthropic's Claude Code / Desktop /
  claude.ai), governed by Anthropic's terms and privacy policy; and
- with **Google's Gemini API**, for the visual tools listed above, governed by
  Google's terms and privacy policy.

No other third parties receive your data.

---

## Your controls
- **Use local only:** keep using just the localhost broker and never pair the
  relay — nothing leaves your machine via FastLink.
- **Per-origin consent:** set any site to `readonly` (reads only, no actions) or
  `block`.
- **Revoke devices:** revoke a paired browser's device token at any time; the
  relay closes its connection.
- **Unpair / disable:** turn off the cloud relay in the extension options to
  return to local-only operation.
- **Arbitrary-JS execution (`fast_evaluate`) is OFF by default** and must be
  explicitly enabled per origin.

---

## Data retention
- **On-device:** persists until you unpair, clear extension storage, or remove
  the extension.
- **Relay:** account, device, consent, and audit records persist until you
  delete them / revoke; pairing codes and magic-links are short-lived and
  single-use.

---

## Children
FastLink is a developer tool not directed to children and is not intended for
use by anyone under 13.

## Changes
We will update this policy as the product evolves and revise the "Last updated"
date above.

## Contact
Questions or data requests: **support@ytx.app**

---

> **Hosting note (not part of the published policy):** the Chrome Web Store
> listing requires this policy at a public URL. Host this file at a stable URL
> (e.g. a GitHub Pages / the relay site `/privacy`) and put that URL in the
> Developer Dashboard → Privacy tab. Keep the hosted copy in sync with this file.
