// src/composite.js — server-side composite tool orchestration (relay-core)
//
// Ported from fast-dxt/server/handlers.js. These are the Gemini-backed tiers that
// orchestrate MULTIPLE browser primitives + model calls inside a single MCP tool
// call (so Claude/Opus is removed from the per-field loop). Each handler takes:
//   relay  — the UserRelay DO (relay.callExtension drives the browser)
//   scout  — a createScout() instance (the Gemini client)
//   args   — the tool arguments
//
// Differences from the WSL handlers.js:
//   • No filesystem: screenshots are never saved to /tmp here (mcp.js returns
//     fast_screenshot/fast_marks as MCP image content instead).
//   • No pre-warm / warm-capture reuse: every vision tier captures a FRESH
//     screenshot (the cloud relay doesn't wire navigation pre-warm in v1).
//   • refinePoint reads the viewport size from the capture metadata
//     (imgW/imgH/dpr) instead of fast_evaluate (which is OFF in cloud mode).
//
// See SPEC.md §3e and task #7.

const REFINE_SIZE_FRAC = 0.05;  // target narrower than 5% of width → crop-zoom
const REFINE_CONFIDENCE = 0.75; // coarse hit at/above this is trusted (skip refine)
const CLEAN_GAP_CSS = 44;       // nearest found neighbor ≥ this (px) for "clean spacing"

// Escalating DOM snapshot tiers for fast_scout (Gemini brokers them).
const SNAPSHOT_TIERS = [
  { label: 'viewport', snap: { viewport: true } },
  { label: 'full', snap: { viewport: false } },
  { label: 'overlay', snap: { viewport: false, overlay: true } },
];

// === fast_scout =============================================================

export async function handleScout(relay, scout, args) {
  const intent = args?.intent;
  if (!scout.enabled) {
    return { disabled: true, reason: 'set GEMINI_API_KEY (relay secret) to enable the scout', brief: null, steps: [] };
  }
  const macroRes = await relay.callExtension('fast_macro_list').catch(() => null);
  const raw = macroRes?.result;
  const macros = Array.isArray(raw?.macros) ? raw.macros : (Array.isArray(raw) ? raw : []);

  let result;
  let degraded = false; // a DOM tier timed out / came back capped|partial → go vision
  for (let t = 0; t < SNAPSHOT_TIERS.length; t++) {
    const tier = SNAPSHOT_TIERS[t];
    const last = t === SNAPSHOT_TIERS.length - 1;
    const snap = await scoutSnapshot(relay, tier.snap);
    if (snap?.error) { degraded = true; if (last) break; continue; }
    const digest = snap?.result;
    if (!digest || !Array.isArray(digest.items)) {
      if (last) { degraded = true; break; }
      continue;
    }
    const heavy = !!(digest.capped || digest.partial || digest.snapshotTimedOut);
    result = await scout.scout({ intent, digest, macros });
    result.tier = tier.label;
    // READ MODE on a HEAVY page: DOM index too sparse to summarize → vision read.
    if (!intent && !result.disabled && heavy) {
      const vis = await visionScoutRead(relay, scout, null);
      if (vis) return vis;
    }
    if (!intent || result.disabled || !result.needMore) return result;
    // HEAVY-PAGE SHORT-CIRCUIT: degraded snapshot → don't escalate onto bigger DOM
    // tiers (they'd just hang on the same giant DOM); go to vision below.
    if (heavy) { degraded = true; break; }
  }
  // INTENT MODE, DOM tiers exhausted/degraded → SCREENSHOT rung.
  if (intent && ((result && result.needMore) || degraded)) {
    const located = await screenshotRung(relay, scout, intent);
    if (located) return located;
    const vis = await visionScoutRead(relay, scout, intent);
    if (vis) return { ...(result || {}), ...vis };
  }
  // READ MODE where every DOM tier errored/timed out → screenshot→Gemini read.
  if (!intent && (degraded || !result)) {
    const vis = await visionScoutRead(relay, scout, null);
    if (vis) return vis;
  }
  return result || {
    error: 'scout: no usable snapshot (page heavy/unresponsive). Try fast_screenshot, fast_point, or reload the tab.',
  };
}

// Per-tier snapshot deadline (mirror of handlers.js). The extension serialize is
// self-bounded, but a wedged renderer can burn the full 30s per tier — race each
// snapshot against a tighter deadline so fast_scout stays responsive on heavy
// pages instead of stacking 30s timeouts across three tiers.
const SCOUT_SNAPSHOT_TIMEOUT_MS = 8000;
async function scoutSnapshot(relay, snapArgs) {
  const snapP = relay.callExtension('fast_snapshot', snapArgs);
  const timeoutP = new Promise((resolve) =>
    setTimeout(() => resolve({ error: 'scout: snapshot timed out (page too heavy/unresponsive)' }), SCOUT_SNAPSHOT_TIMEOUT_MS));
  return Promise.race([snapP, timeoutP]);
}

// Screenshot→Gemini page comprehension — the DOM-INDEPENDENT scout read, used
// when the DOM index is too heavy/degraded to summarize (GCP and other giant
// SPAs). Best-effort: returns null on any failure so the caller can fall back.
// No warm-capture reuse in cloud v1 — always a fresh capture.
async function visionScoutRead(relay, scout, intent) {
  try {
    const cap = await captureForVision(relay);
    if (cap.error || !cap.dataUrl) return null;
    const vm = await scout.visualMap(cap.url || '', cap.dataUrl);
    if (!vm || vm.disabled) return null;
    return { tier: 'vision', via: 'screenshot', warmed: !!vm.warmed, url: cap.url,
             summary: vm.summary, regions: vm.regions,
             intent: intent || undefined, note: 'heavy DOM — vision (screenshot) read' };
  } catch {
    return null;
  }
}

async function screenshotRung(relay, scout, intent, candidateIds) {
  try {
    const a = Array.isArray(candidateIds) && candidateIds.length ? { only: candidateIds } : {};
    const res = await relay.callExtension('fast_marks', a);
    if (res?.error) return null;
    const out = res?.result;
    if (!out || !out.dataUrl || !Array.isArray(out.marks) || !out.marks.length) return null;

    const { i, reason } = await scout.locateByImage({ intent, dataUrl: out.dataUrl, marks: out.marks });
    if (i == null) {
      return { tier: 'screenshot', needMore: true, needsMoreInfo: `Could not visually locate the element to "${intent}" in the screenshot. Try a more specific intent, scroll to the target, or open the relevant menu/section first.`, steps: [] };
    }
    const mark = out.marks.find((m) => m && m.i === i);
    if (!mark || typeof mark.cx !== 'number' || typeof mark.cy !== 'number') {
      return { tier: 'screenshot', needMore: true, needsMoreInfo: `Gemini chose box ${i}, but no coordinates were available for it.`, steps: [] };
    }
    return {
      tier: 'screenshot',
      brief: `Visually located the target (box ${i}: ${reason || 'matched'}). Trusted-click its center. If the intent requires typing afterward, follow with fast_type.`,
      steps: [{ name: 'fast_click_xy', args: { x: mark.cx, y: mark.cy, _ref: i } }],
      located: { i, reason },
      needMore: false,
    };
  } catch {
    return null;
  }
}

// === vision capture + point (shared by fast_point / fill_vision / locate) ====

// Fresh capture only (no warm-capture reuse in cloud v1).
async function captureForVision(relay) {
  const cap = await relay.callExtension('fast_vision_capture', {});
  const full = cap?.result;
  if (cap?.error || !full?.dataUrl) return { error: cap?.error || 'vision capture failed' };
  return full;
}

// Capture once, point at all targets, return per-target {found,xCss,yCss,refined}.
async function pointOnce(relay, scout, targets, refineMode, opts = {}) {
  const refine = refineMode !== false;
  const forced = refineMode === true || refineMode === 'always';
  const confidenceSkip = opts.confidenceSkip === true;
  // DOM-COORDS-WIN: resolve targets against the DOM first (exact snapshot rects
  // beat vision regression); only fall to Gemini vision for the leftovers.
  const domFirst = opts.domFirst !== false;
  const domHits = domFirst ? await domLocate(relay, targets) : targets.map(() => null);
  const remaining = [];
  targets.forEach((t, k) => { if (!domHits[k]) remaining.push(t); });

  const assemble = (visionOut) => {
    const out = [];
    let vi = 0;
    for (let k = 0; k < targets.length; k++) {
      if (domHits[k]) out.push({ target: targets[k], found: true, xCss: domHits[k].xCss, yCss: domHits[k].yCss, refined: false, via: 'dom' });
      else out.push(visionOut[vi++] || { target: targets[k], found: false });
    }
    return { points: out };
  };

  if (!remaining.length) return assemble([]);

  const full = await captureForVision(relay);
  if (full.error) {
    if (domHits.some(Boolean)) return assemble(remaining.map((t) => ({ target: t, found: false })));
    return { error: full.error };
  }
  const { points } = await scout.pointByImage({ targets: remaining, base64: full.dataUrl });

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

  const jobs = remaining.map((t, k) => {
    const c = coarse[k];
    if (!c.found) return null;
    const small = c.sizeFrac != null && c.sizeFrac < REFINE_SIZE_FRAC;
    const below = foundYs.filter((y) => y < c.yCss - 1).pop();
    const above = foundYs.filter((y) => y > c.yCss + 1).shift();
    const gap = Math.min(below != null ? c.yCss - below : Infinity, above != null ? above - c.yCss : Infinity);
    let want;
    if (confidenceSkip) {
      const confident = c.confidence != null && c.confidence >= REFINE_CONFIDENCE;
      const cleanSpacing = gap >= CLEAN_GAP_CSS;
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

  const refinedByK = new Map();
  await Promise.all(jobs.map((j) => {
    if (!j) return null;
    return refinePoint(relay, scout, j.target, j.xCss, j.yCss, full)
      .then((r) => { if (r && r.yCss >= j.loY && r.yCss <= j.hiY) refinedByK.set(j.k, r); })
      .catch(() => {});
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

// Crop a short horizontal band centered on the coarse point, zoom, re-point.
// Viewport size comes from the capture metadata (no fast_evaluate in cloud mode).
async function refinePoint(relay, scout, target, xCss, yCss, full) {
  try {
    const vp = { w: full.imgW / full.dpr, h: full.imgH / full.dpr };
    if (!vp.w || !vp.h) return null;
    const cw = Math.round(vp.w * 0.40);
    const ch = Math.round(vp.h * 0.16);
    const crop = {
      x: Math.max(0, Math.min(Math.round(xCss - cw / 2), vp.w - cw)),
      y: Math.max(0, Math.min(Math.round(yCss - ch / 2), vp.h - ch)),
      w: cw, h: ch,
    };
    const cap = await relay.callExtension('fast_vision_capture', { crop, zoom: 3 });
    const z = cap?.result;
    if (cap?.error || !z?.dataUrl) return null;
    const { points } = await scout.pointByImage({ targets: [target], base64: z.dataUrl });
    const p = points[0];
    if (!p || !p.found) return null;
    return { xCss: crop.x + (p.xNorm / 1000) * crop.w, yCss: crop.y + (p.yNorm / 1000) * crop.h };
  } catch {
    return null;
  }
}

// === fast_point =============================================================

export async function handlePoint(relay, scout, args) {
  if (!scout.enabled) return { disabled: true, reason: 'set GEMINI_API_KEY (relay secret) to enable vision' };
  const targets = Array.isArray(args?.targets) ? args.targets : (args?.target ? [args.target] : []);
  if (!targets.length) return { error: 'fast_point needs target (string) or targets (array)' };
  const scroll = args?.scroll === true;

  let result = await pointOnce(relay, scout, targets, args?.refine);
  if (result.error) return result;
  if (!scroll) return result;

  const MAX_PASSES = 4;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const missing = result.points.filter((p) => !p.found);
    if (!missing.length) break;
    await relay.callExtension('fast_wheel', { x: 900, y: 400, deltaY: 500 }).catch(() => {});
    const retry = await pointOnce(relay, scout, missing.map((m) => m.target), args?.refine);
    if (retry.error || !retry.points) continue;
    for (const r of retry.points) {
      if (!r.found) continue;
      const slot = result.points.find((p) => p.target === r.target && !p.found);
      if (slot) { slot.found = true; slot.xCss = r.xCss; slot.yCss = r.yCss; slot.refined = r.refined; slot.scrolledTo = pass + 1; }
    }
  }
  return result;
}

// === fast_fill_vision =======================================================

export async function handleFillVision(relay, scout, args) {
  if (!scout.enabled) return { disabled: true, reason: 'set GEMINI_API_KEY (relay secret) to enable vision' };
  const fields = args?.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return { error: 'fast_fill_vision needs a fields object: { "<field description>": "<value>", ... }' };
  }
  const fieldKeys = Object.keys(fields);
  if (!fieldKeys.length) return { error: 'fast_fill_vision: fields object is empty' };
  const submit = (typeof args?.submit === 'string' && args.submit.trim()) ? args.submit.trim() : null;

  const targets = submit ? [...fieldKeys, submit] : fieldKeys;
  const located = await pointOnce(relay, scout, targets, args?.refine, { confidenceSkip: true });
  if (located.error) return located;
  const points = located.points || [];

  const filled = [];
  const missed = [];
  const clear = args?.clear !== false;
  for (const key of fieldKeys) {
    const p = points.find((q) => q.target === key);
    if (!p || !p.found) { missed.push(key); continue; }
    const value = String(fields[key] ?? '');
    if (clear) await relay.callExtension('fast_click_xy', { x: p.xCss, y: p.yCss, clickCount: 3 });
    else await relay.callExtension('fast_click_xy', { x: p.xCss, y: p.yCss });
    await relay.callExtension('fast_type', { text: value });
    filled.push({ field: key, found: true, value });
  }

  let submitted = false;
  if (submit) {
    let sp = points.find((q) => q.target === submit);
    if (!sp || !sp.found) {
      const re = await pointOnce(relay, scout, [submit], args?.refine, { confidenceSkip: true });
      sp = re.points && re.points[0];
    }
    if (sp && sp.found) { await relay.callExtension('fast_click_xy', { x: sp.xCss, y: sp.yCss }); submitted = true; }
    else missed.push(submit);
  }

  return { filled, missed, submitted };
}

// === fast_do ================================================================

const SUBMIT_WORD_RE = /\b(submit|create|save|delete|remove|confirm|continue|finish|done|apply|publish|send|pay|purchase|checkout|next|sign\s?up|register|place\s+order|add\b)/i;
const INTENT_AUTHORIZES_SUBMIT_RE = /\b(submit|create|save|delete|remove|confirm|continue|finish|publish|send|pay|purchase|checkout|register|sign\s?up|place\s+(the\s+)?order|click\s+(the\s+)?\w+\s+button)\b/i;

export async function handleDo(relay, scout, args) {
  if (!scout.enabled) return { disabled: true, reason: 'set GEMINI_API_KEY (relay secret) to enable vision' };
  const intent = (typeof args?.intent === 'string') ? args.intent.trim() : '';
  if (!intent) return { error: 'fast_do needs an intent string (the plain-language goal)' };

  const cap = await relay.callExtension('fast_vision_capture', {});
  const full = cap?.result;
  if (cap?.error || !full?.dataUrl) return { error: cap?.error || 'vision capture failed' };

  const planned = await scout.planByImage({ intent, base64: full.dataUrl });
  const allSteps = Array.isArray(planned.steps) ? planned.steps : [];
  if (!allSteps.length) return { plan: [], executed: [], skipped: [], note: planned.note || 'planner produced no steps for this intent' };

  const intentAuthorizesSubmit = INTENT_AUTHORIZES_SUBMIT_RE.test(intent);
  const stoppedBefore = [];
  const steps = allSteps.filter((s) => {
    if (intentAuthorizesSubmit) return true;
    if (s.action === 'click' && s.target && SUBMIT_WORD_RE.test(s.target)) { stoppedBefore.push(s.target); return false; }
    return true;
  });

  const locatable = steps.filter((s) => s.action !== 'key' && s.target);
  const targets = locatable.map((s) => s.target);
  let points = [];
  if (targets.length) {
    const { points: pts } = await scout.pointByImage({ targets, base64: full.dataUrl });
    points = (pts || []).map((p) => {
      if (!p || !p.found) return { found: false };
      return { found: true, xCss: Math.round((p.xNorm / 1000) * full.imgW / full.dpr), yCss: Math.round((p.yNorm / 1000) * full.imgH / full.dpr) };
    });
  }
  const coordByTargetIdx = new Map();
  locatable.forEach((s, idx) => coordByTargetIdx.set(idx, points[idx] || { found: false }));

  const executed = [];
  const skipped = [];
  let locIdx = 0;
  for (const s of steps) {
    if (s.action === 'key') {
      const key = s.value || 'Enter';
      await relay.callExtension('fast_key_press', { key });
      executed.push({ action: 'key', value: key });
      continue;
    }
    const coord = coordByTargetIdx.get(locIdx);
    locIdx++;
    if (!coord || !coord.found) { skipped.push({ action: s.action, target: s.target, reason: 'not visible on screen' }); continue; }
    if (s.action === 'type') {
      await relay.callExtension('fast_click_xy', { x: coord.xCss, y: coord.yCss });
      await relay.callExtension('fast_type', { text: String(s.value ?? '') });
      executed.push({ action: 'type', target: s.target, value: String(s.value ?? ''), x: coord.xCss, y: coord.yCss });
    } else {
      await relay.callExtension('fast_click_xy', { x: coord.xCss, y: coord.yCss });
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

// === fast_point_som (Set-of-Mark) ===========================================

export async function handlePointSom(relay, scout, args) {
  if (!scout.enabled) return { disabled: true, reason: 'set GEMINI_API_KEY (relay secret) to enable vision' };
  const targets = Array.isArray(args?.targets) ? args.targets : (args?.target ? [args.target] : []);
  if (!targets.length) return { error: 'fast_point_som needs target or targets' };

  const cap = await relay.callExtension('fast_vision_capture', {});
  const full = cap?.result;
  if (cap?.error || !full?.dataUrl) return { error: cap?.error || 'vision capture failed' };
  const { boxes } = await scout.boxByImage({ targets, base64: full.dataUrl });

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
  if (!cssBoxes.length) return { points: targets.map((t) => ({ target: t, found: false })), via: 'som', note: 'no boxes detected' };

  const ann = await relay.callExtension('fast_annotate_boxes', { boxes: cssBoxes });
  const annOut = ann?.result;
  let picks = [];
  if (!ann?.error && annOut?.dataUrl) {
    const numbers = cssBoxes.map((b) => b.n);
    const res = await scout.pickMarks({ targets, base64: annOut.dataUrl, numbers });
    picks = res.picks || [];
  }

  const out = [];
  for (let k = 0; k < targets.length; k++) {
    const pick = picks.find((p) => p.k === k);
    const n = pick && pick.n != null ? pick.n : (centerByN.has(k) ? k : null);
    const c = n != null ? centerByN.get(n) : null;
    if (!c) { out.push({ target: targets[k], found: false }); continue; }
    out.push({ target: targets[k], found: true, xCss: c.xCss, yCss: c.yCss, via: 'som', n });
  }
  return { points: out, via: 'som' };
}

// === fast_locate (race DOM vs vision) =======================================

const LOCATE_DOM_TIMEOUT_MS = 3000;

export async function handleLocate(relay, scout, args) {
  if (!scout.enabled) return { disabled: true, reason: 'set GEMINI_API_KEY (relay secret) to enable vision' };
  const target = (typeof args?.target === 'string' && args.target.trim())
    ? args.target.trim()
    : (Array.isArray(args?.targets) && args.targets[0] ? String(args.targets[0]).trim() : '');
  if (!target) return { error: 'fast_locate needs a target string' };

  const domTier = (async () => {
    const snapP = relay.callExtension('fast_snapshot', { viewport: false });
    const timeoutP = new Promise((resolve) => setTimeout(() => resolve(null), LOCATE_DOM_TIMEOUT_MS));
    const snap = await Promise.race([snapP, timeoutP]);
    if (!snap || snap.error) return null;
    const items = snap?.result?.items;
    if (!Array.isArray(items)) return null;
    const hit = matchItem(items, target);
    if (!hit) return null;
    return { via: 'dom', xCss: hit.xCss, yCss: hit.yCss, found: true, target };
  })().catch(() => null);

  const visionTier = (async () => {
    const r = await pointOnce(relay, scout, [target], args?.refine, { domFirst: false });
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

// === DOM matching helpers ===================================================

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

const DOM_LOCATE_TIMEOUT_MS = 3000;
async function domLocate(relay, targets) {
  try {
    const snapP = relay.callExtension('fast_snapshot', { viewport: false });
    const timeoutP = new Promise((resolve) => setTimeout(() => resolve(null), DOM_LOCATE_TIMEOUT_MS));
    const snap = await Promise.race([snapP, timeoutP]);
    const items = snap?.result?.items;
    if (!Array.isArray(items)) return targets.map(() => null);
    return targets.map((t) => matchItem(items, String(t)));
  } catch {
    return targets.map(() => null);
  }
}
