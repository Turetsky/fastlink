import { writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Buffer } from 'buffer';
import { callExtension, getStatus, getBrokerLinkInfo } from './brokerClient.js';
import { HTTP_ENABLED, HTTP_PORT, TOKEN, SCOUT_ENABLED } from './config.js';
import { scout, warm as warmScout, locateByImage, pointByImage, boxByImage, pickMarks, visualMap, getVisualMap, planByImage } from './scout.js';

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

// --- Server-side capture-retry guard --------------------------------------
// captureVisibleTab copies the rendered surface out of the GPU compositor and
// INTERMITTENTLY throws "image readback failed" when that process wedges (page
// renders fine, only the bitmap copy fails). The extension already retries at the
// capture level (captureVisibleRetry), but the wedge can outlast those attempts,
// so a thin SERVER-side guard retries the whole callExtension a couple more times
// (spaced, since the failure is transient and a later frame often succeeds)
// before surfacing the error to the model. Only the screenshot/vision capture
// tools are guarded; everything else passes straight through. This does NOT touch
// handleScout's own vision fallback (that path calls callExtension directly).
const CAPTURE_TOOLS = new Set([
  'fast_screenshot', 'fast_vision_capture', 'fast_marks', 'fast_annotate_boxes',
]);
// NON-IDEMPOTENT actions must NEVER be auto-retried — a re-fire double-writes
// (double-typed values, double clicks/submits). This matters specifically after
// BUG-4: a fill can succeed in the page while its ack is lost/slow and the call
// surfaces as a timeout — retrying that would silently write the value twice.
// callCapture today only runs for CAPTURE_TOOLS (read-only screenshot/vision, so
// safe to repeat), but guard explicitly so a future edit that adds a write tool
// to CAPTURE_TOOLS can't silently start double-writing. (BUG-4)
const NON_IDEMPOTENT = new Set([
  'fast_fill_form', 'fast_fill', 'fast_fill_vision', 'fast_type', 'fast_do',
  'fast_click', 'fast_click_xy', 'fast_select_option', 'fast_drag', 'fast_drag_xy',
  'fast_key', 'fast_key_press', 'fast_nav', 'fast_reload',
]);
const READBACK_ERR_RE = /readback|compositor|captureVisibleTab/i;
async function callCapture(name, args, retries = 2) {
  let payload = await callExtension(name, args);
  // Never auto-retry a non-idempotent action, whatever the error.
  if (NON_IDEMPOTENT.has(name)) return payload;
  for (let i = 0; i < retries; i++) {
    const err = payload && typeof payload === 'object' ? payload.error : null;
    if (typeof err !== 'string' || !READBACK_ERR_RE.test(err)) break;
    await new Promise((r) => setTimeout(r, 800)); // let the wedged compositor recover
    payload = await callExtension(name, args);
  }
  return payload;
}

// --- Lightweight timing instrumentation (perf diagnosis) -------------------
// Append one JSONL row per tool call to /tmp/fastlink-timing.jsonl:
//   gapMs = time since the PREVIOUS call returned = Opus round-trip/think time
//   durMs = server+extension+Gemini time spent inside THIS call
// Summing gapMs vs durMs over a flow tells us whether round-trips (Opus) or the
// actions themselves dominate — i.e. whether collapsing round-trips will help.
const TIMING_LOG = join(tmpdir(), 'fastlink-timing.jsonl');
let lastReturnTs = null;
function logTiming(name, startTs, endTs) {
  try {
    const gapMs = lastReturnTs == null ? null : startTs - lastReturnTs;
    lastReturnTs = endTs;
    writeFileSync(
      TIMING_LOG,
      JSON.stringify({ t: endTs, name, gapMs, durMs: endTs - startTs }) + '\n',
      { flag: 'a' },
    );
  } catch {}
}

// --- Activity gate for pre-warming ----------------------------------------
// Pre-warm (scout + vision on every navigation) must be explicitly turned ON by
// the `fast_prewarm` tool — it never starts on its own. Once armed, every tool
// call extends the window, and pre-warm shuts off ACTIVE_WINDOW_MS after the
// LAST tool. So an idle MCP connection never triggers background snapshot/vision
// passes, and pre-warm only runs during a deliberate burst of activity.
const ACTIVE_WINDOW_MS = 60_000;
let prewarmUntil = 0; // pre-warm is active while Date.now() < prewarmUntil
function isActive() { return Date.now() < prewarmUntil; }
function armPrewarm() { prewarmUntil = Date.now() + ACTIVE_WINDOW_MS; }
// handleCall has already armed the window by the time this runs.
function prewarmStatus() {
  return { prewarm: SCOUT_ENABLED ? 'on' : 'unavailable',
           reason: SCOUT_ENABLED ? undefined : 'set GEMINI_API_KEY to enable the scout',
           expiresInMs: Math.max(0, prewarmUntil - Date.now()) };
}

export async function handleCall(name, args) {
  const __start = Date.now();
  // fast_prewarm turns it ON; any other tool only EXTENDS an already-active
  // window (so it can't self-start, but stays warm while work is in flight).
  if (name === 'fast_prewarm' || isActive()) armPrewarm();
  try {
    return await dispatchCall(name, args);
  } finally {
    logTiming(name, __start, Date.now());
  }
}

async function dispatchCall(name, args) {
  try {
    if (name === 'fast_prewarm') return text(prewarmStatus());
    if (name === 'fast_status') return text(await statusReport());
    if (name === 'fast_batch')  return text(await runBatch(args));
    if (name === 'fast_scout')  return text(await handleScout(args));
    if (name === 'fast_point')  return text(await handlePoint(args));
    if (name === 'fast_point_som') return text(await handlePointSom(args));
    if (name === 'fast_fill_vision') return text(await handleFillVision(args));
    if (name === 'fast_do') return text(await handleDo(args));
    if (name === 'fast_locate') return text(await handleLocate(args));
    const payload = CAPTURE_TOOLS.has(name)
      ? await callCapture(name, args || {})
      : await callExtension(name, args || {});
    // Tool-level errors come back as resolved payloads with `error` set, plus
    // any extras (diagnostics, available, etc.). Surface them as text so the
    // LLM sees everything, not just the message.
    if (payload && typeof payload === 'object' && 'error' in payload) return text(payload);
    let result = payload?.result ?? null;
    if (name === 'fast_screenshot' && result?.dataUrl) return text(saveScreenshot(result));
    // fast_marks returns a full annotated-PNG dataURL — useless inline (MCP text
    // can't render it) and a context bomb. Save it to /tmp like fast_screenshot;
    // keep the marks/dpr index. (The internal scout screenshot rung calls the
    // extension directly via callExtension, bypassing this, so it still gets the
    // raw dataURL it needs for locateByImage.)
    if (name === 'fast_marks' && result?.dataUrl) {
      const { dataUrl, ...rest } = result;
      return text({ ...saveScreenshot({ dataUrl, format: 'png' }), ...rest });
    }
    // Inline screenshot opt-in (fast_snapshot / fast_click / etc. with screenshot:true).
    if (result && typeof result === 'object' && result.screenshot?.dataUrl) {
      result.screenshot = saveScreenshot(result.screenshot);
    }
    return text(result);
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
}

async function statusReport() {
  const broker = await getStatus().catch(e => ({ error: e.message }));
  const link = getBrokerLinkInfo();
  const justReconnected = link.lastDisconnectAgoMs != null && link.lastDisconnectAgoMs < 10_000;

  const hints = [];
  if (broker?.connected) {
    hints.push('Extension connected. fast_snapshot/fast_click/fast_fill should work.');
    hints.push('If a DOM tool hangs or returns null on a specific tab, that tab likely loaded before the current extension version — reload it.');
  } else {
    hints.push('Extension NOT connected. Open chrome://extensions, find "FastLink", click its "service worker" link to see if it errored.');
  }
  if (justReconnected) {
    hints.push(`Broker link reconnected ${Math.round(link.lastDisconnectAgoMs / 1000)}s ago — if the last call failed with "Connection closed", retry it once.`);
  }
  return {
    ...broker,
    brokerLink: link,
    httpEnabled: HTTP_ENABLED,
    httpPort: HTTP_ENABLED ? HTTP_PORT : null,
    httpAuthRequired: HTTP_ENABLED && !!TOKEN,
    hint: hints.join(' '),
  };
}

// Scout: reuse the existing fast_snapshot digest (stable ids, shadow/iframe
// aware), hand it + the intent to the fast model, return a runnable plan.
async function handleScout(args) {
  const intent = args?.intent;
  // Skip the snapshot round-trip entirely when the scout is off.
  if (!SCOUT_ENABLED) {
    return { disabled: true, reason: 'set GEMINI_API_KEY to enable the scout', brief: null, steps: [] };
  }
  const macroRes = await callExtension('fast_macro_list').catch(() => null);
  const raw = macroRes?.result;
  const macros = Array.isArray(raw?.macros) ? raw.macros : (Array.isArray(raw) ? raw : []);

  let result;
  let degraded = false; // a DOM tier timed out / came back capped|partial → go vision
  for (let t = 0; t < SNAPSHOT_TIERS.length; t++) {
    const tier = SNAPSHOT_TIERS[t];
    const last = t === SNAPSHOT_TIERS.length - 1;
    const snap = await scoutSnapshot(tier.snap);
    if (snap?.error) {
      // A snapshot timeout/error on a heavy page IS the signal to go vision.
      degraded = true;
      if (last) break;
      continue;
    }
    const digest = snap?.result;
    if (!digest || !Array.isArray(digest.items)) {
      if (last) { degraded = true; break; }
      continue;
    }
    const heavy = !!(digest.capped || digest.partial || digest.snapshotTimedOut);
    result = await scout({ intent, digest, macros });
    result.tier = tier.label;
    // READ MODE on a HEAVY page: the DOM index is too sparse/degraded to
    // summarize well, so prefer a screenshot→Gemini vision read (DOM-independent,
    // the same path fast_point uses — it doesn't care how big the DOM is).
    if (!intent && !result.disabled && heavy) {
      const vis = await visionScoutRead(null);
      if (vis) return vis;
    }
    // Read mode, disabled, or Gemini satisfied → done. Otherwise escalate to a
    // bigger snapshot and let Gemini look again (the "double run").
    if (!intent || result.disabled || !result.needMore) return result;
    // HEAVY-PAGE SHORT-CIRCUIT: this snapshot came back degraded (issue #7's
    // capped/partial/snapshotTimedOut flags), so the page is too heavy to keep
    // re-reading — escalating to the bigger `full`/`overlay` DOM tiers would just
    // hang on the same giant DOM. Stop the DOM escalation and go to vision below.
    if (heavy) { degraded = true; break; }
  }
  // INTENT MODE, DOM tiers exhausted/degraded → SCREENSHOT rung. fast_marks
  // returns an annotated PNG (numbered red boxes whose labels ARE element ids) +
  // a marks index; multimodal Gemini picks the box, we map it to cx,cy and emit a
  // trusted click. Bounded and non-fatal: any failure falls back below.
  if (intent && ((result && result.needMore) || degraded)) {
    const located = await screenshotRung(intent);
    if (located) return located;
    // Screenshot rung couldn't act → at least hand back a vision-based read so the
    // caller has page comprehension instead of an empty/timed-out result.
    const vis = await visionScoutRead(intent);
    if (vis) return { ...(result || {}), ...vis };
  }
  // READ MODE where every DOM tier errored/timed out → screenshot→Gemini read.
  if (!intent && (degraded || !result)) {
    const vis = await visionScoutRead(null);
    if (vis) return vis;
  }
  return result || {
    error: 'scout: no usable snapshot (page heavy/unresponsive). Try fast_screenshot, fast_point, or reload the tab.',
  };
}

// Screenshot→Gemini page comprehension — the DOM-INDEPENDENT scout read. Used
// when the DOM index is too heavy/degraded to summarize (GCP and other giant
// SPAs): capture one screenshot and ask Gemini for a terse page understanding
// (summary + main interactive regions), exactly like the vision pre-warm. Reuses
// a warm visual map when prewarm already built one. Best-effort: returns null on
// any failure so the caller can fall back. `intent` is informational only (the
// runnable target for an intent comes from the screenshot rung).
async function visionScoutRead(intent) {
  try {
    const url = await currentUrl();
    // Reuse a warm visual map if prewarm already paid for one on this page.
    const warm = getWarmVisualMap(url);
    if (warm) {
      return { tier: 'vision', via: 'screenshot', warmed: true, url,
               summary: warm.summary, regions: warm.regions,
               intent: intent || undefined, note: 'heavy DOM — vision (screenshot) read' };
    }
    const cap = await captureForVision({});
    if (cap.error || !cap.dataUrl) return null;
    const vm = await visualMap(url, cap.dataUrl);
    if (!vm || vm.disabled) return null;
    return { tier: 'vision', via: 'screenshot', warmed: !!vm.warmed, url,
             summary: vm.summary, regions: vm.regions,
             intent: intent || undefined, note: 'heavy DOM — vision (screenshot) read' };
  } catch {
    return null;
  }
}

// Tier 3 screenshot escalation. Returns a runnable plan on success, or null to
// fall back to the caller's prior DOM result. Wrapped so a screenshot/Gemini
// failure never throws out of handleScout.
async function screenshotRung(intent, candidateIds) {
  try {
    const args = Array.isArray(candidateIds) && candidateIds.length ? { only: candidateIds } : {};
    const res = await callExtension('fast_marks', args);
    if (res?.error) return null;
    const out = res?.result;
    if (!out || !out.dataUrl || !Array.isArray(out.marks) || !out.marks.length) return null;

    const { i, reason } = await locateByImage({ intent, dataUrl: out.dataUrl, marks: out.marks });
    if (i == null) {
      return {
        tier: 'screenshot',
        needMore: true,
        needsMoreInfo: `Could not visually locate the element to "${intent}" in the screenshot. Try a more specific intent, scroll to the target, or open the relevant menu/section first.`,
        steps: [],
      };
    }
    const mark = out.marks.find((m) => m && m.i === i);
    if (!mark || typeof mark.cx !== 'number' || typeof mark.cy !== 'number') {
      return {
        tier: 'screenshot',
        needMore: true,
        needsMoreInfo: `Gemini chose box ${i}, but no coordinates were available for it.`,
        steps: [],
      };
    }
    return {
      tier: 'screenshot',
      brief: `Visually located the target (box ${i}: ${reason || 'matched'}). Trusted-click its center. If the intent requires typing afterward, follow with fast_type.`,
      steps: [{ name: 'fast_click_xy', args: { x: mark.cx, y: mark.cy, _ref: i } }],
      located: { i, reason },
      needMore: false,
    };
  } catch {
    return null; // screenshot rung is best-effort; fall back to the DOM result
  }
}

// Pre-warm the scout's page map on navigation, before Claude asks. Best-effort:
// snapshot the freshly-loaded tab and build (+cache) the Gemini page map. The
// page map is keyed by url+content-hash, so a later fast_scout on the same page
// skips straight to the cheap intent-overlay. Errors are swallowed — warming is
// an optimization, never required for correctness.
let prewarmInFlight = false;
export async function prewarmScout() {
  if (!SCOUT_ENABLED || prewarmInFlight || !isActive()) return;
  prewarmInFlight = true;
  try {
    // Warm the BASIC (viewport) tier — that's what the first real scout reads.
    // __prewarm tells the extension this is a background pre-read, not Claude
    // acting — the overlay shows a subtle dot instead of the full driving panel.
    const snap = await callExtension('fast_snapshot', { viewport: true, __prewarm: true });
    const digest = snap?.result;
    if (digest && Array.isArray(digest.items)) await warmScout(digest);
  } catch {
    // ignore — next real fast_scout will build the map on demand
  } finally {
    prewarmInFlight = false;
  }
}

// VISION pre-warm — sibling to prewarmScout, fired on the same 'navigated'
// event. After the page settles, capture ONE screenshot and (a) stash it so a
// fast_point in the next few seconds reuses it instead of re-capturing, and
// (b) run ONE Gemini pass to cache a "visual page map". Must be CHEAP and
// NON-BLOCKING: debounced (coalesces GCP's navigation storms into one warm),
// single-in-flight, at most one model call per settled navigation, all errors
// swallowed. A screenshot taken too soon after nav can fail ('image readback
// failed') — we just skip warming, never throw.
const VISION_WARM_DEBOUNCE_MS = 700; // let the page settle; coalesce rapid navs
const WARM_CAPTURE_TTL_MS = 8000;    // a warm capture is reusable this long
const warmCaptures = new Map();      // url -> { capture, ts }
let visionWarmTimer = null;
let visionWarmInFlight = false;
let pendingWarmUrl = null;

// Re-warm at several points across the settle window so the cached capture
// TRACKS the page as it renders, instead of being a one-shot gamble that often
// fires before a slow SPA (GCP) has painted. Each pass overwrites the cached
// capture with a newer frame; only the LAST pass spends a Gemini visualMap call.
const VISION_WARM_PASSES_MS = [700, 1600, 3000];

export function prewarmVision(url) {
  if (!SCOUT_ENABLED || !isActive()) return;
  pendingWarmUrl = url || pendingWarmUrl;
  if (visionWarmTimer) clearTimeout(visionWarmTimer); // debounce: last nav wins
  // Schedule a burst of re-warms; the page is moving, so keep refreshing the
  // cached frame until it's stable. clearTimeout on the first handle cancels a
  // superseded nav's whole burst (we re-arm fresh below).
  visionWarmTimer = setTimeout(() => {
    visionWarmTimer = null;
    VISION_WARM_PASSES_MS.forEach((delay, i) => {
      setTimeout(() => runVisionWarm(i === VISION_WARM_PASSES_MS.length - 1), delay - VISION_WARM_PASSES_MS[0]);
    });
  }, VISION_WARM_DEBOUNCE_MS);
}

async function runVisionWarm(doVisualMap) {
  // NOTE: passes can overlap if a capture is slow; the in-flight guard drops the
  // overlap, which is fine — the next scheduled pass refreshes the frame anyway.
  if (visionWarmInFlight) return;
  visionWarmInFlight = true;
  const url = pendingWarmUrl;
  try {
    const cap = await callExtension('fast_vision_capture', { __prewarm: true });
    const full = cap?.result;
    // Capture can legitimately fail right after nav (readback) — skip, no throw.
    if (cap?.error || !full?.dataUrl) return;
    const key = url || full.url || '';
    warmCaptures.set(key, { capture: full, ts: Date.now() });
    // Only the final settle pass spends a Gemini visual-map call (don't burn 3).
    if (doVisualMap) await visualMap(key, full.dataUrl).catch(() => {});
  } catch {
    // ignore — vision warm is pure optimization, never required for correctness
  } finally {
    visionWarmInFlight = false;
  }
}

// Reuse a recently-warmed screenshot for `url` if it's still fresh. Returns the
// fast_vision_capture result ({ dataUrl, imgW, imgH, dpr, ... }) or null. The
// vision tier (fast_point / fast_fill_vision) can opt into this to skip a
// re-capture when the pre-warm already paid for one. Expired entries are pruned.
export function getWarmCapture(url) {
  const entry = warmCaptures.get(url || '');
  if (!entry) return null;
  if (Date.now() - entry.ts > WARM_CAPTURE_TTL_MS) { warmCaptures.delete(url || ''); return null; }
  return entry.capture;
}

// Read an already-warmed visual page map for `url` (no model call), or null.
export function getWarmVisualMap(url) { return getVisualMap(url || ''); }

// Escalating snapshot tiers — Gemini brokers them: start small/cheap, and only
// pull a bigger snapshot (a second Gemini run with the new data) when Gemini
// reports the current data is insufficient (needMore). Solves the "snapshot too
// long vs too short" problem: the big snapshot stays server-side; Claude only
// ever gets the distilled plan. Easy to extend with overlay/screenshot tiers.
// Per-tier snapshot deadline for the scout. The extension's serialize is already
// self-bounded (issue #7), but on a WEDGED renderer the content script can stop
// responding entirely and burn the full 30s broker timeout per tier. Race each
// snapshot against a tighter deadline so fast_scout stays responsive (~5-8s on a
// heavy page) instead of stacking 30s timeouts across three tiers. On overrun we
// return an error sentinel so the tier loop treats it as "no data" and moves on.
const SCOUT_SNAPSHOT_TIMEOUT_MS = 8000;
async function scoutSnapshot(snapArgs) {
  const snapP = callExtension('fast_snapshot', snapArgs);
  const timeoutP = new Promise((resolve) =>
    setTimeout(() => resolve({ error: 'scout: snapshot timed out (page too heavy/unresponsive)' }), SCOUT_SNAPSHOT_TIMEOUT_MS));
  return Promise.race([snapP, timeoutP]);
}

const SNAPSHOT_TIERS = [
  { label: 'viewport', snap: { viewport: true } },
  { label: 'full', snap: { viewport: false } },
  // Overlay tier: full snapshot PLUS portaled transient popovers (Radix/
  // react-select/cdk/MUI menus) tagged inOverlay:true. Fires when Gemini still
  // says needMore after the plain full snapshot — e.g. an open dropdown whose
  // options weren't in the DOM tiers. Sits just below the screenshot rung.
  { label: 'overlay', snap: { viewport: false, overlay: true } },
];

// VISION-POINT tier: locate on-screen targets that are NOT in the DOM (opaque/
// cross-origin iframes, canvas) by asking Gemini for native [y,x] points, then
// converting to CSS px for a trusted fast_click_xy. Small targets get one
// conditional crop-zoom refine pass (research: ZoomClick, +accuracy, ≤2 calls).
//
// args: { target | targets:[...], refine?:bool (default true) }
// returns: { points:[{ target, found, xCss, yCss, refined }] } — feed xCss/yCss
// straight into fast_click_xy (then fast_type to fill).
const REFINE_SIZE_FRAC = 0.05; // target narrower than 5% of width → crop-zoom
const REFINE_CONFIDENCE = 0.75; // coarse hit at/above this is trusted (skip refine)
const CLEAN_GAP_CSS = 44;       // nearest found neighbor must be ≥ this (px) for "clean spacing"

// Resolve the active tab's URL with one tiny CDP eval — needed to look up a
// warm capture (keyed by url). Best-effort: returns '' on any failure so the
// caller just falls back to a fresh capture. Cheap (a browser action, ~0.1s)
// vs the screenshot it lets us skip.
// Get the active tab's URL WITHOUT touching CDP. Using fast_evaluate here was a
// disaster: it attaches+detaches the debugger every call, which toggles the
// "FastLink is debugging Chrome" banner on/off — and that banner shifts the page
// viewport ~35-50px. Since currentUrl ran on every fast_point (for warm-capture
// keying), the banner flickered between the screenshot and the click, so clicks
// landed ~50px too high. fast_list reads tab info with NO debugger attach → no
// banner toggle → coordinates stay stable.
async function currentUrl() {
  try {
    const r = await callExtension('fast_list');
    const tabs = r?.result;
    const active = Array.isArray(tabs) ? tabs.find((t) => t.active) : null;
    return active?.url || '';
  } catch {
    return '';
  }
}

// Get a vision capture for the current tab. WARM-REUSE: if prewarmVision stashed
// a still-fresh screenshot for this url (getWarmCapture), reuse it instead of
// re-capturing — the pre-warm already paid for it. Otherwise capture anew.
// opts.freshCapture:true forces a new capture (opt out of reuse). Returns the
// fast_vision_capture result ({dataUrl,imgW,imgH,dpr,...}) or { error }.
async function captureForVision(opts = {}) {
  if (opts.freshCapture !== true) {
    const url = await currentUrl();
    const warm = getWarmCapture(url);
    // Tag warm:true so pointOnce knows this was reused — a found-nothing result
    // on a warm frame triggers an auto fresh-recapture (the warm one may be a
    // too-early/blank post-nav capture).
    if (warm?.dataUrl) return { ...warm, warm: true };
  }
  const cap = await callExtension('fast_vision_capture', {});
  const full = cap?.result;
  if (cap?.error || !full?.dataUrl) return { error: cap?.error || 'vision capture failed' };
  return { ...full, warm: false };
}

// Capture once, point at all targets, return per-target {found,xCss,yCss,refined}.
// No scrolling — one viewport.
//
// opts.confidenceSkip (default false): SKIP-WHEN-CONFIDENT policy used by
// fast_fill_vision — only crop-zoom refine the genuinely ambiguous fields (small,
// low-confidence, or tight vertical spacing); trust a high-confidence, well-spaced
// coarse hit as-is. Default (false) keeps fast_point's original decision
// (forced || small || dense) untouched. In BOTH modes the needed refines now fire
// in PARALLEL — each refine depends only on coarse data, so order is irrelevant
// and N refines cost ~1 refine of wall-clock.
async function pointOnce(targets, refineMode, opts = {}) {
  const refine = refineMode !== false;
  const forced = refineMode === true || refineMode === 'always';
  const confidenceSkip = opts.confidenceSkip === true;
  // DOM-COORDS-WIN (default on): when an element IS in the DOM, its EXACT
  // snapshot-rect center beats vision regression. GCP proved this — a DOM-true
  // click landed dead-on while vision missed by ~50px on the same button. So we
  // resolve every target we can against the DOM first (one fast_snapshot + text
  // match) and only fall to Gemini vision for the leftovers (true non-DOM targets:
  // opaque/cross-origin iframes, canvas). Snapshot rects are outer-page CSS px —
  // the SAME space fast_click_xy wants — so NO dpr math (dpr only converts vision's
  // image-space points). Pass opts.domFirst:false to force pure vision (used by
  // fast_locate, which already races a DOM tier of its own).
  const domFirst = opts.domFirst !== false;
  const domHits = domFirst ? await domLocate(targets) : targets.map(() => null);
  const remaining = [];
  targets.forEach((t, k) => { if (!domHits[k]) remaining.push(t); });

  // Weave DOM hits (by original target order) around the vision results, which are
  // aligned to `remaining`.
  const assemble = (visionOut) => {
    const out = [];
    let vi = 0;
    for (let k = 0; k < targets.length; k++) {
      if (domHits[k]) out.push({ target: targets[k], found: true, xCss: domHits[k].xCss, yCss: domHits[k].yCss, refined: false, via: 'dom' });
      else out.push(visionOut[vi++] || { target: targets[k], found: false });
    }
    return { points: out };
  };

  // DOM resolved everything → skip the screenshot + Gemini call entirely.
  if (!remaining.length) return assemble([]);

  // ---- Vision tier: only the targets with no DOM match ----
  // Capture + locate. If the capture was a REUSED warm one (prewarm may have
  // grabbed it too early — before a slow SPA like GCP finished rendering — so it
  // can be blank/half-painted → everything found:false), don't trust that miss:
  // self-correct by re-capturing FRESH and pointing again. The page is moving,
  // so a stale frame should never be the final answer.
  let full = await captureForVision(opts);
  if (full.error) {
    // If DOM already resolved some targets, return those + found:false for the
    // vision leftovers rather than failing the whole call. Only surface the error
    // when NOTHING was resolved (preserves the old single-tier behavior).
    if (domHits.some(Boolean)) return assemble(remaining.map((t) => ({ target: t, found: false })));
    return { error: full.error };
  }
  let { points } = await pointByImage({ targets: remaining, base64: full.dataUrl });
  const usedWarm = opts.freshCapture !== true && full.warm === true;
  const noneFound = !points.some((p) => p && p.found);
  if (usedWarm && noneFound) {
    const fresh = await captureForVision({ ...opts, freshCapture: true });
    if (!fresh.error) {
      full = fresh;
      ({ points } = await pointByImage({ targets: remaining, base64: full.dataUrl }));
    }
  }

  const coarse = remaining.map((t, k) => {
    const p = points.find((q) => q.k === k) || points[k];
    if (!p || !p.found) return { found: false };
    return {
      found: true,
      xCss: (p.xNorm / 1000) * full.imgW / full.dpr,
      yCss: (p.yNorm / 1000) * full.imgH / full.dpr,
      sizeFrac: p.sizeFrac,
      confidence: p.confidence,
    };
  });
  const foundYs = coarse.filter((c) => c.found).map((c) => c.yCss).sort((a, b) => a - b);
  const dense = remaining.length >= 3;

  // Decide per target whether it needs a refine, and pre-compute the y-band the
  // refine result must land in (guards the crop-zoom from re-locking onto a
  // stacked neighbor). Build a job list; run them all concurrently below.
  const jobs = remaining.map((t, k) => {
    const c = coarse[k];
    if (!c.found) return null;
    const small = c.sizeFrac != null && c.sizeFrac < REFINE_SIZE_FRAC;
    const below = foundYs.filter((y) => y < c.yCss - 1).pop();
    const above = foundYs.filter((y) => y > c.yCss + 1).shift();
    const gap = Math.min(
      below != null ? c.yCss - below : Infinity,
      above != null ? above - c.yCss : Infinity,
    );
    let want;
    if (confidenceSkip) {
      const confident = c.confidence != null && c.confidence >= REFINE_CONFIDENCE;
      const cleanSpacing = gap >= CLEAN_GAP_CSS;
      // Skip refine only when we're confident AND well-separated AND not tiny.
      want = forced || small || !confident || !cleanSpacing;
    } else {
      want = forced || small || dense;
    }
    if (!(refine && want)) return null;
    return {
      k, target: t, xCss: c.xCss, yCss: c.yCss,
      loY: below != null ? (below + c.yCss) / 2 : 0,
      hiY: above != null ? (above + c.yCss) / 2 : Infinity,
    };
  });

  // Fire all needed refines in PARALLEL.
  const refinedByK = new Map();
  await Promise.all(jobs.map((j) => {
    if (!j) return null;
    return refinePoint(j.target, j.xCss, j.yCss, full)
      .then((r) => { if (r && r.yCss >= j.loY && r.yCss <= j.hiY) refinedByK.set(j.k, r); })
      .catch(() => {}); // a refine failure just falls back to the coarse point
  }));

  const visionOut = [];
  for (let k = 0; k < remaining.length; k++) {
    const c = coarse[k];
    if (!c.found) { visionOut.push({ target: remaining[k], found: false }); continue; }
    const r = refinedByK.get(k);
    const xCss = r ? r.xCss : c.xCss;
    const yCss = r ? r.yCss : c.yCss;
    visionOut.push({ target: remaining[k], found: true, xCss: Math.round(xCss), yCss: Math.round(yCss), refined: !!r, confidence: c.confidence, via: 'vision' });
  }
  return assemble(visionOut);
}

// Vision locate with AUTO-SCROLL. Because fast_point now NEVER hallucinates
// (off-screen targets return found:false), the caller can scroll the page and
// retry to bring missing targets into view — no human babysitting. We point on
// the current view, then if anything is still not-found, wheel-scroll down a
// viewport-ish and re-point, merging in newly-found targets. Bounded passes.
async function handlePoint(args) {
  if (!SCOUT_ENABLED) return { disabled: true, reason: 'set GEMINI_API_KEY to enable vision' };
  const targets = Array.isArray(args?.targets) ? args.targets : (args?.target ? [args.target] : []);
  if (!targets.length) return { error: 'fast_point needs target (string) or targets (array)' };
  // Auto-scroll is OPT-IN (scroll:true). Scrolling DISMISSES open dropdowns /
  // popovers (clicking outside them), so it must NOT fire by default — a menu
  // item that returns found:false should be retried by reopening the menu, not
  // by scrolling it away. Only pass scroll:true for long static forms where the
  // target is genuinely below the fold (e.g. fields under a scrolled panel).
  const scroll = args?.scroll === true;

  let result = await pointOnce(targets, args?.refine, { freshCapture: args?.freshCapture === true });
  if (result.error) return result;
  if (!scroll) return result;

  // Up to 4 downward scroll passes to surface targets below the fold.
  const MAX_PASSES = 4;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const missing = result.points.filter((p) => !p.found);
    if (!missing.length) break;
    // Wheel-scroll the page (trusted, works on GCP's nested scrollers).
    await callExtension('fast_wheel', { x: 900, y: 400, deltaY: 500 }).catch(() => {});
    // Force a fresh capture: we just scrolled, so any warm (pre-scroll) capture
    // is the wrong viewport.
    const retry = await pointOnce(missing.map((m) => m.target), args?.refine, { freshCapture: true });
    if (retry.error || !retry.points) continue;
    // Merge: fill in any now-found targets.
    for (const r of retry.points) {
      if (!r.found) continue;
      const slot = result.points.find((p) => p.target === r.target && !p.found);
      if (slot) { slot.found = true; slot.xCss = r.xCss; slot.yCss = r.yCss; slot.refined = r.refined; slot.scrolledTo = pass + 1; }
    }
  }
  return result;
}

// FILL-IN-ONE-CALL: fill an entire form server-side in a SINGLE MCP tool call,
// collapsing ~15 round-trips (per-field point → click → type) into one. Reuses
// pointOnce — the SAME "locate targets → CSS coords" helper handlePoint uses —
// so ALL fields (and the submit button) are located in ONE Gemini vision call,
// then each is focused (trusted fast_click_xy) and typed (trusted fast_type)
// sequentially server-side.
//
// args: { fields: { "<field description>": "<value>", ... }, submit?: "<button desc>" }
// returns: { filled:[{field,found,value}], missed:[descriptions not found], submitted:bool }
async function handleFillVision(args) {
  if (!SCOUT_ENABLED) return { disabled: true, reason: 'set GEMINI_API_KEY to enable vision' };
  const fields = args?.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return { error: 'fast_fill_vision needs a fields object: { "<field description>": "<value>", ... }' };
  }
  const fieldKeys = Object.keys(fields);
  if (!fieldKeys.length) return { error: 'fast_fill_vision: fields object is empty' };
  const submit = (typeof args?.submit === 'string' && args.submit.trim()) ? args.submit.trim() : null;

  // Locate every field AND the submit button (if requested) in ONE vision call.
  // confidenceSkip: refine only the ambiguous fields, and in parallel — so the
  // whole form is ~2-3 Gemini calls (capture+locate, then a parallel refine batch
  // ≈ 1 round-trip), not N.
  const targets = submit ? [...fieldKeys, submit] : fieldKeys;
  const located = await pointOnce(targets, args?.refine, { confidenceSkip: true, freshCapture: args?.freshCapture === true });
  if (located.error) return located;
  const points = located.points || [];

  const filled = [];
  const missed = [];
  const clear = args?.clear !== false; // clear existing value before typing (default on)
  // Fill fields sequentially: trusted click to focus, CLEAR, then trusted type.
  for (const key of fieldKeys) {
    const p = points.find((q) => q.target === key);
    if (!p || !p.found) { missed.push(key); continue; }
    const value = String(fields[key] ?? '');
    // Clear-before-type: GCP (and many forms) pre-fill a default (e.g. "API key
    // 4"); a plain focus+type APPENDS, producing "API key 4FastLink...". A
    // TRIPLE-click selects the field's whole contents so the subsequent type
    // REPLACES it. Triple-click is used (not Ctrl+A) because Ctrl+A triggers a
    // page-level select-all on iframe/React widgets.
    if (clear) {
      await callExtension('fast_click_xy', { x: p.xCss, y: p.yCss, clickCount: 3 });
    } else {
      await callExtension('fast_click_xy', { x: p.xCss, y: p.yCss });
    }
    await callExtension('fast_type', { text: value });
    filled.push({ field: key, found: true, value });
  }

  // Submit LAST, after the fields are filled.
  let submitted = false;
  if (submit) {
    let sp = points.find((q) => q.target === submit);
    // If the button wasn't located in the combined pass (e.g. it shifted/scrolled
    // into view only after filling), re-point for it alone once before giving up.
    if (!sp || !sp.found) {
      // Fresh capture: fields were just filled, so the warm (pre-fill) capture
      // may be stale.
      const re = await pointOnce([submit], args?.refine, { confidenceSkip: true, freshCapture: true });
      sp = re.points && re.points[0];
    }
    if (sp && sp.found) {
      await callExtension('fast_click_xy', { x: sp.xCss, y: sp.yCss });
      submitted = true;
    } else {
      missed.push(submit);
    }
  }

  return { filled, missed, submitted };
}

// FAST_DO — the most aggressive speed tier: ONE plain-language intent → a whole
// form filled/operated in a single MCP call, with Gemini doing BOTH the task
// DECOMPOSITION and the element LOCATION. This removes Claude (Opus) from the
// per-field loop entirely (contrast fast_fill_vision, where Opus supplies the
// field→value map and Gemini only locates).
//
// Flow:
//   1. fast_vision_capture → one screenshot.
//   2. planByImage (ONE Gemini multimodal call) → ordered steps
//      [{action:"click"|"type"|"key", target, value?}], decomposed from intent.
//   3. pointByImage (ONE Gemini vision call) → locate ALL step targets at once,
//      convert normalized [y,x] → CSS px (same math as pointOnce).
//   4. Execute sequentially: click → fast_click_xy; type → fast_click_xy +
//      fast_type; key → fast_key_press. Steps whose target wasn't found are
//      skipped and reported.
// SAFETY: a final submit/create/save/delete/confirm click is NEVER executed
// unless the intent explicitly asks to submit — both the planner is told to omit
// it AND a server-side guard strips any that slip through. The form is left
// filled, stopped before commit.
//
// args: { intent: "<plain language goal>" }
// returns: { plan, executed:[...], skipped:[...], note }
const SUBMIT_WORD_RE = /\b(submit|create|save|delete|remove|confirm|continue|finish|done|apply|publish|send|pay|purchase|checkout|next|sign\s?up|register|place\s+order|add\b)/i;
const INTENT_AUTHORIZES_SUBMIT_RE = /\b(submit|create|save|delete|remove|confirm|continue|finish|publish|send|pay|purchase|checkout|register|sign\s?up|place\s+(the\s+)?order|click\s+(the\s+)?\w+\s+button)\b/i;

async function handleDo(args) {
  if (!SCOUT_ENABLED) return { disabled: true, reason: 'set GEMINI_API_KEY to enable vision' };
  const intent = (typeof args?.intent === 'string') ? args.intent.trim() : '';
  if (!intent) return { error: 'fast_do needs an intent string (the plain-language goal)' };

  // 1. ONE screenshot.
  const cap = await callExtension('fast_vision_capture', {});
  const full = cap?.result;
  if (cap?.error || !full?.dataUrl) return { error: cap?.error || 'vision capture failed' };

  // 2. ONE Gemini call: decompose intent → described steps.
  const planned = await planByImage({ intent, base64: full.dataUrl });
  const allSteps = Array.isArray(planned.steps) ? planned.steps : [];
  if (!allSteps.length) {
    return { plan: [], executed: [], skipped: [], note: planned.note || 'planner produced no steps for this intent' };
  }

  // SAFETY: unless the intent explicitly authorizes committing, drop any
  // trailing submit/create/delete-style click the planner emitted. We only strip
  // CLICK steps (typing a value like "Submit" into a field is fine); and only
  // when the target text looks like a commit button.
  const intentAuthorizesSubmit = INTENT_AUTHORIZES_SUBMIT_RE.test(intent);
  const stoppedBefore = [];
  const steps = allSteps.filter((s) => {
    if (intentAuthorizesSubmit) return true;
    if (s.action === 'click' && s.target && SUBMIT_WORD_RE.test(s.target)) {
      stoppedBefore.push(s.target);
      return false;
    }
    return true;
  });

  // 3. Locate every step that needs a coordinate (click/type) in ONE vision call.
  //    'select' steps are routed through fast_select_option (DOM-based, no
  //    coordinate) so they are excluded here — same as 'key'.
  const locatable = steps.filter((s) => s.action !== 'key' && s.action !== 'select' && s.target);
  const targets = locatable.map((s) => s.target);
  let points = [];
  if (targets.length) {
    const { points: pts } = await pointByImage({ targets, base64: full.dataUrl });
    points = (pts || []).map((p) => {
      if (!p || !p.found) return { found: false };
      return {
        found: true,
        xCss: Math.round((p.xNorm / 1000) * full.imgW / full.dpr),
        yCss: Math.round((p.yNorm / 1000) * full.imgH / full.dpr),
      };
    });
  }
  // Map located coords back onto the locatable steps by index (pointByImage
  // preserves order via k, but we keyed targets positionally — match on k when
  // present, else by position).
  const coordByTargetIdx = new Map();
  locatable.forEach((s, idx) => coordByTargetIdx.set(idx, points[idx] || { found: false }));

  // 4. Execute sequentially.
  const executed = [];
  const skipped = [];
  let locIdx = 0;
  for (const s of steps) {
    if (s.action === 'key') {
      const key = s.value || 'Enter';
      await callExtension('fast_key_press', { key });
      executed.push({ action: 'key', value: key });
      continue;
    }
    if (s.action === 'select') {
      // Dropdown/select pick: route through fast_select_option, which resolves
      // the field + option by DOM (piercing shadow roots, handling native
      // <select> whose open list is an OS popup that synthetic clicks miss —
      // GitHub #1 finding #1). No vision coordinate needed, so this is also
      // not in `locatable` and must NOT advance locIdx.
      const res = await callExtension('fast_select_option', { field: s.target, option: String(s.value ?? '') });
      const r = res?.result || {};
      if (res?.error || r.error) {
        skipped.push({ action: 'select', target: s.target, value: String(s.value ?? ''), reason: res?.error || r.error });
      } else {
        executed.push({ action: 'select', target: s.target, value: String(s.value ?? ''), picked: r.picked, kind: r.kind });
      }
      continue;
    }
    const coord = coordByTargetIdx.get(locIdx);
    locIdx++;
    if (!coord || !coord.found) {
      skipped.push({ action: s.action, target: s.target, reason: 'not visible on screen' });
      continue;
    }
    if (s.action === 'type') {
      await callExtension('fast_click_xy', { x: coord.xCss, y: coord.yCss });
      await callExtension('fast_type', { text: String(s.value ?? '') });
      executed.push({ action: 'type', target: s.target, value: String(s.value ?? ''), x: coord.xCss, y: coord.yCss });
    } else { // click
      await callExtension('fast_click_xy', { x: coord.xCss, y: coord.yCss });
      executed.push({ action: 'click', target: s.target, x: coord.xCss, y: coord.yCss });
    }
  }

  let note = planned.note || '';
  if (stoppedBefore.length) {
    const msg = `stopped before ${stoppedBefore.map((t) => `"${t}"`).join(', ')} (intent did not explicitly authorize submit)`;
    note = note ? `${note} | ${msg}` : msg;
  }
  return { plan: steps, executed, skipped, stoppedBefore, note: note || undefined };
}

// SET-OF-MARK pick flow (the "classification beats regression" path). Two-stage:
//   1. Gemini DETECTS a bounding box per target (boxByImage) — gives candidate
//      regions even for non-DOM iframe fields.
//   2. The extension draws a NUMBERED red box on each, and Gemini PICKS the
//      number per target (pickMarks) — classification, ~always right.
// The click point is the detected box's center (CSS px), confirmed by the pick.
// This sidesteps coordinate regression entirely. Returns the same shape as
// fast_point: { points:[{target,found,xCss,yCss,via}] }.
async function handlePointSom(args) {
  if (!SCOUT_ENABLED) return { disabled: true, reason: 'set GEMINI_API_KEY to enable vision' };
  const targets = Array.isArray(args?.targets) ? args.targets : (args?.target ? [args.target] : []);
  if (!targets.length) return { error: 'fast_point_som needs target or targets' };

  // 1. Capture + detect boxes for all targets in one model call.
  const cap = await callExtension('fast_vision_capture', {});
  const full = cap?.result;
  if (cap?.error || !full?.dataUrl) return { error: cap?.error || 'vision capture failed' };
  const { boxes } = await boxByImage({ targets, base64: full.dataUrl });

  // Build CSS-px boxes (numbered by target index k) for whatever was detected.
  // box is normalized [ymin,xmin,ymax,xmax]; convert to CSS px via image dims/dpr.
  const cssBoxes = [];
  const centerByN = new Map();
  for (let k = 0; k < targets.length; k++) {
    const b = boxes.find((q) => q.k === k) || boxes[k];
    if (!b || !b.found || !b.box) continue;
    const [ymin, xmin, ymax, xmax] = b.box;
    const x = (xmin / 1000) * full.imgW / full.dpr;
    const y = (ymin / 1000) * full.imgH / full.dpr;
    const w = ((xmax - xmin) / 1000) * full.imgW / full.dpr;
    const h = ((ymax - ymin) / 1000) * full.imgH / full.dpr;
    cssBoxes.push({ n: k, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
    centerByN.set(k, { xCss: Math.round(x + w / 2), yCss: Math.round(y + h / 2) });
  }
  if (!cssBoxes.length) {
    return { points: targets.map((t) => ({ target: t, found: false })), via: 'som', note: 'no boxes detected' };
  }

  // 2. Annotate the screenshot with numbered boxes, then have Gemini PICK the
  //    number for each target (classification confirmation of the detection).
  const ann = await callExtension('fast_annotate_boxes', { boxes: cssBoxes });
  const annOut = ann?.result;
  let picks = [];
  if (!ann?.error && annOut?.dataUrl) {
    const numbers = cssBoxes.map((b) => b.n);
    const res = await pickMarks({ targets, base64: annOut.dataUrl, numbers });
    picks = res.picks || [];
  }

  const out = [];
  for (let k = 0; k < targets.length; k++) {
    // Prefer Gemini's pick; fall back to the box detected for this same target k.
    const pick = picks.find((p) => p.k === k);
    const n = pick && pick.n != null ? pick.n : (centerByN.has(k) ? k : null);
    const c = n != null ? centerByN.get(n) : null;
    if (!c) { out.push({ target: targets[k], found: false }); continue; }
    out.push({ target: targets[k], found: true, xCss: c.xCss, yCss: c.yCss, via: 'som', n });
  }
  return { points: out, via: 'som' };
}

// RACE THE TIERS — fire the DOM tier (fast_snapshot + text match) AND the vision
// tier (Gemini pointOnce) CONCURRENTLY and return whichever yields a usable hit
// first. The loser is ignored. CRITICAL: a hung/crashing/slow DOM snapshot must
// NOT block the vision answer — the DOM branch is wrapped so any timeout/error
// just yields "no DOM answer" (null) and vision still wins the race. A 3s DOM
// timeout guards against a wedged GCP snapshot stalling things.
//
// args: { target: "<description>", refine?, freshCapture? }
// returns: { via:'dom'|'vision'|null, xCss, yCss, found, target }
const LOCATE_DOM_TIMEOUT_MS = 3000;
async function handleLocate(args) {
  if (!SCOUT_ENABLED) return { disabled: true, reason: 'set GEMINI_API_KEY to enable vision' };
  const target = (typeof args?.target === 'string' && args.target.trim())
    ? args.target.trim()
    : (Array.isArray(args?.targets) && args.targets[0] ? String(args.targets[0]).trim() : '');
  if (!target) return { error: 'fast_locate needs a target string' };

  // DOM tier — full snapshot + text match. Wrapped so a hang (Promise.race vs a
  // 3s timeout) or crash/error collapses to null without ever rejecting.
  const domTier = (async () => {
    const snapP = callExtension('fast_snapshot', { viewport: false });
    const timeoutP = new Promise((resolve) => setTimeout(() => resolve(null), LOCATE_DOM_TIMEOUT_MS));
    const snap = await Promise.race([snapP, timeoutP]);
    if (!snap || snap.error) return null;
    const items = snap?.result?.items;
    if (!Array.isArray(items)) return null;
    const hit = matchItem(items, target);
    if (!hit) return null;
    return { via: 'dom', xCss: hit.xCss, yCss: hit.yCss, found: true, target };
  })().catch(() => null);

  // Vision tier — Gemini point on a (warm or fresh) capture. domFirst:false: this
  // is the pure-vision branch of the race; the DOM tier above already covers DOM
  // matches, so don't make pointOnce snapshot a second time.
  const visionTier = (async () => {
    const r = await pointOnce([target], args?.refine, { freshCapture: args?.freshCapture === true, domFirst: false });
    const p = r && r.points && r.points[0];
    if (!p || !p.found) return null;
    return { via: 'vision', xCss: p.xCss, yCss: p.yCss, found: true, target };
  })().catch(() => null);

  const winner = await pickLocateWinner(domTier, visionTier);
  if (winner) return winner;
  return { via: null, found: false, target };
}

// DOM-PREFERRING race. The DOM tier is more precise (real element box, no model
// jitter) and on a simple page should trivially win — but it pays a full
// snapshot round-trip while vision returns a warm Gemini point in ~700ms, so a
// naive "first truthy wins" lets vision steal pages DOM would have nailed
// (httpbin's labeled <textarea> — the reported bug). Rules:
//   • DOM hit  → DOM wins immediately (most precise, no reason to wait).
//   • DOM miss (resolved null, not hung) → take vision as soon as DOM confirms
//     the miss; no need to burn the grace window.
//   • DOM still pending when vision returns a hit → hold the vision hit for a
//     short GRACE window so a slightly-slower DOM snapshot can still win; if
//     grace elapses with no DOM hit, accept vision.
//   • Both miss → null.
// Bounded throughout: domTier self-caps at LOCATE_DOM_TIMEOUT_MS (resolving
// null), and a hard LOCATE_MAX_MS ceiling resolves with the best hit so far so a
// wedged vision call can never hang the tool.
const LOCATE_DOM_GRACE_MS = 1200;
const LOCATE_MAX_MS = 8000;
function pickLocateWinner(domP, visionP) {
  return new Promise((resolve) => {
    let settled = false;
    let domDone = false, visionDone = false;
    let domHit = null, visionHit = null;
    let graceTimer = null, hardTimer = null;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve(v || null);
    };
    hardTimer = setTimeout(() => finish(domHit || visionHit), LOCATE_MAX_MS);

    Promise.resolve(domP).then((v) => {
      domDone = true; domHit = v || null;
      if (domHit) return finish(domHit);          // DOM wins outright
      if (visionDone) return finish(visionHit);   // DOM confirmed a miss → vision
      // else: DOM missed but vision not back yet → wait for vision branch.
    }, () => { domDone = true; if (visionDone) finish(visionHit); });

    Promise.resolve(visionP).then((v) => {
      visionDone = true; visionHit = v || null;
      if (domDone) return finish(visionHit);       // DOM already settled (a miss)
      // DOM still pending — prefer it: hold a vision hit through the grace window.
      if (visionHit) graceTimer = setTimeout(() => finish(visionHit), LOCATE_DOM_GRACE_MS);
      // vision missed too → let the DOM branch decide when it settles.
    }, () => { visionDone = true; if (domDone) finish(domHit); });
  });
}

// Match a target description against snapshot items[], returning the matched
// element's CENTER in CSS px ({xCss,yCss}) or null. Tries exact label match,
// then substring, then all-words-present. Only considers items with full coords.
function matchItem(items, target) {
  // Normalize for matching: lowercase, collapse whitespace, and strip a trailing
  // ":" / "：" (+ whitespace). A <label> is commonly rendered "Delivery
  // instructions:" while the caller's target is "Delivery instructions" (or vice
  // versa) — without trimming the trailing colon those never match exactly, and
  // a colon-terminated query fails the substring test against a colon-less field.
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[:：\s]+$/, '').trim();
  const q = norm(target);
  if (!q) return null;
  const hasCoords = (it) => ['x', 'y', 'w', 'h'].every((k) => typeof it[k] === 'number');
  const fields = (it) => norm([it.text, it.label, it.ariaLabel, it.placeholder, it.name, it.role, it.href]
    .filter(Boolean).join(' '));
  let best = items.find((it) => hasCoords(it) && fields(it) === q);
  if (!best) best = items.find((it) => hasCoords(it) && fields(it).includes(q));
  if (!best) {
    const words = q.split(/\s+/).filter(Boolean);
    // Include the tag in the per-word search so a control phrased with its type
    // ("delivery instructions textarea", "submit button") still resolves — every
    // word must be present, so the tag only confirms an already-strong match.
    if (words.length) best = items.find((it) => {
      const f = (fields(it) + ' ' + norm(it.tag));
      return hasCoords(it) && words.every((w) => f.includes(w));
    });
  }
  if (!best) return null;
  return { xCss: Math.round(best.x + best.w / 2), yCss: Math.round(best.y + best.h / 2) };
}

// DOM-COORDS-WIN helper: ONE fast_snapshot, then match EVERY target against
// items[] (reusing matchItem). Returns an array aligned to `targets`: a
// {xCss,yCss} center for each confident DOM match, or null where the DOM can't
// see the element (vision handles those). A hung/wedged snapshot collapses to
// "no DOM matches" via a 3s race so it can never stall the vision fallback.
const DOM_LOCATE_TIMEOUT_MS = 3000;
async function domLocate(targets) {
  try {
    const snapP = callExtension('fast_snapshot', { viewport: false });
    const timeoutP = new Promise((resolve) => setTimeout(() => resolve(null), DOM_LOCATE_TIMEOUT_MS));
    const snap = await Promise.race([snapP, timeoutP]);
    const items = snap?.result?.items;
    if (!Array.isArray(items)) return targets.map(() => null);
    return targets.map((t) => matchItem(items, String(t)));
  } catch {
    return targets.map(() => null);
  }
}

// Crop a SHORT horizontal band (CSS px) centered on the coarse point and zoom in,
// then re-point. The band is wide (keeps the field's label for context) but only
// ~1.5 field-heights tall, so it contains the target field and NOT its vertical
// neighbors — that was the bug (a 32%-tall crop held 2-3 stacked fields, so the
// zoom re-locked onto the wrong row). Coords map back via the CSS crop region.
async function refinePoint(target, xCss, yCss, full) {
  try {
    const viewport = await callExtension('fast_evaluate', {
      fn: '() => ({ w: window.innerWidth, h: window.innerHeight })',
    });
    const vp = viewport?.result;
    if (!vp) return null;
    const cw = Math.round(vp.w * 0.40);  // wide: include the label beside/above
    const ch = Math.round(vp.h * 0.16);  // short: ~1.5 fields tall, not 3
    const crop = {
      x: Math.max(0, Math.min(Math.round(xCss - cw / 2), vp.w - cw)),
      y: Math.max(0, Math.min(Math.round(yCss - ch / 2), vp.h - ch)),
      w: cw, h: ch,
    };
    const cap = await callExtension('fast_vision_capture', { crop, zoom: 3 });
    const z = cap?.result;
    if (cap?.error || !z?.dataUrl) return null;
    const { points } = await pointByImage({ targets: [target], base64: z.dataUrl });
    const p = points[0];
    if (!p || !p.found) return null;
    // Normalized within the crop → CSS via the CSS crop region.
    return {
      xCss: crop.x + (p.xNorm / 1000) * crop.w,
      yCss: crop.y + (p.yNorm / 1000) * crop.h,
    };
  } catch {
    return null;
  }
}

// Same diagnostic-only set the extension enforces for macros — keep in sync.
const DIAGNOSTIC_ONLY_STEPS = new Set(['fast_status', 'fast_batch', 'fast_scout', 'fast_point', 'fast_point_som', 'fast_fill_vision', 'fast_do', 'fast_locate']);

// --- Batch inter-step navigation re-bind (BUG-2) ---------------------------
// LIVE-SMOKE BUG: in fast_batch, when an earlier step navigates the tab (e.g. a
// submit-button fast_click → results page), the NEXT step (notably fast_wait)
// timed out at the 30s broker limit even though the navigation completed fine.
// Cause: the click navigated the tab, the content script servicing the next step
// died with the old page, and the next step fired into the dying/old document
// (racing teardown), so its promise "waited on a corpse" and never resolved.
//
// The earlier fix keyed the settle off `willNavigate`, but that flag MISPREDICTS
// — a form-submit click reported willNavigate:false yet DID navigate, so the
// settle never fired. So the re-bind now triggers off ACTUAL navigation: we
// capture the tab URL BEFORE a possibly-navigating step and watch for it to
// change AFTER. On a real change we run the fast_nav-style settle (wait for the
// NEW document to reach interactive|complete) BEFORE dispatching the next step,
// so the next step binds to the live new page. `willNavigate`/nav-actions are
// only a HINT that widens the detection window — never the trigger. All bounded,
// so we can never re-introduce a 30s hang.
const SETTLE_READY_BUDGET_MS = 8000;     // wait for the NEW doc to become ready
const NAV_DETECT_MS = 2500;              // predicted/nav-action: window to observe the commit
const NAV_DETECT_UNPREDICTED_MS = 700;   // backstop window for a MISPREDICTED nav
const SETTLE_PROBE_TIMEOUT_MS = 1500;    // per readyState probe deadline (orphan, don't wait 30s)
const SETTLE_POLL_GAP_MS = 150;          // gap between polls
const SETTLE_INITIAL_GAP_MS = 100;       // let teardown/commit begin before first poll

// Inherently-navigating actions whose result carries no willNavigate flag.
const NAV_ACTIONS = new Set(['fast_nav', 'fast_reload']);

// Steps that can drive a SAME-TAB navigation (so their inter-step result must be
// checked for an actual URL change). Read-only steps and tab-switching steps
// (fast_tab/fast_switch change the ACTIVE tab, not the page) are excluded so they
// add zero latency and never trigger a false "navigated".
const POSSIBLY_NAVIGATING = new Set([
  'fast_click', 'fast_click_xy', 'fast_key', 'fast_key_press',
  'fast_nav', 'fast_reload', 'fast_select_option', 'fast_drag', 'fast_drag_xy',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One bounded readyState probe. Resolves to the readyState string (or null on
// timeout/error). Never rejects, and never blocks past `ms`: a late broker
// resolution after the race is swallowed so it can't leak an unhandled
// rejection or stall the poll loop.
function probeReadyState(ms) {
  const p = callExtension('fast_evaluate', { fn: '() => document.readyState' });
  p.catch(() => {}); // swallow a late rejection once the race has moved on
  return Promise.race([
    p.then((r) => (r && typeof r === 'object' ? r.result : null)).catch(() => null),
    sleep(ms).then(() => null),
  ]);
}

// Read the target tab's current URL WITHOUT attaching the debugger (fast_list is
// a plain chrome.tabs query → no "FastLink is debugging" banner toggle, so it
// can't shift the viewport between batch steps the way fast_evaluate would).
// Prefers the pinned target tab, else the active tab. '' on any failure.
async function batchTabUrl() {
  try {
    const r = await callExtension('fast_list');
    const tabs = r?.result;
    if (!Array.isArray(tabs)) return '';
    const t = tabs.find((x) => x && x.targetTab) || tabs.find((x) => x && x.active);
    return t?.url || '';
  } catch {
    return '';
  }
}

// Detect whether a step ACTUALLY navigated the tab and, if so, wait (bounded)
// for the new document to be ready before the next step runs. `urlBefore` is the
// tab URL captured BEFORE the step. `willNavigateHint` (the click's prediction)
// and nav-actions only WIDEN the detection window — the trigger is the observed
// URL change, never the hint. Returns the new URL on a settled navigation, else
// null (no navigation → caller adds ~the detect window and moves on).
async function settleIfNavigated(stepName, urlBefore, willNavigateHint) {
  const isNavAction = NAV_ACTIONS.has(stepName);
  const predicted = willNavigateHint === true || isNavAction;
  const detectBudget = predicted ? NAV_DETECT_MS : NAV_DETECT_UNPREDICTED_MS;
  await sleep(SETTLE_INITIAL_GAP_MS);
  // Phase 1 — watch the committed URL change away from urlBefore (real nav).
  let navUrl = null;
  const detectDeadline = Date.now() + detectBudget;
  while (Date.now() < detectDeadline) {
    const url = await batchTabUrl();
    if (url && urlBefore && url !== urlBefore) { navUrl = url; break; }
    await sleep(SETTLE_POLL_GAP_MS);
  }
  // No URL change: no real navigation (covers a plain non-navigating click AND an
  // over-predicted willNavigate that turned out to be an in-page / AJAX submit).
  // Only a same-URL nav-action (reload / re-nav to the same URL) still needs a
  // readyState settle even though the URL didn't change.
  if (!navUrl && !isNavAction) return null;
  // Phase 2 — wait until the (new) document answers interactive|complete so the
  // next step binds to the live page, mirroring fast_nav's post-nav health-check.
  const readyDeadline = Date.now() + SETTLE_READY_BUDGET_MS;
  while (Date.now() < readyDeadline) {
    const state = await probeReadyState(SETTLE_PROBE_TIMEOUT_MS);
    if (state === 'interactive' || state === 'complete') break;
    await sleep(SETTLE_POLL_GAP_MS);
  }
  return navUrl || (await batchTabUrl()) || urlBefore || '';
}

async function runBatch(args) {
  const actions = Array.isArray(args?.actions) ? args.actions : [];
  const continueOnError = !!args?.continueOnError;
  const results = [];
  for (let i = 0; i < actions.length; i++) {
    const step = actions[i] || {};
    if (!step.name || DIAGNOSTIC_ONLY_STEPS.has(step.name)) {
      results.push({ step: i, name: step.name || null, error: step.name ? `"${step.name}" is a diagnostic-only tool (not allowed as a batch step)` : 'Invalid step (missing name)' });
      if (!continueOnError) break;
      continue;
    }
    // Capture the URL BEFORE a possibly-navigating step that has a follower, so we
    // can detect an ACTUAL navigation afterward (the in-flight commit may lag the
    // step's own return, so before-vs-after is the only reliable signal).
    const navCandidate = i < actions.length - 1 && POSSIBLY_NAVIGATING.has(step.name);
    const urlBefore = navCandidate ? await batchTabUrl() : null;
    try {
      const r = await callExtension(step.name, step.args || {});
      if (r && r.error) {
        results.push({ step: i, name: step.name, ok: false, ...r });
        if (!continueOnError) break;
      } else {
        results.push({ step: i, name: step.name, ok: true, result: r.result });
        // If this step actually navigated the tab, settle on the new document
        // before dispatching the next step so it binds to the live page (BUG-2).
        if (navCandidate) {
          await settleIfNavigated(step.name, urlBefore, r.result && r.result.willNavigate);
        }
      }
    } catch (e) {
      results.push({ step: i, name: step.name, ok: false, error: e.message });
      if (!continueOnError) break;
    }
  }
  return { ran: results.length, total: actions.length, results };
}

function saveScreenshot(result) {
  const ext = (result.format || 'png').toLowerCase();
  const path = join(tmpdir(), `fastlink-screenshot-${Date.now()}.${ext}`);
  const base64 = result.dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const bytes = Buffer.from(base64, 'base64');
  writeFileSync(path, bytes);
  sweepOldScreenshots();
  return { path, format: ext, bytes: bytes.length };
}

// Delete fastlink-screenshot-* files older than 24h. Cheap readdir on
// /tmp; runs once at startup and again after each save.
const SCREENSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SCREENSHOT_PREFIX = 'fastlink-screenshot-';
export function sweepOldScreenshots() {
  const dir = tmpdir();
  const cutoff = Date.now() - SCREENSHOT_MAX_AGE_MS;
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (!name.startsWith(SCREENSHOT_PREFIX)) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.mtimeMs < cutoff) unlinkSync(full);
    } catch {}
  }
}
