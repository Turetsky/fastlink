# FastLink feedback — real-world aa.com test (GitHub issue #1)

Source: live testing against **aa.com** (American Airlines) — an Angular Material
app whose booking/passenger form uses **closed-shadow web components**, native
`<select>` dropdowns, and cross-shadow validators.

> **Read this first.** The four findings below came from an **OLDER build** of
> FastLink. Each item has been re-checked against the **current** code (commit
> `883e00a` working tree, 2026-06-10) and carries a **Status** line saying
> whether it is already-resolved, fixed-here, in-progress, or a docs-only item.
> Do not treat these as four open bugs — most are documentation or already
> handled.

---

## Finding #1 — `fast_do` / `fast_click_xy` can't pick native `<select>` options

**Reported behavior (old build):** When `fast_do` targeted a native `<select>`,
it planned "click the dropdown, then click the option," but Chrome renders the
open option list as an **OS-native popup drawn outside page coordinates**. The
synthetic `fast_click_xy` on the option lands on nothing, so every `<select>`
option step was reported as **"not visible on screen."** Typing into text inputs
worked; only the select-option clicks failed.

**Workaround that worked:** Call `fast_select_option` directly. It sets the
native `<select>` by DOM (`field.value = …` + a `change` event) — never opens the
OS popup, so there is no coordinate to miss. It also pierces shadow DOM and
resolves `aria-labelledby` across shadow boundaries, and handles react-select /
Angular-Material / ARIA comboboxes the same way.

**Root cause:** `fast_do`'s planner (`planByImage` in `fast-dxt/server/scout.js`)
only emitted `click`/`type`/`key` steps, and `handleDo`
(`fast-dxt/server/handlers.js`) executed every non-key step by locating a pixel
coordinate (`pointByImage`) and firing `fast_click_xy`. Coordinate-based clicking
is exactly the path that native option popups defeat.

**Status: FIXED HERE** (in `scout.js` + `handlers.js`; no page.js / tools.js
edits). A new step action `select` was added:

- `planByImage` now offers the planner a
  `{"action":"select","target":"<dropdown field>","value":"<option text>"}`
  step and is instructed to use **one** `select` step for **any**
  dropdown/select/combobox value pick (native `<select>`, react-select,
  Angular-Material, web-component menus) instead of a click-dropdown +
  click-option pair. Plain `click` is reserved for non-select controls.
- `handleDo` routes `select` steps through `fast_select_option`
  (`{ field, option }`) — a DOM-based, shadow-piercing call with **no
  coordinate**. `select` steps are excluded from the vision point-lookup
  (`locatable`) and do not advance the coordinate index (handled like `key`,
  with an early `continue`). Results record `{ picked, kind }` on success or land
  in `skipped` with the underlying error.

This is strictly more robust than the old click-the-option path: it fixes native
selects *and* improves custom dropdowns, since `fast_select_option` already
handles both.

`node --check` passed on both edited files.

> NOTE on detection: the planner cannot reliably tell a native `<select>` from a
> visually identical custom dropdown in a screenshot. That's fine — `select` is
> routed to `fast_select_option`, which handles **both**, so the planner only
> needs to recognize "this is a dropdown value pick," not the implementation.

---

## Finding #2 — shadow-DOM piercing: which tools reach OPEN vs CLOSED roots

**Reported behavior (old build):** `fast_evaluate` "couldn't see closed shadow
roots" while `fast_snapshot` / `fast_select_option` / `fast_fill` "did reach
them."

**Re-check against current code — important correction.** The DOM-walk tools
(`fast_snapshot`, `fast_select_option`, `fast_fill_form`/`fast_fill`) recurse
shadow roots via `walkDeep` in `fast-ext/src/actions/page.js`, which descends
through `el.shadowRoot`. **`el.shadowRoot` is `null` for a `mode:'closed'`
root**, so the pure-JS DOM-walk reaches **OPEN** shadow roots but **NOT closed**
ones. There is no `chrome.dom.openOrClosedShadowRoot` / CDP-DOM call in the
walkers today.

So the old framing ("they reach closed roots") is **not accurate for the current
build**. What's really going on:

- The DOM-walk tools auto-descend **open** shadow roots; a naive
  `document.querySelector(...)` you write inside `fast_evaluate` descends
  **neither** open nor closed roots (no recursion). That contrast — walker vs.
  hand-written flat query — is most likely what was observed; aa.com's relevant
  roots were probably **open**.
- For genuinely **closed** roots, the only tools that interact are the
  **coordinate / CDP layer** (`fast_click_xy`, `fast_type`, `fast_key` go through
  `chrome.debugger` Input dispatch in `fast-ext/src/actions/input.js`, and the
  vision tools), because those operate on rendered pixels, not DOM traversal.

### Per-tool shadow-DOM piercing matrix (current build)

| Tool | Open shadow root | Closed shadow root | Mechanism |
|---|---|---|---|
| `fast_snapshot` | ✅ auto (walkDeep) | ❌ (`el.shadowRoot` null) | JS DOM walk |
| `fast_select_option` | ✅ auto (walkDeep `findField`, resolves `aria-labelledby` across boundaries) | ❌ | JS DOM walk |
| `fast_fill` / `fast_fill_form` | ✅ auto (walkDeep) | ❌ | JS DOM walk |
| `fast_evaluate` | ⚠️ only if YOU write shadow-recursive code (plain `querySelector` does not) | ❌ (closed roots not JS-traversable at all) | user JS in MAIN world / CDP `Runtime.evaluate` |
| `fast_click_xy` / `fast_type` / `fast_key` | ✅ | ✅ (operates on rendered coords) | CDP `Input.*` via `chrome.debugger` |
| `fast_point` / `fast_locate` / `fast_do` (vision) | ✅ | ✅ (sees rendered pixels) | screenshot + Gemini → coords |

**Takeaways / guidance:**
- For elements in a **closed** shadow root, prefer the **coordinate/vision**
  tools (`fast_do`, `fast_point`+`fast_click_xy`, `fast_type`) — the DOM-walk
  tools are blind to them.
- For elements in an **open** shadow root, the DOM-walk tools are best
  (instant, structured, label-aware). Don't reach for `fast_evaluate` +
  `querySelector` and expect it to pierce — write explicit recursion or just use
  `fast_snapshot`/`fast_select_option`.

**Status: DOCUMENTED (no code change needed).** The matrix above is the
deliverable. Optional future enhancement: have the walkers use the
extension-only `chrome.dom.openOrClosedShadowRoot()` to also descend **closed**
roots from a content script — that would let `fast_snapshot`/`fast_select_option`
reach closed roots by DOM. (Not implemented; would touch `page.js`, owned by the
composedfix agent right now.)

---

## Finding #3 — cross-shadow validators need `composed:true` events

**Reported behavior:** Setting a value fired a `change`/`input` event that did
**not** cross the shadow boundary, so an Angular-Material composite control whose
validator listens **outside** the inner control's shadow root never
re-validated — the field looked filled but stayed "invalid."

**Workaround:** dispatch value-change events with `{ composed: true }` so they
propagate across shadow boundaries.

**Status: IN PROGRESS — handled by the `composedfix` agent.** That agent is
adding `composed:true` to the value-change events across the fill/select paths in
`fast-ext/src/actions/page.js` and syncing the tool descriptions in both
`tools.js` files. Note the committed `fast_select_option` native-`<select>` path
**already** dispatches `new Event('change', { bubbles: true, composed: true })`
(see `page.js` `setOne`); composedfix is extending the same treatment to the
remaining fill paths and documenting it. **No action needed in this work** — left
to composedfix to avoid file collisions.

---

## Finding #4 — `fast_locate` off-viewport + screenshot DPR foot-gun

### 4a. `fast_locate` returns `found:false` for targets scrolled out of viewport

**Reported behavior:** When the target was below the fold, `fast_locate` returned
`found:false`, forcing manual scroll-then-relocate loops.

**Re-check:** `handleLocate` (`handlers.js`) races a **DOM tier** (full snapshot,
`viewport:false` — so it *does* find off-viewport elements that are DOM-text
matchable) against a **vision tier** (single viewport screenshot, no scroll).
The vision tier only sees the current viewport, so a **visual-only** target below
the fold still returns `found:false`. `handleLocate` has **no scroll option** and
does not pass one to `pointOnce`.

By contrast, **`fast_point` already supports opt-in `scroll:true`**, which runs up
to 4 wheel-scroll-then-relocate passes (`handlePoint`). `fast_locate` does not
expose this.

**Status: STILL OPEN (documented; small follow-up available).** Guidance for now:
for a target you suspect is below the fold and is **not** DOM-matchable, use
`fast_point` with `scroll:true` instead of `fast_locate`, or `fast_scroll` first
then `fast_locate`. Optional follow-up (outside page.js/tools.js, both editable):
add a `scroll` arg to `handleLocate` that, on a not-found vision tier, wheel-
scrolls and re-points — mirroring `handlePoint`'s loop. Not implemented here as
it wasn't required and `fast_point scroll:true` already covers the need.

### 4b. devicePixelRatio scaling — pixel coords read off a screenshot

**The foot-gun:** Screenshots are captured at the device pixel ratio (DPR 1.25 on
the test machine), so a pixel coordinate **read by eye off a saved screenshot
file** is in **device px**, while `fast_click_xy` / `fast_drag_xy` expect
**CSS px**. Passing raw screenshot pixels clicks ~25% too far down/right. Divide
by DPR: `cssX = pixelX / dpr`.

**Status: NOT A BUG — guidance only.** FastLink's own vision tools already handle
this internally: `handleDo`, `pointOnce`/`handlePoint`, and `handlePointSom`
convert Gemini's normalized coords to CSS px via `… * imgW / full.dpr` (the
capture returns `dpr`). The foot-gun only bites a **human/model reading raw
pixels off the screenshot image** and feeding them to `fast_click_xy`. Rule of
thumb: prefer `fast_point`/`fast_locate`/`fast_do` (they return CSS px ready for
`fast_click_xy`); only hand-measure coordinates as a last resort, and then divide
by `dpr` (reported by `fast_screenshot`/`fast_vision_capture`).

---

## Summary

| # | Item | Status |
|---|---|---|
| 1 | `fast_do` routes native `<select>` through click-xy → misses OS popup | **FIXED** — new `select` step → `fast_select_option` (scout.js + handlers.js) |
| 2 | Which tools pierce closed vs open shadow roots | **DOCUMENTED** — matrix above; corrected old claim (DOM-walk reaches OPEN only, not closed) |
| 3 | Cross-shadow validators need `composed:true` events | **IN PROGRESS** — owned by composedfix agent |
| 4a | `fast_locate` off-viewport returns found:false | **OPEN** — use `fast_point scroll:true`; optional `handleLocate` scroll follow-up |
| 4b | Screenshot DPR vs `fast_click_xy` CSS px | **GUIDANCE** — FastLink's vision tools already /dpr internally; only hand-read pixels need it |

### Files changed by this work
- `fast-dxt/server/scout.js` — added `select` action to `planByImage` (prompt +
  parser). `node --check` ✅
- `fast-dxt/server/handlers.js` — `handleDo` executes `select` via
  `fast_select_option`; excluded from vision `locatable`. `node --check` ✅
- **Not touched:** `fast-ext/src/actions/page.js`, `fast-dxt/server/tools.js`,
  `fastlink-relay/tools.js` (owned by composedfix).
