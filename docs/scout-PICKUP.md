# Scout — pickup after reload (2026-05-31)

## DO THIS FIRST after MCP reconnects
1. `fast_status` → confirm extension connected (green) and the broker came back.
2. Re-run the live test the user wants: the Paramount contact form's bottom-right
   **AI/chat button** opens an iframe (netomiChatWindow) form. Test it via the NEW
   architecture: `fast_scout({intent:"open the AI chat at bottom-right and fill the
   form with sample data: Jacob Sample / jacob.sample@example.com / zip 10001 / a
   short message — do NOT submit"})`. The user said: TEST ONLY, don't really submit.
   Tab: support.paramountplus.com/s/contact-us. The USER opens the form for me — DON'T navigate myself.

## CONFIRMED THIS SESSION: new architecture IS live after a real reload
- After /mcp reconnect, fast_scout returned `tier:"screenshot"` — proves the full
  escalation ladder (viewport→full→overlay→screenshot) loaded. Old code stopped at
  tier:"full". So a fresh server DOES load the new code.
- fast_scout FAILED on the Paramount iframe form (planned fast_fill → "No fillable
  element matching First Name") because the fields are in the Netomi iframe, invisible
  to DOM snapshot AND fast_marks. Hand-driven fast_click_xy+fast_type WORKED (filled
  all 5). → motivated the fast_point vision tier above.
- Gemini-reads-screenshot speed CONFIRMED fast: ~1.6-1.7s per locate call.
- NOTE: killing the stale server (pkill) drops the MCP connection; pkill returns
  exit 144 in this harness but still kills. Cleanest path to load new server code:
  /mcp reconnect (spawns fresh server) or full Claude Code restart.

## RELOAD vs RESTART caveat (IMPORTANT)
- User is doing `/reload-plugins`, NOT a full Claude Code restart. Reload-plugins does
  NOT necessarily respawn the MCP stdio server process. If fast_scout still returns the
  OLD behavior (needMore "target likely off-screen", tier:"full", no overlay/screenshot
  rung), the stale server is still running. To force-refresh: kill the server procs
  (`pkill -f "fast-dxt/server/index.js"` and `pkill -f "fast-dxt/broker/index.js"`) —
  NOTE pkill returns exit 144 in this harness but still works; verify with pgrep. Then
  reconnect MCP (/mcp) so a fresh server spawns from disk. A true Claude Code restart is
  the most reliable way to load new server code.

## What's on disk now (LIVE once a fresh server loads it)
- **Model = gemini-2.5-flash-lite** (config.js:39) — benchmarked winner: plan 691ms
  median / 440ms TTFT, vision 512ms, fastest + fully accurate. Fallback: 2.5-flash.
- **Escalation ladder** handlers.js SNAPSHOT_TIERS: viewport → full → **overlay**
  ({overlay:true}) → **screenshot rung** (fast_marks → locateByImage multimodal → fast_click_xy).
- **Overlay snapshot** (page.js): fast_snapshot {overlay:true} adds portaled menu/listbox
  items tagged inOverlay:true. slimDigest passes inOverlay through to the planner.
- **Set-of-Mark** (marks.js / fast_marks): annotated screenshot, cx/cy returned in CSS px.
- **Nuclear act tier**: fast_key (modifiers), fast_click_xy (+button/clickCount),
  fast_wheel, fast_drag_xy, fast_type.
- **Pre-warm on page load**: ext tabs.onUpdated → broker broadcastToMcp → server prewarmScout.

## Why this test matters (observed before reload)
- Old live server's fast_scout returned needMore "target likely off-screen" and STOPPED —
  it had NO overlay/screenshot rung. The iframe chat form is exactly the case the new
  rungs exist for. iframe = netomiChatWindow (same-origin per feedback). Bottom-right
  chat button ~viewport (1380,683); form fields render inside the iframe panel.
- Manual trusted tools (fast_click_xy + fast_type) WORKED on the iframe (typed into
  netomiChatWindow). The NEW value is fast_scout doing it via overlay→screenshot
  escalation instead of me hand-driving coordinates.

## NEW THIS SESSION (built, needs live test): VISION coordinate-grounding tier
- `fast_point({target}|{targets:[...]})` — locates on-screen elements NOT in the
  DOM (iframe/canvas) via Gemini native [y,x] pointing → returns CSS-px {xCss,yCss}
  → feed to fast_click_xy then fast_type. Multi-field = one model call.
  Conditional crop-zoom refine for small targets (sizeFrac<0.05). ~1.6s/call.
- Files: NEW fast-ext/src/actions/vision.js (fast_vision_capture); scout.js
  (pointByImage); handlers.js (handlePoint + refinePoint); tools.js (fast_point,
  fast_vision_capture defs); index.js routes fast_vision_capture.
- WHY: the Paramount Netomi iframe form fields aren't in the DOM, so fast_scout
  hallucinated fast_fill steps that silently failed (the live test that exposed this).
  Set-of-Mark can't box non-DOM elements → need raw vision pointing. Research agent
  confirmed: native [y,x] pointing + conditional crop-zoom is fastest+accurate (≤2 calls);
  do NOT ask the model for raw [x,y] or use a grid.
- TO LIVE-TEST after server reload: clear the Paramount form, then
  `fast_point({targets:["First Name input","Last Name input","Email input","Zip Code input","Description box"]})`
  → batch fast_click_xy+fast_type per returned point. Compare accuracy to the
  hand-driven run (which worked) and to fast_scout (which failed on this form).
- OPEN: should fast_scout AUTO-escalate to fast_point when the digest is thin/
  iframe (instead of planning dead fast_fill)? User wanted to "see the test" first.

## STILL PENDING (team outputs + refactor not yet applied)
- **Collapse two-stage → one-shot** (researcher's rec): scout.js still does buildPageMap +
  overlayIntent. At 150-item scale one-shot flash-lite (~691ms) ≥ two-stage warm (~865ms).
  Decide: collapse (simpler/faster) or keep two-stage for huge pages.
- **researcher's prompt-hardening** for overlayIntent system prompt (duplicate labels,
  not-in-digest→needMore, ambiguous intent→needsMoreInfo) — proposed, NOT applied.
- **reviewer's findings** — reviewer agent was auditing ALL files (BLOCKER/SHOULD-FIX/NIT);
  was mid-run. Read its report, apply fixes.
- Team was `scout-team` (researcher, vision-builder, server-builder, reviewer). Re-spawn if continuing.

## Files (all syntax-clean)
server: scout.js, handlers.js, config.js, tools.js, brokerClient.js, broker/{extBridge,mcpBridge}.js
ext: actions/{marks,input,index,page}.js, background.js, src/connection.js
docs: scout-STATUS.md, scout-BENCHMARKS.md (this docs/ folder) (full numbers), this file
