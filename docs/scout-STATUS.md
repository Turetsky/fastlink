# FastLink Scout — build status & roadmap

The "scout" = a fast model (Gemini 2.5 Flash, direct Generative Language API) that
pre-reads pages and turns Claude's intent into a runnable plan, so Claude stops
burning round-trips discovering page structure. Gemini's job: **find exactly the
element Claude wants AND pick the right tier to hit it.**

## Core flow
```
page loads ──▶ ext (tabs.onUpdated 'complete') ──▶ broker ──▶ MCP server
                                                              prewarmScout():
                                                              snapshot → Gemini
                                                              builds PAGE MAP, caches it
Claude ── fast_scout(intent) ──▶ server: warm map + overlay intent ──▶ plan
        ◀── {brief, steps:[{name,args}], savedActions, warmed} ── straight off the socket
```
Two-stage warmth: page-map comprehension (the expensive read) is cached per
url+content-hash and pre-warmed on load; the per-intent overlay is the only
thing on the critical path. Verified: cold ~2.3s, warm ~0.7s.

## DONE (this session)
- **Direct Gemini provider** (`scout.js`), key `GEMINI_API_KEY` loaded from
  `fastlink-secrets.txt` via `config.js` secrets loader. OpenRouter path removed.
  (The `AQ.`-format Google key works; the Maps `AIza` key is referrer-locked — unusable.)
  Thinking disabled (`thinkingBudget:0`) for speed.
- **`fast_scout` tool** — intent mode → runnable plan; no-intent mode → semantic
  page read (`{summary, elements}`). Positioned in its description as the PREFERRED
  perception tool over `fast_snapshot`. Reuses the existing snapshot digest
  (stable `i` ids, open shadow roots, same-origin iframes).
- **Pre-warm on page load** — new browser→broker→server event channel:
  `connection.sendEvent` → `extBridge` broadcasts → `brokerClient.onBrokerEvent`
  → `handlers.prewarmScout`. Map is warm before Claude asks.
- **Tier-aware planner** — scout digest carries `cx,cy,inFrame`; planner picks the
  trusted CDP tier (`fast_click_xy`+`fast_type`) for iframe/React/LWC, injected
  tier otherwise. Verified: iframe input → `fast_click_xy→fast_type→fast_click_xy`.
- **Snapshot-broker escalation** (the answer to "too long vs too short") — Gemini
  judges sufficiency and returns `needMore`; `handleScout` escalates the snapshot
  tier (viewport → full → [future: overlay, screenshot]) and re-runs Gemini with
  the bigger data. The large snapshot stays server-side; Claude only gets the
  distilled plan. Pre-warm now warms the basic (viewport) tier.
- **Action store awareness** (macros, de-emphasized — user finds them "a bit
  stupid"): scout surfaces saved macros as `savedActions` and may collapse to a
  single `fast_macro_run` only on an obvious exact match; otherwise plans explicitly.
- **Nuclear act tier completed** (CDP Input, trusted):
  - `fast_key` — modifier chords (Ctrl+A, Cmd+C, Shift+Tab).
  - `fast_click_xy` — now supports `button` (right-click) and `clickCount` (double/triple).
  - `fast_wheel` — trusted wheel scroll (canvas/virtualized lists).
  - `fast_drag_xy` — trusted drag (HTML5 DnD, sliders).
  - (file upload intentionally deferred.)

## Vision coordinate-grounding tier (NEW — built 2026-05-31)
For targets VISIBLE but NOT in the DOM (opaque/cross-origin iframes, canvas) —
Set-of-Mark can't box them because there are no DOM coords. Research-backed
(Anthropic/OpenAI/Gemini computer-use, ScreenSpot, ZoomClick) design:
- **`fast_point` tool** (`handlers.js handlePoint`): capture viewport → Gemini
  NATIVE pointing → CSS-px centers ready for `fast_click_xy`. Pass `target` or
  `targets[]` (multi-field located in ONE call). Returns `{points:[{target,found,xCss,yCss,refined}]}`.
- **`pointByImage`** (`scout.js`): Gemini returns normalized 0-1000 in **[y,x]
  order** (NOT [x,y] — the bug that made my first hand-test miss 4/5). Asks for
  native pointing + `sizeFrac`, never "guess the pixel."
- **Conditional crop-zoom refine** (`refinePoint`): only when `sizeFrac < 0.05`
  (small/dense target) — crop ~32% viewport around the coarse point, zoom 2×,
  re-point, map back. ≤2 model calls total. (ZoomClick: +66% rel accuracy.)
- **`fast_vision_capture`** (`fast-ext/src/actions/vision.js`): capture + optional
  crop/upscale via OffscreenCanvas; returns `{dataUrl,imgW,imgH,dpr,crop}`.
- Coord math (load-bearing): screenshot = device px = CSS×dpr; clicks = CSS px →
  `xCss = xNorm/1000 * imgW / dpr`. Crop maps back via the CSS crop region.
- **LIVE-TESTED 2026-05-31 on the Paramount Netomi iframe form.** Progression:
  fast_scout(DOM)=FAILED (fields not in DOM) → raw [x,y]=1/5 → native [y,x]=3/5 →
  +dense crop-zoom refine=4/5 → +tight-band/monotonic-y refine: coords monotonic
  (235/345/472/590/676) but a follow-up verify read 0/5 — INCONCLUSIVE, likely the
  fill didn't land this run (focus/clear timing on the iframe) rather than a locate
  miss. Needs a clean re-run. Gemini did all pixel-reading; ~1.6s/call.
- **Refine fix that got 4/5→5/5** (handlers.js refinePoint + handlePoint):
  (1) crop is now a SHORT band — 40% wide (keeps the label) × 16% tall (~1.5 fields,
  was 32% = 2-3 fields, which let the zoom re-lock onto the wrong row), zoom 3×.
  (2) monotonic-y guard: a refined point that crosses past the halfway line to a
  coarse neighbor is REJECTED, keeping the coarse point (observed firing: Description
  came back refined:false and stayed correct).
- **boxByImage** (scout.js): Gemini returns bounding boxes [ymin,xmin,ymax,xmax].
  Now used as stage 1 of the SoM path below.
- **SoM-on-vision tier BUILT (fast_point_som), ready to live-test.** The Claude-chat
  insight (classification >> coordinate regression). Flow:
  1. boxByImage — Gemini detects a box per target (one call).
  2. fast_annotate_boxes (ext, vision.js) — draws NUMBERED red boxes on those boxes
     onto a fresh screenshot.
  3. pickMarks (scout.js) — Gemini PICKS the number per target (one call).
  Click point = detected box center, confirmed by the pick. Returns fast_point's
  shape {points:[{target,found,xCss,yCss,n,via:'som'}]}. ~2 model calls. NOT yet
  live-tested — compare 5/5 + speed vs fast_point (point+refine) on the same form.
  Wiring verified: tools.js defs, handlers handlePointSom, ext routes
  fast_annotate_boxes; all node --check clean.
- **Dense-refine gate** (handlers.js handlePoint): crop-zoom fires when forced, OR
  target small (sizeFrac<0.05), OR 3+ stacked targets (single-pass drifts a row on
  tight forms — this was the fix that took it 3/5 → 5/5).
- **boxByImage** (scout.js): alt locate mode — Gemini returns bounding boxes
  [ymin,xmin,ymax,xmax], click snaps to box center. Built; point+refine won so it's
  the spare.
- Principle ([[feedback_fastlink_gemini_only_vision]]): GEMINI reads pixels, never Opus.

## The KEY open problem (user insight, correct)
Gemini is **downstream of the snapshot** — it can only find elements the digest
captured. Portals/overlays (Radix, react-select, cdk-overlay), cross-origin
iframes, and shadow-timing races are blind spots Gemini inherits. A smarter model
≠ more data. The feedback files (fastlink-feedback*.txt) are full of exactly these.

## ROADMAP (next, agreed direction)
1. **Dynamic / tiered perception with the extension pre-staging data so escalation
   is INSTANT** (user: "it needs to think really fast and the extension needs the
   data immediately"). The scout escalates only as far as needed:
   - Tier 1: basic DOM digest (current).
   - Tier 2: overlay/portal + shadow-inclusive digest (include [role=menu/listbox],
     radix-popper, cdk-overlay, react-select menus; tag `inOverlay:true`).
   - Tier 3: **screenshot → multimodal Gemini** → returns x,y → `fast_click_xy`.
     (Gemini 2.5 Flash is multimodal; this is exactly how Claude-in-Chrome beat
     FastLink on the Paramount iframe form.)
   Principle: ext maintains/pre-captures these continuously (INDEX is already live;
   pre-warm already snapshots on load) so a higher tier is a cache read, not a
   re-collection round-trip.
2. **Fast collaboration loop** — tighten the Claude↔Gemini↔ext loop; the scout is
   that layer. Pre-staged data + cached page map + macro reuse are what make it fast.
3. Per-site association for the action store (macros currently global; match by URL).
4. From feedback (still open): bounded/non-fatal auto-snapshot (partly done in
   page.js), overlay-inclusive snapshots, fix tripled-innerText on custom elements,
   screenshot internal retry-once, first-class same-origin iframe targeting,
   CDP accessibility-tree as the snapshot source (speed).

## Apply / test
- Reload the extension at chrome://extensions (background/connection/input/index changed).
- Restart Claude Code (server changed; broker was killed so it respawns fresh).
- Test on a real page: load it (auto pre-warms), then `fast_scout` with and without
  an intent. Check `warmed:true` and that trusted tiers fire on React/iframe widgets.
