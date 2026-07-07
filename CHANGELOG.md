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
