# FastLink CHANGELOG

Running log of every deliberate change to FastLink, newest first. The point is to
**stop the fix→break→refix churn**: before touching something, skim this file to see
what a prior change already fixed, so we don't reintroduce a bug we already solved.

**Format for each entry**

```
## YYYY-MM-DD — <short title>
- **What:** the change, in one or two lines.
- **Why:** the symptom / feedback that prompted it.
- **Files:** the files touched.
- **Watch out:** what this could regress / interacts with (so a future change doesn't undo it).
- **Status:** in code / synced to Windows copy / committed / verified live.
```

Extension changes only take effect after **syncing `fast-ext/` → `C:\Users\yjtur\FastLink\extension\` and reloading at `chrome://extensions`**. Server changes need a Claude Code restart (WSL MCP) or `.mcpb` rebuild (Desktop). Relay changes need `wrangler deploy`.

---

## 2026-07-11 — fast_locate scroll, empty-snapshot iframe hint, update-check tag parse
- **What:** Three fixes.
  1. **`fast_locate` `scroll:true`** — on a not-found vision tier, wheel-scrolls
     and re-points (up to 4 passes), mirroring `handlePoint`'s loop, so
     below-the-fold visual-only targets no longer return `found:false`. Added on
     the server (`handleLocate` → `pointOnce`), the relay, and both tool schemas.
  2. **Empty-snapshot iframe hint** — `fast_snapshot` now attaches a `hint` field
     when the result is near-empty but a large cross-origin iframe is present,
     nudging toward the vision tier (`fast_point`/`fast_fill_vision`) instead of
     leaving the agent to screenshot-and-read.
  3. **Update-check tag parse** — `updateCheck.js` strips an `ext-` tag prefix so
     `1.x` version comparisons against `ext-`-prefixed release tags don't break.
- **Why:** aa.com finding #4a (off-viewport `fast_locate` miss); Apple-setup
  P2/P3/I1 (near-empty snapshot didn't steer to vision); self-hosted auto-update
  tag mismatch.
- **Files:** `fast-dxt/server/handlers.js`, `fast-dxt/server/tools.js`,
  `fastlink-relay/src/composite.js`, `fastlink-relay/tools.js`,
  `fast-ext/src/actions/page.js`, `fast-ext/src/updateCheck.js`.
- **Watch out:** `fast_locate scroll:true` is opt-in (default off) — don't make it
  default or every locate pays the scroll cost. The snapshot `hint` is advisory
  only; don't gate behavior on it. `updateCheck.js` tag stripping assumes the
  `ext-` prefix scheme — revisit if the release tag format changes.
- **Status:** committed + released as extension v0.4.3 (signed .crx +
  `updates.xml` bumped); synced to Windows copy — needs extension reload +
  Claude Code restart to take effect locally; relay deployed (`wrangler deploy`,
  2026-07-12).

## 2026-07-11 — issue-doc reconciliation (retroactive)
- **What:** Verified the following against current code and closed/deleted their
  issue docs (git history retains the deleted files):
  - **ISSUES-2026-06-08 #1–7** — all fixed (doc self-confirmed; deleted).
  - **BUG-1** (empty-string fill dropped) — fixed; fills now write empty strings
    through the same path (confirmed in the BUG-2 doc's session note).
  - **BUG-2** (batch inter-step rebind) — fixed; `settleIfNavigated` +
    urlBefore/after detection in `runBatch` (both `fast-dxt/server/handlers.js`
    and `fastlink-relay/src/mcp.js`), keyed off ACTUAL navigation. Doc deleted.
  - **BUG-3** — fixed (closed alongside the batch/fill work). Doc deleted.
  - **BUG-4** (fill_form response path) — fixed; `fast_fill_form` races `withSnap`
    against a `HANDLER_CAP_MS=8000` hard cap, `withSnap` bounded/non-fatal
    (`fast-ext/src/actions/page.js`). Doc deleted.
  - **aa.com #3** — `composed:true` shipped: fill/select paths dispatch
    `input`/`change` with `{bubbles:true, composed:true}` (`page.js`).
  - **FEEDBACK 06-21 #1** post-action snapshot (`withSnap` → `snapshotFresh:true`)
    + **#6** profile discoverability (`fast_profile` + `fast_status`
    `selectedInstall`, commit `0aa05f0`).
  - **FEEDBACK 06-24 P4** Gemini retry/backoff+OpenRouter fallback (`scout.js`);
    **P5** `fast_type` `force`/`allowIframe` (`input.js`); **P6** `fast_screenshot`
    `fresh` (`screenshot.js`); **P7** `fast_fill_vision` `freshCapture`-default +
    `verifyVisionFills` read-back (`tools.js`/`handlers.js`); **P8** target-tab pin.
- **Why:** The issue docs had drifted behind the code; this entry is the record
  that replaces the three deleted docs (ISSUES-2026-06-08, BUG-2, BUG-4).
- **Files:** deleted `docs/ISSUES-2026-06-08.md`,
  `docs/BUG-2-batch-inter-step-rebind.md`, `docs/BUG-4-fill-form-response-path.md`;
  updated `docs/FEEDBACK-aa-com-2026-06-10.md`, `FEEDBACK_2026-06-21.md`,
  `FEEDBACK_2026-06-24.md` (reconciled status blocks).
- **Still OPEN:** 06-21 #2 (conditional multi-step executor — batch still linear),
  #3 (transparent auto-wake/retry), #4 (atomic hidden-radio label-targeting),
  #5 (`fast_locate` top-N candidates); 06-24 P1 (unified "is FastLink ready?"
  preflight across the local + relay connectors).
- **Status:** documentation only; no code change in this entry.

## 2026-07-08 — Read-aloud widget: hidden by default, toggled from the popup
- **What:** The read-aloud pill no longer auto-mounts on every page. It now mounts
  only when toggled on via a new "🔊 Read aloud on this page" button in the toolbar
  popup (messages `fastlink:read-aloud-toggle` / `fastlink:read-aloud-state` to the
  content script). The ✕ button hides it fully again; removed the dead
  `readAloudEnabled` options flag; neural voices load lazily on first show.
- **Why:** The always-on bottom-right overlay was covering page buttons.
- **Files:** `fast-ext/src/readAloud.js`, `fast-ext/popup.html`, `fast-ext/popup.js`.
- **Watch out:** the popup button hides itself on tabs without a content script
  (chrome:// pages, tabs opened before the extension loaded — reload the tab).
  Shadow-DOM listeners now attach inside `mount()` (recreated per show), and
  `mount()` resets the paint signature so a re-show repaints fully.
- **Status:** in code / synced to Windows copy — needs extension reload at
  `chrome://extensions` to take effect.

## 2026-07-07 — `fast_select_option` react-select targeting fix
- **What:** Made react-select detection class-prefix-agnostic and scoped option
  matching to the specific react-select instance.
  1. Detect the control with `[class*="select__control"]` (covers both the default
     `react-select__control` prefix AND `select__control`, which Greenhouse uses),
     plus a structural fallback via the `react-select-<N>-input` id for any other
     custom prefix.
  2. New `containerLabel()` helper resolves a field's human label from a sibling
     `<label>` in the same field group — rescues inputs whose only `aria-label` is
     an opaque internal id (`question_6132162009`, `gender`, `veteran_status`).
  3. Option lookup now queries `[id^="react-select-<N>-option"]`, so it can only
     return THIS control's options and can never fall back to another react-select
     on the page.
- **Why:** Reported by the Claude-fellowship (Greenhouse form) session: on that form
  `fast_select_option` failed for every dropdown ("no matching option in listbox /
  no listbox detected") and, worse, returned the **phone-country widget's** dial-code
  list — because the old code matched only `.react-select__control`, missed
  Greenhouse's `select__` prefix, fell through to the generic ARIA branch, and there
  grabbed the first react-select's options on the page.
- **Files:** `fast-ext/src/actions/page.js` (containerLabel helper, findField label
  loop, react-select branch of `fast_select_option`).
- **Watch out:** `containerLabel` deliberately stops climbing when an ancestor holds
  >1 `<label>` (a form section, not a field) — don't loosen that or unrelated labels
  will match. The instance-scoped `[id^="react-select-N-option"]` query assumes the
  default react-select option-id scheme; the id-derived `-listbox` and
  `[class*="select__menu"]` fallbacks cover non-standard builds. Native `<select>`
  and generic-ARIA-listbox branches are untouched.
- **Status:** committed + pushed (`0aa05f0`), synced to Windows copy. Needs extension
  reload + live retest on the Greenhouse form.

## 2026-07-07 — `fast_upload` (file upload without the OS picker)
- **What:** New tool `fast_upload` that sets file(s) on a `<input type=file>` via the
  trusted CDP `DOM.setFileInputFiles` (fires input/change), bypassing the native OS
  file-picker that browser automation can't drive. Windows-path aware: accepts a
  Windows path (`C:\...`), a WSL mount path (`/mnt/c/...`), or a native WSL path
  (`/home/...`) — the WSL server resolves each to a path the Windows Chrome process
  can open (native WSL → `\\wsl.localhost\<distro>\...` via `wslpath`) and verifies it
  exists first. Targeting by `selector` / `text` / `index`, default = the page's only
  file input. Returns `{ uploaded, accepted:[{name,size,type}], input }`.
- **Why:** User request ("drop in a file upload feature, make it work from Windows");
  also the exact "nice-to-have" the fellowship session asked FastLink for.
- **Files:** `fast-ext/src/actions/upload.js` (new), `fast-ext/src/actions/index.js`
  (wire), `fast-dxt/server/handlers.js` (`handleUpload` + `wslpath` path resolver +
  add to MUTATING_TOOLS), `fast-dxt/server/tools.js` (schema),
  `fastlink-relay/tools.js` (mirror schema), `fastlink-relay/src/mcp.js` (mark
  mutating), overlay/background/sidepanel ("Uploading file" label).
- **Watch out:** Requires "Advanced control" (CDP) enabled — same gate as
  `fast_click_xy`. Searches the TOP document only (not cross-origin iframes). The
  extension-side `winifyPath` is idempotent (safe on already-Windows paths) so the
  relay passthrough handles `/mnt/c` and `C:/` too; native-WSL translation only
  happens server-side (WSL MCP), not on the relay.
- **Status:** committed + pushed (`0aa05f0`), synced to Windows copy. Needs extension
  reload + Claude Code restart (to expose the new tool) before it's callable.

---

## Pre-existing in-flight work (bundled into commit `0aa05f0`, 2026-07-07)

The tree already carried a large body of **uncommitted** changes when this log
started (~997 insertions across 24 files) — now committed together with the above in
`0aa05f0` (they were entangled in the same files, so couldn't be split cleanly). Not
written entry-by-entry because they predate the log. High level, so we don't
accidentally revert them:

- **BUG-5 multi-install routing** — arbitrary N Chrome profiles via slot labels
  (`fast_profile`, `fast_status` selectedInstall); broker demux by label.
  See `docs/BUG-5-multi-install-routing.md`. Touches `fast-dxt/broker/*`,
  `server/handlers.js`, `server/config.js`, `options.*`, `connection.js`.
- **scout.js** — substantial additions (~+200 lines).
- **Read-aloud / Edge neural TTS** — new `fast-ext/src/readAloud.js`,
  `fast-ext/src/edgeTts.js` (untracked).
- Feedback logs `FEEDBACK_2026-06-21.md`, `FEEDBACK_2026-06-24.md` (untracked).

> These should be reviewed and committed in logical chunks so the history reflects
> them; until then, treat them as load-bearing and don't overwrite.
