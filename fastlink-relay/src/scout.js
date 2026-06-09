// src/scout.js — Gemini "scout" brain, ported to the Cloudflare Worker (relay-core)
//
// Workers port of fast-dxt/server/scout.js. The original already talks to the
// Gemini Generative Language API over `fetch` (no Node deps in the call path), so
// the logic + prompts are carried over verbatim. Cloud-relay changes:
//
//   1. BYO-KEY (SPEC §12): the Gemini API key is resolved PER CALL by the DO
//      (`db.getUserGeminiKey(env.DB, userId, env.KEY_ENC_SECRET) ?? env.GEMINI_API_KEY`)
//      and passed IN — the
//      model helpers take the key as a parameter; this module never reads env.
//      The DO creates the cache-holding factory once and binds a key per call via
//      `createScout({model}).withKey(apiKey)`, so the bound surface composite.js
//      uses is unchanged.
//   2. PER-USER CACHES: the page-map / visual-map caches live inside the factory
//      instance (one per UserRelay DO) — no module-level cache shared across
//      tenants in the same isolate.
//
// Usage (in the DO):
//   const base  = createScout({ model });            // once, holds caches
//   const scout = base.withKey(resolvedApiKey);      // per call, binds the key
//   if (scout.enabled) await scout.pointByImage({ targets, base64 });
//
// See SPEC.md §3e, §12 and task #7.

// ── Heavy-page guards (mirror of fast-dxt/server/scout.js) ──
// A giant SPA (GCP) snapshot can carry thousands of interactive items; sending
// them all to Gemini is slow AND degrades output (flash-lite returns empty JSON
// on a huge prompt → empty briefs). Cap the digest, and bound the fetch so a
// stuck Gemini call can't hang the tool call. Light pages stay below the cap.
const MAX_SCOUT_ITEMS = 300;
const GEMINI_TIMEOUT_MS = 12_000;

export function createScout({ model } = {}) {
  const GEMINI_MODEL = model || 'gemini-2.5-flash-lite';

  // Per-instance (per-user-DO) caches — NOT module-level.
  const pageMapCache = new Map();   // url -> { hash, map }
  const visualMapCache = new Map(); // url -> { hash, map }

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

  const DISABLED = 'no Gemini API key — set your own in relay settings, or configure the operator GEMINI_API_KEY secret';

  // --- core Gemini call (key is a PARAMETER) --------------------------------

  async function callModelParts(apiKey, { system, parts, maxTokens }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: maxTokens,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
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
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
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

  const callModel = (apiKey, system, user, maxTokens) =>
    callModelParts(apiKey, { system, parts: [{ text: user }], maxTokens });

  // --- DOM scout (digest → plan) -------------------------------------------

  async function scout(apiKey, { intent, digest, macros }) {
    if (!apiKey) return { disabled: true, reason: DISABLED, brief: null, steps: [] };
    const slim = slimDigest(digest);
    const saved = slimMacros(macros);
    const map = await getPageMap(apiKey, slim);
    if (!intent) return { warmed: map.warmed, url: slim.url, summary: map.summary, elements: map.elements, savedActions: saved };
    const plan = await overlayIntent(apiKey, map, intent, slim, saved);
    return {
      warmed: map.warmed, url: slim.url, brief: plan.brief, steps: plan.steps,
      savedActions: saved, needMore: plan.needMore, needMoreReason: plan.needMoreReason, needsMoreInfo: plan.needsMoreInfo,
    };
  }

  async function warm(apiKey, digest) {
    if (!apiKey) return { disabled: true };
    const slim = slimDigest(digest);
    const map = await getPageMap(apiKey, slim);
    return { warmed: map.warmed, url: slim.url, elements: map.elements.length };
  }

  async function getPageMap(apiKey, slim) {
    const hash = digestHash(slim);
    const cached = pageMapCache.get(slim.url);
    if (cached && cached.hash === hash) return { ...cached.map, warmed: true };
    const map = await buildPageMap(apiKey, slim);
    pageMapCache.set(slim.url, { hash, map });
    return { ...map, warmed: false };
  }

  async function buildPageMap(apiKey, slim) {
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
    const out = await callModel(apiKey, system, JSON.stringify(slim), 1500);
    return { summary: out.summary || '', elements: Array.isArray(out.elements) ? out.elements : [] };
  }

  async function overlayIntent(apiKey, map, intent, slim, saved) {
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
    const out = await callModel(apiKey, system, user, 1000);
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

  // --- visual page map ------------------------------------------------------

  async function visualMap(apiKey, url, base64) {
    if (!apiKey) return { disabled: true };
    if (!base64 || typeof base64 !== 'string') return { disabled: true };
    const img = base64.replace(/^data:image\/\w+;base64,/, '');
    const hash = cheapImageHash(img);
    const cached = visualMapCache.get(url);
    if (cached && cached.hash === hash) return { ...cached.map, warmed: true };
    const map = await buildVisualMap(apiKey, img);
    visualMapCache.set(url, { hash, map });
    return { ...map, warmed: false };
  }

  function getVisualMap(url) {
    const c = visualMapCache.get(url);
    return c ? c.map : null;
  }

  async function buildVisualMap(apiKey, img) {
    const prompt = [
      'You are a fast web-page scout looking at a browser SCREENSHOT. Produce a',
      'concise visual understanding of the page: what it is, and its main',
      'interactive regions (forms, primary buttons, nav, search). For each region',
      'give a short label and a rough location (e.g. "top-left", "center form",',
      '"right sidebar"). Respond with strict JSON:',
      '{"summary": string, "regions": [{"label": string, "where": string}]}.',
      'Keep it terse; include only regions that matter for acting on the page.',
    ].join(' ');
    const out = await callModelParts(apiKey, {
      parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: img } }],
      maxTokens: 800,
    });
    return { summary: out.summary || '', regions: Array.isArray(out.regions) ? out.regions : [] };
  }

  // --- multimodal locate primitives ----------------------------------------

  async function locateByImage(apiKey, { intent, dataUrl, marks }) {
    if (!apiKey) return { i: null, reason: DISABLED };
    if (!dataUrl || typeof dataUrl !== 'string') return { i: null, reason: 'no image provided' };
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
    const out = await callModelParts(apiKey, {
      parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: base64 } }],
      maxTokens: 200,
    });
    let i = out && out.i;
    if (typeof i === 'string' && /^\d+$/.test(i.trim())) i = parseInt(i, 10);
    if (typeof i !== 'number' || !Number.isFinite(i)) i = null;
    return { i, reason: (out && out.reason) || undefined };
  }

  async function pointByImage(apiKey, { targets, base64 }) {
    if (!apiKey) return { points: [], reason: DISABLED };
    if (!base64 || typeof base64 !== 'string') return { points: [], reason: 'no image' };
    const list = Array.isArray(targets) ? targets : [targets];
    const img = base64.replace(/^data:image\/\w+;base64,/, '');
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
    const out = await callModelParts(apiKey, {
      parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: img } }],
      maxTokens: 500,
    });
    const raw = Array.isArray(out && out.points) ? out.points : [];
    const points = raw.map((p) => {
      const pt = Array.isArray(p && p.point) ? p.point : null;
      const y = pt ? Number(pt[0]) : null;
      const x = pt ? Number(pt[1]) : null;
      const conf = typeof p.confidence === 'number' ? p.confidence : 1;
      const found = p.found !== false && x != null && y != null && conf >= 0.4;
      return { k: typeof p.k === 'number' ? p.k : null, found, xNorm: x, yNorm: y, confidence: conf, sizeFrac: typeof p.sizeFrac === 'number' ? p.sizeFrac : null };
    });
    return { points };
  }

  async function planByImage(apiKey, { intent, base64 }) {
    if (!apiKey) return { steps: [], reason: DISABLED };
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
    const out = await callModelParts(apiKey, {
      parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: img } }],
      maxTokens: 1200,
    });
    const raw = Array.isArray(out && out.steps) ? out.steps : [];
    const steps = raw.map((s) => {
      if (!s || typeof s !== 'object') return null;
      let action = typeof s.action === 'string' ? s.action.toLowerCase().trim() : '';
      if (!['click', 'type', 'key'].includes(action)) action = s.value != null && String(s.value).length ? 'type' : 'click';
      const target = typeof s.target === 'string' ? s.target.trim() : '';
      const value = s.value != null ? String(s.value) : undefined;
      if (action !== 'key' && !target) return null;
      return prune({ action, target: target || undefined, value });
    }).filter(Boolean);
    return { steps, note: (out && typeof out.note === 'string') ? out.note : undefined };
  }

  async function boxByImage(apiKey, { targets, base64 }) {
    if (!apiKey) return { boxes: [], reason: DISABLED };
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
    const out = await callModelParts(apiKey, {
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
        cyNorm: ok ? (bx[0] + bx[2]) / 2 : null,
        cxNorm: ok ? (bx[1] + bx[3]) / 2 : null,
        box: ok ? bx : null,
      };
    });
    return { boxes };
  }

  async function pickMarks(apiKey, { targets, base64, numbers }) {
    if (!apiKey) return { picks: [], reason: DISABLED };
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
    const out = await callModelParts(apiKey, {
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

  // Bind a resolved API key into a stable surface (the shape composite.js uses).
  // Caches are shared across binds (they live on the factory), so per-call key
  // resolution doesn't cost a cache. enabled reflects whether a key is present.
  function withKey(apiKey) {
    return {
      enabled: !!apiKey,
      model: GEMINI_MODEL,
      scout: (a) => scout(apiKey, a),
      warm: (d) => warm(apiKey, d),
      visualMap: (u, b) => visualMap(apiKey, u, b),
      getVisualMap,
      locateByImage: (a) => locateByImage(apiKey, a),
      pointByImage: (a) => pointByImage(apiKey, a),
      planByImage: (a) => planByImage(apiKey, a),
      boxByImage: (a) => boxByImage(apiKey, a),
      pickMarks: (a) => pickMarks(apiKey, a),
    };
  }

  return { withKey };
}

// --- pure helpers (no instance state, no key) -------------------------------

function slimMacros(macros) {
  return (macros || []).map((m) => prune({
    name: m.name,
    description: m.description || undefined,
    steps: (m.actions || m.steps || []).length || undefined,
  }));
}

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
    cx: (typeof it.x === 'number' && typeof it.w === 'number') ? Math.round(it.x + it.w / 2) : undefined,
    cy: (typeof it.y === 'number' && typeof it.h === 'number') ? Math.round(it.y + it.h / 2) : undefined,
    inFrame: it.inFrame || undefined,
    inOverlay: it.inOverlay || undefined,
  }));
  const content = (d.content || []).map((c) => c.text).filter(Boolean).slice(0, 40);
  const capped = capItems(items);
  return {
    url: d.url, title: d.title, items: capped.items, content,
    itemsTotal: capped.truncated ? items.length : undefined,
    itemsTruncated: capped.truncated || undefined,
  };
}

// Cap the item list sent to Gemini — labeled items first, then backfill to the
// cap. No-op below the cap (light pages). Mirror of fast-dxt/server/scout.js.
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

function normalizeSteps(steps) {
  return steps.map((s) => {
    if (!s || typeof s !== 'object') return s;
    const args = { ...(s.args || {}) };
    if (s.name === 'fast_click' && args.match && !args.text) { args.text = args.match; delete args.match; }
    if (s.name === 'fast_hover' && args.match && !args.text) { args.text = args.match; delete args.match; }
    return { ...s, args };
  });
}

function safeJson(s) {
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return {};
}

function digestHash(slim) {
  const key = (slim.items || []).map((n) => `${n.i}|${n.tag}|${n.label || n.text || n.name || ''}`).join('\n');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return `${slim.url}:${slim.items?.length || 0}:${h}`;
}

function cheapImageHash(img) {
  let h = 0;
  const step = Math.max(1, Math.floor(img.length / 1024));
  for (let i = 0; i < img.length; i += step) h = (h * 31 + img.charCodeAt(i)) | 0;
  return `${img.length}:${h}`;
}

function prune(obj) {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}
