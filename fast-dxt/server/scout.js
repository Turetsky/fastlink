// Scout brain — turns a page digest + Claude's intent into an action plan,
// using a fast model (Gemini Flash via OpenRouter) instead of burning Claude
// round-trips on page discovery.
//
// The digest is whatever fast_snapshot already produces: items[] with stable
// `i` ids (resolvable by fast_click/fast_fill), labels, roles — walked across
// open shadow roots and same-origin iframes. We don't re-walk the DOM here.
//
// Two stages, mirroring the design:
//   1. buildPageMap(digest) — comprehension of the page. The expensive read.
//      Cached per url+content-hash. This is the part meant to be PRE-WARMED on
//      navigation so it's already warm by the time Claude states intent.
//   2. overlayIntent(map)   — map the intent onto the cached page map. Tiny,
//      fast, the only call on the critical path once the page map is warm.
import { SCOUT_ENABLED, GEMINI_API_KEY, GEMINI_MODEL } from './config.js';
import { log } from './log.js';

const pageMapCache = new Map(); // url -> { hash, map }
const visualMapCache = new Map(); // url -> { hash, map } — VISION pre-warm

// ── Heavy-page guards (GCP and other giant SPAs) ──
// On a giant SPA a single snapshot can carry thousands of interactive items.
// Sending them all to Gemini makes the call slow AND degrades the output —
// gemini-2.5-flash-lite returns empty/garbage JSON on a huge prompt, which is
// the "empty briefs" symptom. Cap the digest to the items most useful for acting
// (labeled ones first). Light pages sit far below the cap and are untouched.
const MAX_SCOUT_ITEMS = 300;
// Hard ceiling on a single Gemini call. The fetch has no native timeout, so a
// slow/stuck request would otherwise hang the whole fast_scout tool call until
// the caller's broker/relay 30s limit fires. Bound it so scout always returns.
const GEMINI_TIMEOUT_MS = 12_000;

// The tiered toolbox the planner may emit — each maps 1:1 to an existing
// fast_* tool, so steps are directly runnable via fast_batch. Two tiers for
// click/type: cheap injected (default) and trusted CDP (for stubborn widgets).
// Arg names are EXACT.
const ALLOWED_STEPS = [
  'fast_click {text}  — DEFAULT click, by the element\'s visible label (injected).',
  'fast_click_xy {x, y}  — TRUSTED real-mouse click at a coordinate. Use the element\'s cx,cy from items[]. Prefer this for items with inFrame:true and for React/LWC/custom-component controls where injected clicks silently fail.',
  'fast_fill {match, value}  — set an input/textarea by its label/placeholder (match).',
  'fast_type {text}  — TRUSTED typing into the focused element. Use AFTER fast_click_xy to enter text into React/LWC/iframe inputs that ignore fast_fill.',
  'fast_select_option {field, option}',
  'fast_hover {text}',
  'fast_scroll {to|pixels}',
  'fast_key {key, modifiers}  — keyboard shortcut, e.g. {key:"a",modifiers:["ctrl"]}, {key:"c",modifiers:["meta"]}.',
  'fast_key_press {key}  — a single key with no modifier (Enter, Escape, ArrowDown...).',
  'fast_nav {url}',
].join(' | ');

export async function scout({ intent, digest, macros }) {
  if (!SCOUT_ENABLED) {
    return { disabled: true, reason: 'set GEMINI_API_KEY to enable the scout', brief: null, steps: [] };
  }
  const slim = slimDigest(digest);
  const saved = slimMacros(macros);
  const map = await getPageMap(slim);
  // No intent → behave like a (smarter) snapshot: return the page-map
  // comprehension itself. This is what's already warm in cache from page load,
  // so Claude gets it straight off the socket. savedActions tells Claude which
  // reusable recipes exist for this page.
  if (!intent) {
    return { warmed: map.warmed, url: slim.url, summary: map.summary, elements: map.elements, savedActions: saved };
  }
  // With an intent → overlay it and return a runnable plan. plan.needMore lets
  // the caller (handlers.js) escalate to a bigger snapshot and run again.
  const plan = await overlayIntent(map, intent, slim, saved);
  return {
    warmed: map.warmed, url: slim.url, brief: plan.brief, steps: plan.steps,
    savedActions: saved, needMore: plan.needMore, needMoreReason: plan.needMoreReason,
    needsMoreInfo: plan.needsMoreInfo,
  };
}

// VISION pre-warm: build (+cache) a "visual page map" from a screenshot — a
// terse comprehension of the page and its main interactive regions, keyed by
// url + a cheap image hash. Mirrors getPageMap but for pixels instead of the
// DOM digest, so a fast_point shortly after navigation has warm visual context.
// ONE Gemini pass. Best-effort: callers swallow errors.
export async function visualMap(url, base64) {
  if (!SCOUT_ENABLED) return { disabled: true };
  if (!base64 || typeof base64 !== 'string') return { disabled: true };
  const img = base64.replace(/^data:image\/\w+;base64,/, '');
  const hash = cheapImageHash(img);
  const cached = visualMapCache.get(url);
  if (cached && cached.hash === hash) return { ...cached.map, warmed: true };
  const map = await buildVisualMap(img);
  visualMapCache.set(url, { hash, map });
  return { ...map, warmed: false };
}

// Synchronous read of an already-warmed visual map (no Gemini call). Returns
// null if nothing is cached for this url. Lets the critical path reuse warm
// context without paying for a model call.
export function getVisualMap(url) {
  const c = visualMapCache.get(url);
  return c ? c.map : null;
}

async function buildVisualMap(img) {
  const prompt = [
    'You are a fast web-page scout looking at a browser SCREENSHOT. Produce a',
    'concise visual understanding of the page: what it is, and its main',
    'interactive regions (forms, primary buttons, nav, search). For each region',
    'give a short label and a rough location (e.g. "top-left", "center form",',
    '"right sidebar"). Respond with strict JSON:',
    '{"summary": string, "regions": [{"label": string, "where": string}]}.',
    'Keep it terse; include only regions that matter for acting on the page.',
  ].join(' ');
  const out = await callModelParts({
    parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: img } }],
    maxTokens: 800,
  });
  return {
    summary: out.summary || '',
    regions: Array.isArray(out.regions) ? out.regions : [],
  };
}

// Cheap hash of a screenshot so the visual-map cache invalidates when the page
// actually changes, not on identical re-captures. Sampling every ~64th char of
// the base64 keeps it O(1)-ish for large images while staying change-sensitive.
function cheapImageHash(img) {
  let h = 0;
  const step = Math.max(1, Math.floor(img.length / 1024));
  for (let i = 0; i < img.length; i += step) h = (h * 31 + img.charCodeAt(i)) | 0;
  return `${img.length}:${h}`;
}

// Compact the saved-action store for the model: just name, description, length.
function slimMacros(macros) {
  return (macros || []).map((m) => prune({
    name: m.name,
    description: m.description || undefined,
    steps: (m.actions || m.steps || []).length || undefined,
  }));
}

// Pre-warm path: build + cache the page map without an intent. Call on
// navigation so the comprehension is ready before Claude asks.
export async function warm(digest) {
  if (!SCOUT_ENABLED) return { disabled: true };
  const slim = slimDigest(digest);
  const map = await getPageMap(slim);
  return { warmed: map.warmed, url: slim.url, elements: map.elements.length };
}

// Strip a fast_snapshot result down to what the model needs to reason: stable
// ids + semantic labels, no coordinates. Keeps the prompt small.
function slimDigest(d) {
  const items = (d.items || []).map((it) => prune({
    i: it.i,
    tag: it.tag,
    role: it.role || undefined,
    text: it.text || undefined,
    label: it.label || undefined,
    placeholder: it.placeholder || undefined,
    name: it.name || undefined,
    ariaLabel: it.ariaLabel || undefined,
    href: it.href || undefined,
    // Center coords (for the trusted fast_click_xy tier) + iframe flag, so the
    // planner can pick the right tier per element.
    cx: (typeof it.x === 'number' && typeof it.w === 'number') ? Math.round(it.x + it.w / 2) : undefined,
    cy: (typeof it.y === 'number' && typeof it.h === 'number') ? Math.round(it.y + it.h / 2) : undefined,
    inFrame: it.inFrame || undefined,
    // Item lives in an open menu/listbox/popover (overlay tier). The planner
    // should prefer these when the intent is to pick from a just-opened dropdown.
    inOverlay: it.inOverlay || undefined,
  }));
  const content = (d.content || []).map((c) => c.text).filter(Boolean).slice(0, 40);
  const capped = capItems(items);
  return {
    url: d.url, title: d.title, items: capped.items, content,
    // Tell the planner the digest was trimmed so it can prefer the screenshot
    // rung over guessing when its target isn't among the kept items.
    itemsTotal: capped.truncated ? items.length : undefined,
    itemsTruncated: capped.truncated || undefined,
  };
}

// Cap the item list sent to Gemini. Keep items that carry an actionable label
// (text/label/aria/placeholder/name) FIRST — those are what the planner reasons
// over — then backfill with the rest up to the cap, preserving DOM order within
// each group. Returns { items, truncated }. A no-op below the cap (light pages).
function capItems(items) {
  if (items.length <= MAX_SCOUT_ITEMS) return { items, truncated: false };
  const labeled = [];
  const bare = [];
  for (const it of items) {
    (it.text || it.label || it.ariaLabel || it.placeholder || it.name ? labeled : bare).push(it);
  }
  const kept = labeled.slice(0, MAX_SCOUT_ITEMS);
  for (const it of bare) { if (kept.length >= MAX_SCOUT_ITEMS) break; kept.push(it); }
  return { items: kept, truncated: true };
}

async function getPageMap(slim) {
  const hash = digestHash(slim);
  const cached = pageMapCache.get(slim.url);
  if (cached && cached.hash === hash) {
    return { ...cached.map, warmed: true };
  }
  const map = await buildPageMap(slim);
  pageMapCache.set(slim.url, { hash, map });
  return { ...map, warmed: false };
}

async function buildPageMap(slim) {
  const system = [
    'You are a fast web-page scout. You receive a compact digest of a page\'s',
    'interactive elements (each with a stable numeric "i") plus some page text.',
    'Produce a concise structural understanding: what the page is, its main',
    'regions, and the purpose of the key interactive elements. Refer to elements',
    'ONLY by their i. Respond with strict JSON:',
    '{"summary": string, "elements": [{"i": number, "purpose": string}]}.',
    'Include only elements that matter for acting on the page (forms, buttons,',
    'nav, primary links). Keep purposes terse.',
  ].join(' ');
  const user = JSON.stringify(slim);
  const out = await callModel(system, user, 1500);
  return {
    summary: out.summary || '',
    elements: Array.isArray(out.elements) ? out.elements : [],
  };
}

async function overlayIntent(map, intent, slim, saved) {
  const system = [
    'You are a fast web-automation planner AND a snapshot broker. You get a page',
    'map (summary + elements with i and purpose), raw items[] (each with i, labels,',
    'cx/cy center coords + inFrame), savedActions[] (optional reusable macros), and',
    'a user INTENT.',
    'STEP 1 — judge sufficiency: if the element(s) needed to accomplish the intent',
    'are NOT present in this data, set "needMore":true with a short "needMoreReason"',
    '(e.g. "target likely off-screen", "in an overlay/portal", "inside an iframe")',
    'and return EMPTY steps — do NOT guess. The caller will fetch a bigger snapshot',
    'and ask you again. If the data IS sufficient, set "needMore":false and plan.',
    'STEP 1b — clarity: only if the INTENT identifies NO actionable target at all',
    '(e.g. "update my info", "change it", "fix this" with no field or value named)',
    'set "needsMoreInfo" to a short clarifying question and return EMPTY steps. If',
    'the intent names at least one concrete field/value or action, plan exactly',
    'those step(s) and ignore unmentioned fields — do NOT invent values for fields',
    'the user did not mention.',
    'STEP 2 — steps (name + args): ' + ALLOWED_STEPS + '.',
    'If a savedAction cleanly matches the whole intent you MAY return a single',
    '{"name":"fast_macro_run","args":{"name":"<macro name>"}} — but prefer explicit',
    'steps unless the macro is an obvious exact fit.',
    'TIER SELECTION: default to the cheap injected tier (fast_click, fast_fill).',
    'When a target has inFrame:true, or is inside an overlay/portal (inOverlay:true),',
    'or is a React/LWC/custom-component control where injected events are unreliable,',
    'use the TRUSTED tier: fast_click_xy {x:cx, y:cy} to focus, then fast_type {text}',
    'for text entry. fast_key for shortcuts. Disambiguate duplicate labels by',
    'purpose/position. Identify targets by their label; always include the element\'s i as',
    '"_ref" in args. Respond with strict JSON: {"needMore":boolean,',
    '"needMoreReason":string?,"brief":string,"steps":[{"name":string,"args":object}],',
    '"needsMoreInfo":string?}. Be terse.',
  ].join(' ');
  const user = JSON.stringify({ intent, summary: map.summary, elements: map.elements, items: slim.items, savedActions: saved });
  const out = await callModel(system, user, 1000);
  // A malformed/empty model response (safeJson → {}) must NOT look like a
  // successful empty plan. With no steps and no clarifying question, default to
  // needMore:true so the caller escalates to a bigger snapshot instead of
  // silently returning nothing.
  const steps = normalizeSteps(Array.isArray(out.steps) ? out.steps : []);
  const parsedNothing = !steps.length && !out.needsMoreInfo && out.needMore === undefined;
  return {
    brief: out.brief || '',
    steps,
    needMore: parsedNothing ? true : !!out.needMore,
    needMoreReason: out.needMoreReason || (parsedNothing ? 'planner returned no usable plan' : undefined),
    needsMoreInfo: out.needsMoreInfo || undefined,
  };
}

// Direct Generative Language API. AQ.-format keys authenticate via the
// x-goog-api-key header; responseMimeType pins JSON output.
// Safety net: coerce common arg-name slips so steps run as-is. The planner
// occasionally copies fast_fill's `match` onto a fast_click; map it to `text`.
function normalizeSteps(steps) {
  return steps.map((s) => {
    if (!s || typeof s !== 'object') return s;
    const args = { ...(s.args || {}) };
    if (s.name === 'fast_click' && args.match && !args.text) { args.text = args.match; delete args.match; }
    if (s.name === 'fast_hover' && args.match && !args.text) { args.text = args.match; delete args.match; }
    return { ...s, args };
  });
}

// Text-mode call: a single user text part. Thin wrapper over callModelParts so
// the existing buildPageMap/overlayIntent callers are unchanged.
async function callModel(system, user, maxTokens) {
  return callModelParts({ system, parts: [{ text: user }], maxTokens });
}

// Core Generative Language API call. `parts` is the raw user-content parts
// array, so callers can mix text + inlineData (image) parts. `system` is
// optional (multimodal locate doesn't need a separate system instruction).
// AQ.-format keys authenticate via the x-goog-api-key header; responseMimeType
// pins JSON output. Shared fetch/error/JSON handling for every scout call.
async function callModelParts({ system, parts, maxTokens }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 }, // disable 2.5-flash "thinking" for speed
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  // Bound the fetch — a slow/stuck Gemini call must never hang the tool call.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`scout gemini timed out (${GEMINI_TIMEOUT_MS}ms)`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`scout gemini ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('') || '{}';
  return safeJson(content);
}

// Tier 3 — SCREENSHOT escalation. Multimodal locate: given an annotated
// screenshot (numbered red boxes whose labels ARE element ids `i`) plus the
// marks index, ask Gemini which numbered box is the element to fulfill `intent`.
// Returns { i, reason } where i is the chosen element id (number) or null if no
// box matches. The caller maps i -> the mark's cx,cy for a trusted click.
export async function locateByImage({ intent, dataUrl, marks }) {
  if (!SCOUT_ENABLED) return { i: null, reason: 'scout disabled (set GEMINI_API_KEY)' };
  if (!dataUrl || typeof dataUrl !== 'string') return { i: null, reason: 'no image provided' };
  // Strip any data:...;base64, prefix — the API wants raw base64.
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const ids = Array.isArray(marks) ? marks.map((m) => m && m.i).filter((n) => n != null) : [];
  const prompt = [
    'This screenshot has numbered red boxes drawn over interactive elements;',
    'each number is that element\'s id.',
    ids.length ? `Available box numbers: ${ids.join(', ')}.` : '',
    `Which numbered box is the element to: ${intent}?`,
    'Reply with strict JSON {"i": <the number>, "reason": string}.',
    'If none of the boxes match, reply {"i": null}.',
  ].filter(Boolean).join(' ');
  const out = await callModelParts({
    parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: base64 } }],
    maxTokens: 200,
  });
  // Coerce i to a number (model may return a numeric string); null if absent.
  let i = out && out.i;
  if (typeof i === 'string' && /^\d+$/.test(i.trim())) i = parseInt(i, 10);
  if (typeof i !== 'number' || !Number.isFinite(i)) i = null;
  return { i, reason: (out && out.reason) || undefined };
}

// VISION-POINT tier — for targets that are visible on screen but NOT in the DOM
// (opaque/cross-origin iframes, canvas), so Set-of-Mark can't box them. Uses
// Gemini's NATIVE pointing capability: it returns normalized 0-1000 points in
// [y, x] order (NOT [x, y] — common bug). Caller converts to CSS px via dpr.
//
// `targets` is a list of plain-language field/element descriptions. One call
// locates them all (efficient for multi-field forms). Each point is normalized
// to the IMAGE actually sent (full viewport or a zoomed crop) — the caller maps
// it back. `sizeFrac` lets the caller decide whether to crop-zoom refine.
export async function pointByImage({ targets, base64 }) {
  if (!SCOUT_ENABLED) return { points: [], reason: 'scout disabled (set GEMINI_API_KEY)' };
  if (!base64 || typeof base64 !== 'string') return { points: [], reason: 'no image' };
  const list = Array.isArray(targets) ? targets : [targets];
  const img = base64.replace(/^data:image\/\w+;base64,/, '');
  // Instruction text BEFORE the image (Anthropic finding: improves grounding).
  // CRITICAL anti-hallucination contract: if a target is NOT clearly visible in
  // THIS screenshot (off-screen / below the fold / not present), the model MUST
  // return found:false with point:null — it must NEVER invent a coordinate. A
  // fabricated point forces the caller to screenshot-verify every result, which
  // is slow; an honest found:false lets the caller scroll and retry. We also ask
  // for a 0-1 confidence so the caller can reject low-confidence guesses.
  const prompt = [
    'Locate each requested target in this browser screenshot. For each, return',
    'the point at the CENTER of the element you would click (for an input field,',
    'the middle of its empty box), as NORMALIZED integers 0-1000 in [y, x] order',
    '(y first), where [0,0] is top-left and [1000,1000] is bottom-right.',
    'STRICT RULE: only return a point if you can ACTUALLY SEE that exact element',
    'in the image right now. If it is off-screen, below the visible area, or not',
    'present, you MUST return {"found":false,"point":null} for it — do NOT guess,',
    'do NOT approximate a location, do NOT return a point for something you cannot',
    'see. A wrong guess is far worse than found:false.',
    'Also return "confidence" (0-1, how sure you are this is the right visible',
    'element) and "sizeFrac" (target width as fraction of image width).',
    'Targets, in order: ' + list.map((t, k) => `(${k}) ${t}`).join('; ') + '.',
    'Reply strict JSON: {"points":[{"k":int,"found":bool,"point":[y,x]|null,"confidence":number,"sizeFrac":number}]}.',
  ].join(' ');
  const out = await callModelParts({
    parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: img } }],
    maxTokens: 500,
  });
  const raw = Array.isArray(out && out.points) ? out.points : [];
  const points = raw.map((p) => {
    const pt = Array.isArray(p && p.point) ? p.point : null;
    // Native order is [y, x]; guard against a model that emits [x, y] by trusting
    // the documented order but exposing both so the caller can sanity-check.
    const y = pt ? Number(pt[0]) : null;
    const x = pt ? Number(pt[1]) : null;
    const conf = typeof p.confidence === 'number' ? p.confidence : 1;
    // Reject explicit not-found, missing coords, AND low-confidence guesses —
    // treat a shaky answer as not-found so the caller scrolls instead of
    // clicking a hallucinated point.
    const found = p.found !== false && x != null && y != null && conf >= 0.4;
    return {
      k: typeof p.k === 'number' ? p.k : null,
      found,
      xNorm: x, yNorm: y,
      confidence: conf,
      sizeFrac: typeof p.sizeFrac === 'number' ? p.sizeFrac : null,
    };
  });
  return { points };
}

// FAST_DO planner — the most aggressive tier. Given a screenshot + ONE plain-
// language intent, Gemini both DECOMPOSES the intent into concrete per-field
// steps AND describes each target so it can be located by pointByImage. This is
// the key difference from fast_fill_vision: there, Opus supplies the field→value
// map; here, Gemini infers the whole plan from the intent + what it sees.
//
// Returns { steps:[{action:"click"|"type"|"key", target, value?}], note? }.
// Each `target` is a plain-language element description (fed to pointByImage).
// For action "type", value is the text; for "key", value is the key name
// (Enter/Tab/...) and target may be empty. SAFETY: the planner is told NOT to
// emit a final submit/create/delete/confirm step unless the intent explicitly
// asks for it — it stops with the form filled.
export async function planByImage({ intent, base64 }) {
  if (!SCOUT_ENABLED) return { steps: [], reason: 'scout disabled (set GEMINI_API_KEY)' };
  if (!base64 || typeof base64 !== 'string') return { steps: [], reason: 'no image' };
  const img = base64.replace(/^data:image\/\w+;base64,/, '');
  const prompt = [
    'You are a fast web-automation planner looking at a browser SCREENSHOT.',
    'You are given ONE plain-language INTENT describing a goal that involves',
    'filling/operating a form on this page. Decompose the intent into an ordered',
    'list of concrete UI STEPS, and for each step DESCRIBE the target element',
    'precisely enough that it can be located in this screenshot.',
    'Each step is one of:',
    '- {"action":"type","target":"<description of the input field>","value":"<text to enter>"}',
    '- {"action":"click","target":"<description of the control to click, e.g. a dropdown, radio, checkbox, tab>"}',
    '- {"action":"key","value":"<a single key like Enter or Tab>"} (use sparingly, e.g. to confirm a typed dropdown entry)',
    'Rules:',
    '- Order steps top-to-bottom as a human would fill the form.',
    '- For "type" steps, target the empty input box (its middle), not its label.',
    '- Only include fields the intent actually specifies a value for. Do NOT',
    '  invent values for fields the user did not mention.',
    '- To pick from a dropdown/select, emit a click on the dropdown, then a click',
    '  on the option (describe the option text). If the option is not yet visible,',
    '  still describe it; unfound steps are skipped.',
    'CRITICAL SAFETY: Do NOT emit a final submit/create/save/delete/confirm/',
    'continue button click that would COMMIT the form, UNLESS the intent EXPLICITLY',
    'asks to submit/create/save it. Default to filling the form and stopping. If',
    'you deliberately omitted a submit step, mention it in "note".',
    'INTENT: ' + String(intent || ''),
    'Reply with strict JSON: {"steps":[{"action":"click"|"type"|"key","target":string,"value":string}],"note":string}.',
  ].join(' ');
  const out = await callModelParts({
    parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: img } }],
    maxTokens: 1200,
  });
  const raw = Array.isArray(out && out.steps) ? out.steps : [];
  const steps = raw.map((s) => {
    if (!s || typeof s !== 'object') return null;
    let action = typeof s.action === 'string' ? s.action.toLowerCase().trim() : '';
    if (!['click', 'type', 'key'].includes(action)) {
      // Infer: a value with no key-like name → type; otherwise click.
      action = s.value != null && String(s.value).length ? 'type' : 'click';
    }
    const target = typeof s.target === 'string' ? s.target.trim() : '';
    const value = s.value != null ? String(s.value) : undefined;
    if (action !== 'key' && !target) return null; // click/type need a target
    return prune({ action, target: target || undefined, value });
  }).filter(Boolean);
  return { steps, note: (out && typeof out.note === 'string') ? out.note : undefined };
}

// BOX-detection variant of the vision tier. Instead of a single center point,
// Gemini returns a bounding BOX per target ([ymin,xmin,ymax,xmax], normalized
// 0-1000). The caller snaps the click to each box center and can DEDUPE boxes
// that overlap the same row — so two stacked fields can't collapse onto one
// coordinate (the failure mode of single-point pointing on dense forms).
export async function boxByImage({ targets, base64 }) {
  if (!SCOUT_ENABLED) return { boxes: [], reason: 'scout disabled (set GEMINI_API_KEY)' };
  if (!base64 || typeof base64 !== 'string') return { boxes: [], reason: 'no image' };
  const list = Array.isArray(targets) ? targets : [targets];
  const img = base64.replace(/^data:image\/\w+;base64,/, '');
  const prompt = [
    'Detect each requested element in this browser screenshot and return its',
    'BOUNDING BOX as normalized integers 0-1000 in [ymin, xmin, ymax, xmax] order',
    '(y first), where [0,0] is top-left and [1000,1000] is bottom-right. For an',
    'input field, box the clickable input area itself (not its label). Set',
    '"found": false if not visible. Targets, in order: '
      + list.map((t, k) => `(${k}) ${t}`).join('; ') + '.',
    'Reply strict JSON: {"boxes":[{"k":int,"found":bool,"box":[ymin,xmin,ymax,xmax]}]}.',
  ].join(' ');
  const out = await callModelParts({
    parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: img } }],
    maxTokens: 600,
  });
  const raw = Array.isArray(out && out.boxes) ? out.boxes : [];
  const boxes = raw.map((b) => {
    const bx = Array.isArray(b && b.box) ? b.box.map(Number) : null;
    const ok = bx && bx.length === 4 && bx.every((n) => Number.isFinite(n));
    return {
      k: typeof b.k === 'number' ? b.k : null,
      found: b.found !== false && ok,
      // center of the box, normalized
      cyNorm: ok ? (bx[0] + bx[2]) / 2 : null,
      cxNorm: ok ? (bx[1] + bx[3]) / 2 : null,
      box: ok ? bx : null,
    };
  });
  return { boxes };
}

// Set-of-Mark pick: given a screenshot already annotated with numbered red
// boxes, ask Gemini which NUMBER is each target. Classification (pick a label),
// not coordinate regression — far more reliable. Returns { picks:[{k,n}] } where
// n is the chosen box number (or null). The caller maps n → that box's center.
export async function pickMarks({ targets, base64, numbers }) {
  if (!SCOUT_ENABLED) return { picks: [], reason: 'scout disabled (set GEMINI_API_KEY)' };
  if (!base64 || typeof base64 !== 'string') return { picks: [], reason: 'no image' };
  const list = Array.isArray(targets) ? targets : [targets];
  const img = base64.replace(/^data:image\/\w+;base64,/, '');
  const nums = Array.isArray(numbers) ? numbers.join(', ') : '';
  const prompt = [
    'This screenshot has numbered red boxes drawn over candidate elements.',
    nums ? `Available box numbers: ${nums}.` : '',
    'For each target, reply with the NUMBER of the box that is that element',
    '(pick from the available numbers; null if none fits). Targets, in order: '
      + list.map((t, k) => `(${k}) ${t}`).join('; ') + '.',
    'Reply strict JSON: {"picks":[{"k":int,"n":int|null}]}.',
  ].filter(Boolean).join(' ');
  const out = await callModelParts({
    parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: img } }],
    maxTokens: 300,
  });
  const raw = Array.isArray(out && out.picks) ? out.picks : [];
  const picks = raw.map((p) => {
    let n = p && p.n;
    if (typeof n === 'string' && /^\d+$/.test(n.trim())) n = parseInt(n, 10);
    if (typeof n !== 'number' || !Number.isFinite(n)) n = null;
    return { k: typeof p.k === 'number' ? p.k : null, n };
  });
  return { picks };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/); // models sometimes wrap JSON in prose/fences
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  log(`scout: failed to parse model JSON`);
  return {};
}

// Cheap stable hash of the digest's interactive surface so the page-map cache
// invalidates when the page's actionable elements change (not on every scroll).
function digestHash(slim) {
  const key = (slim.items || []).map((n) => `${n.i}|${n.tag}|${n.label || n.text || n.name || ''}`).join('\n');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return `${slim.url}:${slim.items?.length || 0}:${h}`;
}

function prune(obj) {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}
