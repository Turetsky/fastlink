# FastLink — Permissions Justification

For Chrome Web Store review. Each manifest permission below lists **why it is
required**, **how it is used in code**, and (where relevant) **the narrower
fallback** if a reviewer asks us to drop it. FastLink is a developer/automation
tool: it lets the user's own Claude assistant (Claude Code, Claude Desktop, or
claude.ai on the web) read and drive **the user's active tab on the user's
behalf**. It does not run autonomously and takes no action that the user has not
initiated through Claude.

Manifest reference: `manifest.json` → `permissions`, `host_permissions`.

---

## `permissions`

### `tabs`
- **Why:** FastLink must identify, navigate, and manage the tab Claude is
  driving — open a target tab, navigate it, reload it, read its URL/title, and
  notice when it finishes loading.
- **Code:** `src/actions/tab.js` (`chrome.tabs.create/update/reload/remove/get/
  query`, `onUpdated`), `src/actions/targetTab.js` (pinned-target tracking),
  `src/util.js` (active-tab resolution). Tab lifecycle is also observed in
  `src/buffers.js` and `background.js` (`onRemoved`/`onUpdated`) to clean up
  per-tab buffers.
- **Fallback:** None practical. `activeTab` alone cannot navigate or read tab
  metadata for a designated target tab across focus changes.

### `scripting`
- **Why:** FastLink injects a small in-page bridge to build accessibility/DOM
  snapshots and run user-requested page reads. (Most page logic ships as
  declared content scripts; `scripting.executeScript` is used for on-demand
  evaluation and target-tab probes.)
- **Code:** `src/actions/index.js`, `src/util.js`, `src/actions/tab.js`
  (`chrome.scripting.executeScript`).
- **Fallback:** None — required to read page state for the user.

### `activeTab`
- **Why:** Companion to screenshot/scripting for the currently focused tab;
  grants capture rights for the visible tab on user action.
- **Code:** used implicitly by `chrome.tabs.captureVisibleTab` in `src/util.js`.
- **Fallback:** Could be dropped only if `<all_urls>` host permission fully
  covers the active-tab capture case (it does); retained for clarity and as the
  least-privilege capture path.

### `storage`
- **Why:** Persist the user's relay device token and relay config, saved macros,
  the pinned target-tab id, and connection status for the popup.
- **Code:** `chrome.storage.local` in `src/relayClient.js` (deviceToken, relay
  config), `src/actions/macros.js` (user macros), `background.js`/`popup.js`/
  `options.js` (connection state); `chrome.storage.session` in
  `src/actions/targetTab.js` (target-tab pin).
- **Data:** local to the device. The device token is a bearer credential for the
  user's own relay account; no page content is stored here.
- **Fallback:** None.

### `identity`
- **Why:** One-click onboarding — "Sign in to your relay account and pair this
  browser" — without making the user copy/paste a pairing code.
- **Code:** `chrome.identity.launchWebAuthFlow` (extension onboarding/auth UI)
  against the relay's `/ext/authorize` endpoint; the redirect URI is fixed at
  `chrome.identity.getRedirectURL()` →
  `https://<extension-id>.chromiumapp.org/`, and the relay 302s the device token
  back to it.
- **Scope:** Only authenticates the user to **their own** relay account; the
  returned device token is stored in `chrome.storage.local`. FastLink accesses
  no third-party identity/profile data and does not use Chrome sign-in identity.
- **Fallback:** The manual pairing-code flow (paste a one-time code in options)
  remains available, so `identity` enables a smoother path but is not the only
  way to pair.

### `alarms`
- **Why:** MV3 service workers are killed aggressively. A periodic alarm
  (30s) revives the worker to keep the localhost-broker and cloud-relay
  WebSocket connections alive and to reconnect after the worker is recycled.
- **Code:** `src/connection.js`, `src/relayClient.js`, `background.js`
  (`chrome.alarms.create`/`onAlarm`).
- **Fallback:** None — required for reliable MV3 reconnection.

### `webRequest`  *(observational only — NOT `webRequestBlocking`)*
- **Why:** FastLink reports network activity to Claude (the `fast_network` tool)
  and detects "network idle" so Claude can wait for a page to settle before
  acting (`fast_wait`/wait-idle).
- **Code:** `src/buffers.js` registers **read-only** listeners
  (`onBeforeRequest`, `onCompleted`, `onErrorOccurred`); consumed in
  `src/actions/network.js` and `src/actions/waitIdle.js`.
- **Important:** We do **not** request `webRequestBlocking` and never modify,
  redirect, or block any request. We observe request URL + timing metadata only.
- **Fallback:** `chrome.debugger` (CDP `Network` domain) could supply the same
  data, but that is *more* invasive, not less — so the observational
  `webRequest` listeners are the least-privilege choice here.

> **Note:** `debugger` is **not** a required permission — it lives in
> `optional_permissions` and is requested at runtime only when the user opts into
> the power-user features that need it. See the **Optional permissions** section
> below.

---

## `host_permissions: ["<all_urls>"]`
- **Why:** FastLink is a general-purpose automation tool. The user points Claude
  at whatever site they are working on (a cloud console, a CRM, a web app under
  development, etc.). We cannot enumerate the set of hosts ahead of time — it is
  literally "wherever the user asks Claude to act."
- **Mitigations / least-privilege story for review:**
  - Content scripts run **only in the top frame** (`all_frames: false`) and only
    install passive snapshot/console/network hooks.
  - The cloud relay enforces **per-origin consent** server-side: each origin is
    `allow`, `readonly`, or `block` (`site_consent` table). A `readonly` origin
    permits reads (snapshot/text/screenshot) but blocks all mutating actions
    (click/fill/type/key/nav/evaluate/drag/select).
  - Every action is logged to an append-only audit table (`grants_audit`).
  - `fast_evaluate` (arbitrary JS) is **off by default** and gated behind a
    per-user, per-origin allowlist.
- **Fallback:** If the store requires it, FastLink can ship with
  `optional_host_permissions` and request origins on demand, but that materially
  worsens UX for the tool's core purpose. Documented here as the available
  narrowing path.

---

## `optional_permissions`

### `debugger`  *(OPTIONAL — feature-gated, requested at runtime, user-initiated)*
`debugger` is declared in `optional_permissions`, **not** `permissions`. It is
**not** granted at install time. The extension calls
`chrome.permissions.request({ permissions: ['debugger'] })` only when the user
turns on a power-user feature that requires it — so a normal user can install and
use FastLink without ever granting `debugger`, and a reviewer evaluating the
default install sees the extension request it only on explicit user action.

- **What it enables (the two features that need it):**
  1. **Trusted input.** Synthetic DOM events (`element.click()`, dispatched key
     events) are flagged `isTrusted=false` and rejected by many sites/frameworks.
     With `debugger` granted, FastLink uses CDP `Input.dispatchMouseEvent` /
     `Input.dispatchKeyEvent` to deliver **trusted** input so clicks and typing
     behave like a human's.
  2. **Screenshot of non-foreground tabs.** `chrome.tabs.captureVisibleTab` only
     captures the active, visible tab of the focused window. CDP
     `Page.captureScreenshot` is the only way to capture a pinned target tab that
     isn't in the foreground.
- **Graceful fallback when NOT granted:** the extension falls back to
  `chrome.tabs.captureVisibleTab` for screenshots (foreground tab only, subject
  to per-second capture quota) and to synthetic events for input (works on most
  sites; less reliable on strict ones). Core read/snapshot/navigate functionality
  is unaffected.
- **Code:** `src/actions/input.js` (persistent per-tab `chrome.debugger.attach`
  + `sendCommand` for trusted input; auto-detaches on tab close),
  `src/util.js` / `src/actions/screenshot.js` (CDP `Page.captureScreenshot`).
  *(Runtime `chrome.permissions.request` for `debugger` is added by the extension
  auth/onboarding work — ext-auth.)*
- **Scope/limits:** attaches a debugger session **only** to the specific tab
  Claude is actively driving, lazily on first use; never to arbitrary or
  background tabs speculatively.

#### ⚠️ CDP caveats — test before relying on it
- **"…is being debugged" banner.** While a CDP session is attached, Chrome shows
  an infobar in the target tab ("FastLink started debugging this browser"). This
  is expected and is the user-visibility mechanism, but it is visually intrusive
  and can shift page layout/screenshot geometry. *(The code keeps the session
  attached across actions specifically so the banner doesn't toggle and offset
  click coordinates mid-task.)*
- **Anti-bot / anti-fraud detection.** Some sites (banking, ticketing, ad/fraud
  systems) detect an attached debugger / CDP session and may block, challenge, or
  silently degrade behavior. **Test the trusted-input + background-capture path
  against the primary target sites** before depending on `debugger` there; the
  non-debugger fallback may actually work better on hostile origins.

---

## Single-purpose statement
FastLink has **one** purpose: to let the user's own Claude assistant observe and
operate the user's browser tab on the user's behalf (read page content, click,
fill, navigate, and capture console/network diagnostics). All permissions above
exist solely to serve that single purpose.

---

## Stable extension ID (`key` in manifest)
The manifest pins a stable extension ID via the `"key"` field so the ID is
identical across dev (load-unpacked) and the published build. This is required
because `chrome.identity.getRedirectURL()` (and therefore the relay's
`redirect_uri` allowlist) depends on the ID. See `EXTENSION-ID.md` for the ID,
the public key, and where the private signing key is kept. The private key is
**never** included in the package.
