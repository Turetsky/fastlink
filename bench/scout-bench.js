#!/usr/bin/env node
// Gemini scout latency benchmark
const fs = require('fs');

// API key from GEMINI_API_KEY env, or a KEY=VALUE secrets file at $FASTLINK_SECRETS.
let KEY = process.env.GEMINI_API_KEY;
if (!KEY && process.env.FASTLINK_SECRETS) {
  const secrets = fs.readFileSync(process.env.FASTLINK_SECRETS, 'utf8');
  KEY = (secrets.match(/^GEMINI_API_KEY=(.+)$/m) || [])[1]?.trim();
}
if (!KEY) { console.error('no key'); process.exit(1); }

// ---- Build realistic large digest: ~150 interactive items ----
const tags = ['button', 'a', 'input'];
const labels = [
  'Search', 'Home', 'Account', 'Settings', 'Help', 'Cart', 'Wishlist', 'Sign out',
  'Apply coupon', 'Edit address', 'Save', 'Cancel', 'Continue', 'Back', 'Next',
  'Quantity', 'Remove', 'Update', 'Gift options', 'Shipping method'
];
function makeItems() {
  const items = [];
  for (let i = 0; i < 150; i++) {
    const tag = tags[i % 3];
    const base = labels[i % labels.length];
    const it = {
      i,
      tag,
      cx: 100 + (i % 12) * 90,
      cy: 80 + Math.floor(i / 12) * 44,
    };
    if (tag === 'input') it.placeholder = `${base} ${i}`;
    else if (tag === 'a') it.text = `${base} link ${i}`;
    else it.text = `${base} ${i}`;
    items.push(it);
  }
  // mark ~5 as inFrame
  [40, 55, 77, 88, 99].forEach(idx => { items[idx].inFrame = true; });
  // embed clear targets
  items[77] = { i: 77, tag: 'input', placeholder: 'Card number', cx: 540, cy: 360, inFrame: true };
  items[120] = { i: 120, tag: 'button', text: 'Place order', cx: 620, cy: 880 };
  return items;
}
const ITEMS = makeItems();
const INTENT = 'fill the Card number field with 4242 4242 4242 4242 and click Place order';

const SYSTEM = `You are a web automation PLANNER for FastLink.
Input: a JSON page digest (array of interactive items) and an INTENT.
Each item: {i, tag, text|placeholder|label, cx, cy, inFrame?}.
Output STRICT JSON only: {"steps":[{"name":..., "args":{...}}]}.
Tool rules:
- For a normal (NOT inFrame) input: fast_fill{match, value}  (match = the item's label/placeholder/text, the TRUSTED tier).
- For a normal button/link: fast_click{text}.
- For ANY item with inFrame:true you MUST NOT use fast_fill/fast_click. Instead:
    to type into it: fast_click_xy{x:cx,y:cy} then fast_type{text:value}.
    to click it: fast_click_xy{x:cx,y:cy}.
Pick the items that satisfy the INTENT. Use exact label/text from the digest. Output JSON only.`;

const ENDPOINT = m => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;

async function callGemini(model, systemText, userText, { thinking } = {}) {
  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  };
  if (thinking === 0) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const t0 = Date.now();
  const res = await fetch(ENDPOINT(model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  const json = await res.json();
  if (!res.ok) return { ms, ok: false, err: JSON.stringify(json).slice(0, 300), usage: null, text: null };
  const text = json?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  const usage = json?.usageMetadata || null;
  return { ms, ok: true, text, usage };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const GAP = 800; // small gap between calls to avoid cold-start/rate-limit skew

function parsePlan(text) {
  try { const o = JSON.parse(text); return Array.isArray(o.steps) ? o : null; }
  catch { return null; }
}

// correctness: targets Card field (i=77, inFrame) with trusted tier = click_xy(540,360)+type 4242..., and clicks Place order
function checkCorrect(plan) {
  if (!plan) return 'no plan';
  const steps = plan.steps;
  const s = JSON.stringify(steps).toLowerCase();
  const usesXY = steps.some(st => /click_xy/i.test(st.name) && st.args && (st.args.x === 540 || st.args.x === '540'));
  const typesCard = steps.some(st => /type/i.test(st.name) && st.args && String(st.args.text || st.args.value || '').includes('4242'));
  const wrongFill = steps.some(st => /fast_fill/i.test(st.name) && /card number/i.test(JSON.stringify(st.args)));
  const clicksOrder = s.includes('place order');
  let note = `xyCard=${usesXY} typesCard=${typesCard} clicksPlaceOrder=${clicksOrder} wrongFillUsed=${wrongFill}`;
  const correct = usesXY && typesCard && clicksOrder && !wrongFill;
  return (correct ? 'CORRECT: ' : 'INCORRECT: ') + note;
}

const median = a => { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

async function runOneShot(label, model, opts) {
  const userText = `INTENT: ${INTENT}\n\nDIGEST (${ITEMS.length} items):\n${JSON.stringify(ITEMS)}`;
  const times = [], valids = [], notes = [], usages = [];
  for (let r = 0; r < 3; r++) {
    if (r > 0) await sleep(GAP);
    const out = await callGemini(model, SYSTEM, userText, opts);
    if (!out.ok) { notes.push('ERR ' + out.err); valids.push(false); continue; }
    times.push(out.ms);
    const plan = parsePlan(out.text);
    valids.push(!!plan);
    notes.push(checkCorrect(plan));
    if (out.usage) usages.push(out.usage);
  }
  return report(label, times, valids, notes, usages);
}

function report(label, times, valids, notes, usages) {
  const validCount = valids.filter(Boolean).length;
  const u = usages[0] || {};
  const r = {
    config: label,
    validRate: `${validCount}/${valids.length}`,
    minMs: times.length ? Math.min(...times) : -1,
    medMs: times.length ? median(times) : -1,
    correctnessNote: notes.find(n => n.startsWith('CORRECT')) ? notes.find(n => n.startsWith('CORRECT')) : notes[0],
    promptTokens: u.promptTokenCount,
    outTokens: u.candidatesTokenCount,
    allNotes: notes,
  };
  console.log(JSON.stringify(r));
  return r;
}

// Two-stage
const MAP_SYSTEM = `You compress a web page digest into a compact map.
Input: JSON array of interactive items {i, tag, text|placeholder, cx, cy, inFrame?}.
Output STRICT JSON: {"summary": "<one line>", "elements":[{"i", "purpose"}]} where purpose is a short phrase.
KEEP cx,cy and inFrame for items that look interactive form/checkout controls. Actually: output {"summary","elements":[{"i","purpose","cx","cy","inFrame"}]} keeping coords+inFrame so a downstream planner can act. Include ALL items. JSON only.`;

async function runTwoStage(model) {
  const userA = `DIGEST (${ITEMS.length} items):\n${JSON.stringify(ITEMS)}`;
  // Stage A
  const a = await callGemini(model, MAP_SYSTEM, userA, { thinking: 0 });
  if (!a.ok) { console.log(JSON.stringify({ stageA_err: a.err })); return null; }
  const map = a.text;
  // Stage B warm (3 runs reusing map)
  const planSysB = SYSTEM + `\nYou are given a compact page map {summary,elements:[{i,purpose,cx,cy,inFrame}]} instead of raw digest. Same rules.`;
  const userB = `INTENT: ${INTENT}\n\nPAGE MAP:\n${map}`;
  const bTimes = [], bValids = [], bNotes = [], bUsages = [];
  for (let r = 0; r < 3; r++) {
    if (r > 0) await sleep(GAP);
    const b = await callGemini(model, planSysB, userB, { thinking: 0 });
    if (!b.ok) { bNotes.push('ERR ' + b.err); bValids.push(false); continue; }
    bTimes.push(b.ms);
    const plan = parsePlan(b.text);
    bValids.push(!!plan);
    bNotes.push(checkCorrect(plan));
    if (b.usage) bUsages.push(b.usage);
  }
  const warm = report('two-stage 2.5-flash WARM (B only, map reused)', bTimes, bValids, bNotes, bUsages);
  const coldMin = a.ms + (bTimes.length ? Math.min(...bTimes) : 0);
  const coldMed = a.ms + (bTimes.length ? median(bTimes) : 0);
  const cold = {
    config: 'two-stage 2.5-flash COLD (A map-build + B plan)',
    validRate: warm.validRate,
    minMs: coldMin,
    medMs: coldMed,
    correctnessNote: warm.correctnessNote,
    stageA_ms: a.ms,
    stageA_promptTokens: a.usage?.promptTokenCount,
    stageA_outTokens: a.usage?.candidatesTokenCount,
    warmB_promptTokens: bUsages[0]?.promptTokenCount,
  };
  console.log(JSON.stringify(cold));
  return { warm, cold };
}

(async () => {
  // PROBE: does 2.0-flash actually reject thinkingConfig? Send it once, capture error.
  const probe = await callGemini('gemini-2.0-flash', SYSTEM,
    `INTENT: ${INTENT}\n\nDIGEST:\n${JSON.stringify(ITEMS)}`, { thinking: 0 });
  console.log(JSON.stringify({
    PROBE_2_0_flash_with_thinkingConfig: probe.ok ? 'ACCEPTED (no rejection)' : 'REJECTED',
    err: probe.ok ? null : probe.err,
  }));
  await sleep(GAP);

  const results = [];
  results.push(await runOneShot('one-shot gemini-2.5-flash (thinkingBudget:0)', 'gemini-2.5-flash', { thinking: 0 }));
  await sleep(GAP);
  results.push(await runOneShot('one-shot gemini-2.5-flash (no thinkingConfig)', 'gemini-2.5-flash', {}));
  await sleep(GAP);
  results.push(await runOneShot('one-shot gemini-2.0-flash (no thinkingConfig)', 'gemini-2.0-flash', {}));
  await sleep(GAP);
  results.push(await runOneShot('one-shot gemini-2.0-flash-lite-001 (no thinkingConfig)', 'gemini-2.0-flash-lite-001', {}));
  await sleep(GAP);
  results.push(await runOneShot('one-shot gemini-2.5-flash-lite (no thinkingConfig)', 'gemini-2.5-flash-lite', {}));
  await sleep(GAP);
  const ts = await runTwoStage('gemini-2.5-flash');
  if (ts) { results.push(ts.cold); results.push(ts.warm); }
  console.log('\n===SUMMARY===');
  console.log(JSON.stringify(results, null, 2));
})();
