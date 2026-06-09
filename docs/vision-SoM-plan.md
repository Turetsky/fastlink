# FastLink Vision — Set-of-Mark plan (the real fix for dense pages)

## The finding that forced this (data, not vibes — 2026-06-01)
On the GCP Credentials page, `fast_point("Create credentials")` — a clearly-visible
button whose TRUE center is (512,123) [from DOM snapshot: x420 y107 w185 h32]:
- call 1 (vague desc):  found:true at (266,472)  ← CONFIDENT BUT WRONG (~250px off)
- call 2 (precise desc): found:false             ← same button, opposite answer

Incoherent answers on the same element = Gemini is GUESSING. Conclusion:
**raw-pixel coordinate regression is fundamentally unreliable on dense pages
(60+ elements).** Prompt/confidence tuning cannot fix a model that can't pin the
pixel. (Matches the research: VLMs align text↔object semantically, not text↔pixel.)

Separately FIXED this session (keep): the earlier found:false-on-blank was a STALE
WARM-FRAME bug — prewarm captured before GCP rendered; now prewarmVision re-warms
at 0.7/1.6/3.0s AND pointOnce auto-recaptures fresh if a warm frame finds nothing.
That fix is real and orthogonal to the regression problem.

## THE FIX: Set-of-Mark (classification, not regression)
Don't ask "what pixel is X." Number the candidate boxes, ask "which NUMBER is X,"
then click that box's coordinates. Gemini only CLASSIFIES (easy, ~always right);
the COORDINATES come from the box source (exact).

## Two tiers — KEY DESIGN POINT (build both, prefer #1)
1. **DOM-boxes SoM (primary when DOM works — e.g. GCP):**
   The DOM snapshot DOES work on GCP — it gives EXACT element rects. So:
   fast_snapshot → number each interactive item → draw labels on the screenshot
   (fast_marks already does this, labels = element id `i`) → Gemini picks the
   number → use that item's EXACT DOM center. ZERO coordinate regression.
   (We have fast_marks + locateByImage already — wire as the primary fast_point path.)
2. **Detected-boxes SoM (fallback when DOM can't see it — e.g. Paramount iframe):**
   No DOM rects → Gemini detects boxes (boxByImage) → number them → pick. This
   still has detection error, but box-level is easier than point-level. Last resort.

## Build (server-side, reuse existing pieces — DON'T rebuild)
- ALREADY EXIST: fast_marks (ext: draws numbered boxes over snapshot items, returns
  {dataUrl, marks:[{i,cx,cy}]}), locateByImage (scout.js: Gemini picks a box number
  from an annotated image), boxByImage + pickMarks (detected-box variant).
- TODO: make fast_point/fast_fill_vision use the SoM path when DOM items exist:
  1. fast_marks (number the on-screen DOM items)
  2. locateByImage / pickMarks(target) → Gemini returns the chosen number(s)
  3. map number → that mark's cx,cy (DOM-exact) → fast_click_xy
  - For multi-field (fast_fill_vision): one fast_marks + one pickMarks-with-all-targets.
- Fall back to raw pointByImage ONLY when fast_marks yields no candidate for the
  target (truly non-DOM element).

## Test against the saved FIXTURE (measure, don't guess)
- /tmp/vision-fixture-gcp-credentials.png + /tmp/vision-fixture-truth.json
  (GCP Credentials screenshot + 5 elements w/ true CSS-px centers, incl.
  "Create credentials" @ (512,123)). A harness must score SoM-locate vs these
  truths before we trust it live. Target: correct box pick on "Create credentials"
  (raw pointByImage got (266,472) / found:false — SoM should nail it).

## Why this ends the session's struggle
DOM tier alone: crashes GCP (fixed, but heavy). Raw vision alone: can't pin pixels
on dense pages (just proven). SoM = DOM gives boxes+coords, vision gives the label
match → the two cover each other's weakness. This is THE architecture.
