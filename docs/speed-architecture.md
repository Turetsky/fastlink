# FastLink — Speed Architecture (the "tiers" reframed around round-trips)

## The cost model (measured this session)
```
Total ≈ (Opus round-trips × ~3s) + (Gemini calls × ~1.6s) + (browser actions × ~0.1s)
                ▲ DOMINANT              ▲ secondary            ▲ negligible
```
Speed = collapse Opus round-trips first, then parallelize Gemini. Native
Claude-in-Chrome is slow for the SAME reason (per-field round-trips). Beating it
= "plan once, execute once."

## Round-trip tiers (land as high as possible; fall only for stragglers)
```
TIER 0  saved-plan replay     0 model calls (hybrid: coords + 1 cheap verify)   ← repeat pages
TIER 1  warm + one-shot       0 Opus mid-loop, ~1 Gemini  (fast_fill_vision on pre-warmed page)
TIER 2  cold one-shot         1 Gemini locate-all + batched click/type  (fast_fill_vision fresh)
TIER 3  per-field escalate    N calls, only for fields that failed
```

## Tools being built (team gcp-crash, this session)
- **fast_fill_vision** (vision-fill-builder) — SAFE one-shot: Opus supplies
  {fields:{label:value}}, server captures → ONE pointByImage locates ALL fields →
  click_xy+type each. Refine policy: SKIP when coarse confidence ≥0.75 + clean
  spacing; PARALLELIZE (Promise.all) the refines that remain. Optional submit arg.
- **fast_do** (fastdo-builder) — EXPERIMENTAL, most ambitious: Opus passes ONE
  intent; Gemini DECOMPOSES it into steps AND locates them; server executes.
  Removes Opus from the per-field loop entirely. SAFETY: never clicks submit/
  create/delete unless intent says so. To be A/B'd vs fast_fill_vision.
  Risk: flash-lite weaker at task DECOMPOSITION than at locating → may mis-route
  values. fast_fill_vision is the safe fallback if so.
- **prewarmVision** (prewarm-builder) — on 'navigated', ONE Gemini pass builds a
  cached "visual page map" (summary + regions) keyed by url+image-hash, debounced,
  best-effort. visualMap()/getVisualMap() in scout.js. Makes the first real
  fast_point/fill on a page warm.

## Design decisions locked
- **Idea A (saved-plan store): HYBRID coords+verify.** Save exact x,y + types for
  instant replay, BUT one cheap vision check confirms the page matches before
  firing; re-locate only if it drifted. Fast common case, safe on GCP's shifting
  layout. (User is building tier-0 replay separately.)
- **Idea B (cut Opus): YES, try it** = fast_do (above). Keep fast_fill_vision as
  the safe division-of-labor (Opus maps, Gemini locates) to compare.
- **Refine: skip-when-confident + parallelize** (not always-on, not sequential).

## Prereqs already fixed this session (enable the speed work)
- fast_point NEVER hallucinates (found:false + confidence) → no screenshot-verify
  needed → kills the slow path. Auto-scroll is OPT-IN (doesn't dismiss menus).
- Persistent CDP attach (input.js) → the "debugging Chrome" banner no longer
  appears/vanishes between screenshot and click → coordinates stay accurate.
- page.js crash fixes: serialize budget default 2500ms, MAX_INDEX 10000, rIC
  {timeout:200}, PENDING>20000 backstop, narrowed observe config, cursor-resume.

## BUILT & MERGED (2026-06-01, team gcp-crash — all parse clean, handlePoint preserved)
- **fast_fill_vision** — 1 MCP call fills a whole form. {fields:{desc:value}, submit?, freshCapture?} → one pointByImage locates ALL fields → trusted click_xy+type each. Refine = skip-when-confident (conf≥0.75 + ≥44px spacing) + PARALLEL (Promise.all). ~2-3 Gemini calls total.
- **fast_do** — EXPERIMENTAL. {intent} → planByImage (Gemini decomposes intent→steps) + pointByImage (locate all) → execute. STOPS before submit/create/delete unless intent authorizes (prompt + server regex guard). 2 Gemini calls. A/B target vs fast_fill_vision.
- **fast_locate** — race-the-tiers. {target} fires DOM (snapshot+match, 3s timeout, .catch→null) AND vision (pointOnce) CONCURRENTLY; raceUsable() returns first TRUTHY hit. Hung GCP DOM can't stall vision. Returns {via:'dom'|'vision'|null, xCss, yCss, found}.
- **prewarmVision(url)** — on 'navigated' (debounced 700ms, 1 in-flight): capture + ONE Gemini visualMap {summary,regions}, cache by url+imagehash; also stash the screenshot (8s TTL). Exports getWarmCapture/getWarmVisualMap.
- **warm-screenshot reuse** — pointOnce → captureForVision(opts): getWarmCapture(url) first (unless opts.freshCapture) else fresh. Scroll-retry + post-fill submit FORCE fresh (different viewport). currentUrl() via cached 1-line fast_evaluate.
- **no-hallucinate fast_point** — found:false + confidence (≥0.4 gate); off-screen → honest miss, not fake coords. scroll is OPT-IN (doesn't dismiss menus).
- **persistent-CDP (input.js)** — debugger attaches once per tab & stays (no per-call detach) → the "debugging Chrome" banner no longer appears/vanishes between screenshot & click → coords stay accurate. Was silently throwing every click ~35px high.

## NEXT SESSION pickup
- LIVE TEST (not yet run): reload ext + /mcp reconnect → fresh GCP Credentials tab →
  fast_fill_vision({fields:{...}}) ONE call → should finish form fast, NO crash. Compare to native Claude (which is also slow on GCP).
- fast_do vs fast_fill_vision A/B still to run.
- All the above are UNTESTED on a live page — only node --check. The session kept crashing GCP before; these fixes target exactly that, but prove it live.

## Open ideas still to discuss
- Parallelize locate ACROSS tiers (DOM + vision concurrently, take whichever
  returns usable first).
- "Warm screenshot" reuse: prewarmVision's capture feeds the next fast_point so
  it skips its own capture when recent.
- Confidence-driven tier selection: high-confidence DOM digest → skip vision;
  thin/iframe → straight to vision (don't even try DOM).
