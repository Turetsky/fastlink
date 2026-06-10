// src/mcp.js — minimal MCP JSON-RPC over Streamable HTTP (relay-core)
//
// Hand-rolled for Workers (no Node MCP SDK). Stateless: one POST in, one JSON
// response out — no SSE session, which is all a claude.ai custom connector needs
// for request/response tool calls. Same spirit as fast-dxt/server/transports.js.
//
// `relay` is the UserRelay DO instance; dispatchTool calls relay.callExtension(...)
// for each browser primitive, mirroring fast-dxt/server/handlers.js's surface.
//
// SCOPE: ships the full tool surface. RAW / DOM tools route straight to the
// extension; the Gemini-backed composite tiers (fast_scout/point/point_som/
// fill_vision/do/locate) are orchestrated in src/composite.js using a per-user
// Gemini client (relay.getScout()) — task #7. Image-returning tools come back as
// MCP image content (no /tmp on Workers). fast_evaluate is gated OFF by default.
//
// See SPEC.md §3e, §7.

import { TOOLS } from '../tools.js';
import {
  handleScout, handlePoint, handlePointSom, handleFillVision, handleDo, handleLocate,
} from './composite.js';

// Guidance the client (Claude) sees in the initialize result — steers it toward
// the FAST tools instead of its default "screenshot + read it myself" instinct.
// Keep in sync with fast-dxt/server/transports.js INSTRUCTIONS.
const INSTRUCTIONS = [
  'FastLink drives the user\'s real Chrome tab. Use it efficiently:',
  '- READ a page with fast_snapshot — a fast, structured index of the DOM (readable text + clickable elements with coords). Do NOT take a screenshot to read content. (fast_scout can pre-read a page so you plan in one pass.)',
  '- LOCATE/click something NOT in the DOM (canvas, opaque/cross-origin iframe, image, custom-rendered UI) with fast_point or fast_locate (fast_fill_vision to fill a visual form). Gemini reads the screenshot and returns the pixel coordinates FOR you — never screenshot-and-read-it-yourself; that is slow and token-heavy. fast_screenshot is for VISUAL CONFIRMATION only, never to read/parse page content.',
  '- CHAIN a known multi-step sequence in ONE call with fast_batch (e.g. navigate → fill → click → wait) to cut round-trips.',
  '- Fill multi-field forms with fast_fill_form in one call, not field-by-field.',
  '- Action results (fast_click / fast_fill / fast_wait) already include a snapshot — chain off THAT; do not issue a separate fast_snapshot right after.',
  '- Do NOT add artificial waits/sleeps — tabs load fast. Use fast_wait only when there is a real async signal (new view text, network idle), not as a reflex after every action.',
].join('\n');

// ---- JSON-RPC plumbing ----------------------------------------------------

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export async function handleMcpRequest(request, relay) {
  // Streamable HTTP: claude.ai may open a GET for a server→client SSE stream. We
  // are request/response only, so decline GET/other methods cleanly.
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } });
  }

  let rpc;
  try {
    rpc = await request.json();
  } catch {
    return json(rpcErr(null, -32700, 'parse error'));
  }

  // Batch support (claude.ai rarely batches, but the spec allows it).
  if (Array.isArray(rpc)) {
    const out = [];
    for (const one of rpc) {
      const r = await handleOne(one, relay);
      if (r) out.push(r); // notifications produce no response
    }
    return out.length ? json(out) : new Response(null, { status: 202 });
  }

  const r = await handleOne(rpc, relay);
  // A notification (no id) gets no body — just acknowledge.
  return r ? json(r) : new Response(null, { status: 202 });
}

async function handleOne(rpc, relay) {
  const { id, method, params } = rpc || {};

  // Notifications (e.g. notifications/initialized) carry no id and want no reply.
  if (typeof method === 'string' && method.startsWith('notifications/')) return null;

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fastlink-relay', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'tools/call':
      return ok(id, await dispatchTool(params || {}, relay));
    case 'ping':
      return ok(id, {});
    default:
      // Unknown method with no id = unknown notification → silently drop.
      if (id === undefined || id === null) return null;
      return rpcErr(id, -32601, 'method not found');
  }
}

// ---- tool dispatch --------------------------------------------------------

// MCP result helpers. A tool ERROR is a normal result with isError:true (per the
// MCP spec), NOT a JSON-RPC error — so the model sees the message and can react.
const textResult = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const errorResult = (message) => ({ content: [{ type: 'text', text: `Error: ${message}` }], isError: true });

// Gemini-backed composite tiers, now ported to the Worker (task #7). Routed to
// src/composite.js, which orchestrates browser primitives (relay.callExtension)
// + Gemini calls (relay.getScout()). They self-report {disabled:true} when no
// GEMINI_API_KEY secret is configured.
const VISION_TOOLS = new Set([
  'fast_scout', 'fast_point', 'fast_point_som', 'fast_fill_vision', 'fast_do', 'fast_locate',
]);

// Raw tools that return a screenshot dataURL. On Workers there's no /tmp to save
// to, so we hand the image back as proper MCP image content instead.
const IMAGE_TOOLS = new Set(['fast_screenshot', 'fast_marks', 'fast_vision_capture', 'fast_annotate_boxes']);

// Mutating actions blocked when a site is in read-only consent mode (SAFETY §7).
// Includes the composite tiers that actually execute clicks/typing (fill_vision,
// do) but NOT the read/locate-only ones (scout/point/point_som/locate).
const MUTATING_TOOLS = new Set([
  'fast_click', 'fast_click_xy', 'fast_fill', 'fast_fill_form', 'fast_type',
  'fast_key', 'fast_key_press', 'fast_nav', 'fast_evaluate', 'fast_drag', 'fast_drag_xy',
  'fast_select_option', 'fast_wheel', 'fast_scroll', 'fast_tab', 'fast_close', 'fast_reload',
  'fast_hover', 'fast_macro_run', 'fast_macro_save', 'fast_macro_delete', 'fast_network_replay',
  'fast_fill_vision', 'fast_do',
]);

// Diagnostic/orchestration tools that may NOT appear as a batch/macro step.
const DIAGNOSTIC_ONLY = new Set([...VISION_TOOLS, 'fast_prewarm', 'fast_status', 'fast_batch']);

// Relay-native tools that never touch a page → exempt from the per-origin consent
// gate. (fast_batch's STEPS are gated individually inside runBatch.)
const CONSENT_EXEMPT = new Set(['fast_status', 'fast_prewarm', 'fast_batch']);

// N2 kill-switch: tools still allowed while the user has PAUSED driving — only the
// observable relay-meta ones, so the paused state can be reported. Everything else
// (incl. fast_batch and all browser actions) is refused until the user resumes.
const PAUSE_EXEMPT = new Set(['fast_status', 'fast_prewarm']);

// Per-origin consent gate (M4 / SIGNUP-SPEC §4.2). Returns null to PROCEED, or a
// plain blocking payload object to short-circuit (dispatchTool wraps it in
// textResult; runBatch folds it into the step result). Decision per origin:
//   allow    → proceed (reads + writes)
//   block    → refuse ALL tools for this origin
//   readonly → refuse MUTATING_TOOLS (reads pass)
//   prompt   → undecided origin under the multi-user default: reads pass, a write
//              returns the consent_required affordance so the human can approve.
async function consentVerdict(relay, name) {
  if (CONSENT_EXEMPT.has(name)) return null;

  const def = relay.consentDefault();
  // Cheap path: use the stamped origin if we have it. With no stamped origin yet,
  // only pay for a probe when the default actually gates (prompt/readonly); in
  // allow-default (shared/operator) skip straight through.
  let origin = relay.lastOrigin || '';
  if (!origin) {
    if (def === 'allow') return null;
    origin = await relay.currentOrigin();
  }
  if (!origin) return null; // no resolvable active-tab origin — let the call run (it'll fail naturally if disconnected)

  const mode = await relay.consentFor(origin); // 'allow'|'readonly'|'block'|'prompt'
  const mutating = MUTATING_TOOLS.has(name);

  if (mode === 'allow') return null;
  if (mode === 'block') {
    return {
      error: `"${name}" is blocked: you've set ${origin} to "block" for your account. Change it in the FastLink extension popup.`,
      consentBlocked: true,
      origin,
    };
  }
  if (mode === 'readonly') {
    if (!mutating) return null;
    return {
      error: `"${name}" is blocked: ${origin} is in read-only mode for your account. Approve write access for this site in the FastLink extension popup.`,
      readonlyBlocked: true,
      origin,
    };
  }
  // mode === 'prompt' (undecided origin, multi-user default): reads pass; a write
  // surfaces the first-touch approval prompt and is NOT executed this turn.
  if (!mutating) return null;
  const modesOffered = ['allow', 'readonly'];
  const message = `FastLink needs your approval to act on ${origin}. Approve it in the extension popup (Allow / Read-only).`;
  // Also push an out-of-band frame so the extension popup can surface the Allow /
  // Read-only / Block control proactively (relayClient.js consent_required handler).
  relay.notifyExtension({ type: 'consent_required', origin, modesOffered, message });
  return { consentRequired: true, origin, modesOffered, message };
}

async function dispatchTool(params, relay) {
  const name = params?.name;
  const args = params?.arguments || {};
  if (!name) return errorResult('missing tool name');

  // N2 kill-switch (SAFETY): if the user paused driving from the extension popup,
  // refuse every browser-touching tool until they resume. Human-only — there is no
  // tool to un-pause, so prompt-injection can't override it. fast_status/prewarm
  // stay available so the paused state is observable.
  if (!PAUSE_EXEMPT.has(name) && (await relay.isDrivingPaused())) {
    return textResult({
      error: 'Driving is paused by the user. Resume it from the FastLink extension popup to continue.',
      drivingPaused: true,
    });
  }

  // fast_prewarm: the cloud relay runs scout/vision on-demand (no background
  // navigation pre-warm wired in v1), so this is informational — it never starts
  // a browser action. The scout still works on the first real fast_scout/point.
  if (name === 'fast_prewarm') {
    const scout = await relay.getBoundScout();
    return textResult({
      prewarm: scout.enabled ? 'on-demand' : 'unavailable',
      reason: scout.enabled
        ? 'cloud relay runs the scout/vision tier on demand; no background pre-warm needed'
        : 'set the GEMINI_API_KEY relay secret to enable the scout/vision tier',
    });
  }

  // Per-origin consent gate (M4) — applies to every page-touching tool, incl. the
  // vision tiers and fast_evaluate (both in MUTATING_TOOLS). Exempt relay-native
  // tools (status/prewarm/batch) pass through; batch steps are gated in runBatch.
  {
    const verdict = await consentVerdict(relay, name);
    if (verdict) return textResult(verdict);
  }

  // Vision/scout composite tiers — ported to the Worker (task #7).
  if (VISION_TOOLS.has(name)) {
    const scout = await relay.getBoundScout();
    let result;
    switch (name) {
      case 'fast_scout':       result = await handleScout(relay, scout, args); break;
      case 'fast_point':       result = await handlePoint(relay, scout, args); break;
      case 'fast_point_som':   result = await handlePointSom(relay, scout, args); break;
      case 'fast_fill_vision': result = await handleFillVision(relay, scout, args); break;
      case 'fast_do':          result = await handleDo(relay, scout, args); break;
      case 'fast_locate':      result = await handleLocate(relay, scout, args); break;
    }
    relay.audit(name, args, !(result && result.error)); // best-effort
    return textResult(result);
  }

  // fast_evaluate: arbitrary in-page JS. Per-user ALLOWLIST gate (db.getEvalPolicy
  // + active-tab origin): enabled AND (operator allow-all OR origin allowlisted).
  if (name === 'fast_evaluate') {
    const verdict = await relay.checkEvalAllowed();
    if (!verdict.ok) return textResult({ error: verdict.error, evalBlocked: true });
  }

  // Relay-native orchestration.
  if (name === 'fast_status') return textResult(await relayStatus(relay));
  if (name === 'fast_batch') return textResult(await runBatch(args, relay));

  // Everything else: one straight passthrough to the extension.
  const payload = await relay.callExtension(name, args);
  relay.audit(name, args, !(payload && typeof payload === 'object' && 'error' in payload)); // best-effort, fire-and-forget

  // Tool-level errors come back as resolved payloads with `error` set (+ extras
  // like diagnostics/available). Surface the whole thing so the model sees it.
  if (payload && typeof payload === 'object' && 'error' in payload) return textResult(payload);

  const result = payload?.result ?? null;

  // Image-returning tools → MCP image content (no /tmp on Workers).
  if (IMAGE_TOOLS.has(name) && result && typeof result === 'object' && result.dataUrl) {
    return imageResult(result);
  }

  // Opt-in inline screenshots on other tools (e.g. fast_click screenshot:true):
  // the dataURL would bomb context and we can't save it to /tmp, so replace it
  // with a short note while keeping the rest of the result.
  if (result && typeof result === 'object' && result.screenshot?.dataUrl) {
    const { dataUrl, ...rest } = result.screenshot;
    result.screenshot = { ...rest, note: 'screenshot captured; inline image omitted in cloud relay v1 (use fast_screenshot to receive it as an image)' };
  }

  return textResult(result);
}

// Turn an extension { dataUrl, ...meta } payload into MCP image + text content.
function imageResult(result) {
  const m = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(result.dataUrl);
  const content = [];
  if (m) content.push({ type: 'image', data: m[2], mimeType: m[1] });
  // Preserve any non-image metadata (marks index, dpr, dims) as text.
  const { dataUrl, ...meta } = result;
  if (Object.keys(meta).length) content.push({ type: 'text', text: JSON.stringify(meta) });
  if (!content.length) content.push({ type: 'text', text: JSON.stringify(result) });
  return { content };
}

// Relay-aware status (replaces handlers.js's broker report). Tells the user
// whether their extension WS is attached to their DO.
async function relayStatus(relay) {
  const connected = !!relay.extSocket();
  const policy = await relay.evalPolicy();
  const scoutEnabled = (await relay.getBoundScout()).enabled;
  // Per-origin consent (M4): report the decision for the current active-tab origin.
  const origin = relay.lastOrigin || '';
  const consentMode = origin ? await relay.consentFor(origin) : null;
  // N2 kill-switch: surface the pause state so the user/Claude can see driving is
  // stopped (and which browser is driving).
  const drivingPaused = await relay.isDrivingPaused();
  return {
    connected,
    transport: 'cloud-relay',
    userId: relay.userId || null,
    devicesConnected: relay.extSocketCount(),
    drivingPaused,
    evaluateAllowed: policy.allowEvaluate,
    consentDefault: relay.consentDefault(),
    activeOrigin: origin || null,
    // Effective decision for activeOrigin: an explicit row ('allow'|'readonly'|
    // 'block') or the mode-bound default ('allow'|'prompt'|'readonly'); null when
    // no active-tab origin is known yet.
    consent: consentMode,
    readonly: consentMode === 'readonly',
    scoutEnabled,
    hint: drivingPaused
      ? 'Driving is PAUSED by the user (FastLink extension popup → Resume to continue). All browser tools are refused until then.'
      : connected
      ? 'Your browser extension is paired and connected. fast_snapshot / fast_click / fast_fill etc. should work on your active tab.'
      : 'No extension is connected to your relay. Open the FastLink extension, make sure it is in "relay" mode and paired (paste your pairing code from the relay site), then retry.',
    scoutNote: scoutEnabled
      ? 'Scout/vision tier (fast_scout, fast_point, fast_fill_vision, fast_do, fast_locate) is enabled.'
      : 'Scout/vision tier is disabled — add your own Gemini API key in relay settings, or set the operator GEMINI_API_KEY secret.',
  };
}

// --- Batch inter-step navigation re-bind (BUG-2) ---------------------------
// LIVE-SMOKE BUG (claude.ai web → this relay): in fast_batch, when an earlier
// step navigates the tab (e.g. a submit-button fast_click → results page), the
// NEXT step (notably fast_wait) timed out at the broker/DO limit even though the
// navigation completed fine. Cause: the click navigated the tab, the content
// script servicing the next step died with the old page, and the next step fired
// into the dying/old document (racing teardown) — it "waited on a corpse".
//
// The earlier fix keyed the settle off `willNavigate`, but that flag MISPREDICTS
// (a form-submit click reported willNavigate:false yet DID navigate), so it never
// fired. So the re-bind now triggers off ACTUAL navigation: capture the tab URL
// BEFORE a possibly-navigating step, watch for it to change AFTER, and on a real
// change run the fast_nav-style settle (wait for the NEW document to reach
// interactive|complete) BEFORE dispatching the next step. `willNavigate`/
// nav-actions only WIDEN the detection window — never the trigger. All bounded,
// so the relay can never re-introduce a long hang. Mirrors fast-dxt/server/
// handlers.js; the probes forward through relay.callExtension.
const SETTLE_READY_BUDGET_MS = 8000;     // wait for the NEW doc to become ready
const NAV_DETECT_MS = 2500;              // predicted/nav-action: window to observe the commit
const NAV_DETECT_UNPREDICTED_MS = 700;   // backstop window for a MISPREDICTED nav
const SETTLE_PROBE_TIMEOUT_MS = 1500;    // per readyState probe deadline (orphan, don't wait for the broker limit)
const SETTLE_POLL_GAP_MS = 150;          // gap between polls
const SETTLE_INITIAL_GAP_MS = 100;       // let teardown/commit begin before first poll

// Inherently-navigating actions whose result carries no willNavigate flag.
const NAV_ACTIONS = new Set(['fast_nav', 'fast_reload']);

// Steps that can drive a SAME-TAB navigation (so their inter-step result must be
// checked for an actual URL change). Read-only and tab-switching steps are
// excluded so they add zero latency and never trigger a false "navigated".
const POSSIBLY_NAVIGATING = new Set([
  'fast_click', 'fast_click_xy', 'fast_key', 'fast_key_press',
  'fast_nav', 'fast_reload', 'fast_select_option', 'fast_drag', 'fast_drag_xy',
]);

const settleSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One bounded readyState probe through the relay's forward path. Resolves to the
// readyState string (or null on timeout/error). Never rejects, and never blocks
// past `ms`: a late relay resolution after the race is swallowed so it can't leak
// an unhandled rejection or stall the poll loop.
function probeReadyState(relay, ms) {
  const p = relay.callExtension('fast_evaluate', { fn: '() => document.readyState' });
  p.catch(() => {}); // swallow a late rejection once the race has moved on
  return Promise.race([
    p.then((r) => (r && typeof r === 'object' ? r.result : null)).catch(() => null),
    settleSleep(ms).then(() => null),
  ]);
}

// Read the target tab's current URL WITHOUT attaching the debugger (fast_list is
// a plain chrome.tabs query → no "FastLink is debugging" banner toggle, so it
// can't shift the viewport between batch steps). Prefers the pinned target tab,
// else the active tab. '' on any failure.
async function batchTabUrl(relay) {
  try {
    const r = await relay.callExtension('fast_list');
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
// tab URL captured BEFORE the step. `willNavigateHint` and nav-actions only WIDEN
// the detection window — the trigger is the observed URL change. Returns the new
// URL on a settled navigation, else null (no navigation).
async function settleIfNavigated(relay, stepName, urlBefore, willNavigateHint) {
  const isNavAction = NAV_ACTIONS.has(stepName);
  const predicted = willNavigateHint === true || isNavAction;
  const detectBudget = predicted ? NAV_DETECT_MS : NAV_DETECT_UNPREDICTED_MS;
  await settleSleep(SETTLE_INITIAL_GAP_MS);
  // Phase 1 — watch the committed URL change away from urlBefore (real nav).
  let navUrl = null;
  const detectDeadline = Date.now() + detectBudget;
  while (Date.now() < detectDeadline) {
    const url = await batchTabUrl(relay);
    if (url && urlBefore && url !== urlBefore) { navUrl = url; break; }
    await settleSleep(SETTLE_POLL_GAP_MS);
  }
  // No URL change: no real navigation (plain non-navigating click, or an
  // over-predicted willNavigate that was an in-page/AJAX submit). Only a same-URL
  // nav-action (reload / re-nav to the same URL) still needs a readyState settle.
  if (!navUrl && !isNavAction) return null;
  // Phase 2 — wait until the (new) document answers interactive|complete so the
  // next step binds to the live page, mirroring fast_nav's post-nav health-check.
  const readyDeadline = Date.now() + SETTLE_READY_BUDGET_MS;
  while (Date.now() < readyDeadline) {
    const state = await probeReadyState(relay, SETTLE_PROBE_TIMEOUT_MS);
    if (state === 'interactive' || state === 'complete') break;
    await settleSleep(SETTLE_POLL_GAP_MS);
  }
  return navUrl || (await batchTabUrl(relay)) || urlBefore || '';
}

// Run several extension actions in one call (mirrors handlers.js runBatch). Each
// step runs only if the prior succeeded unless continueOnError is set.
async function runBatch(args, relay) {
  const actions = Array.isArray(args?.actions) ? args.actions : [];
  const continueOnError = !!args?.continueOnError;
  const results = [];
  for (let i = 0; i < actions.length; i++) {
    const step = actions[i] || {};
    if (!step.name || DIAGNOSTIC_ONLY.has(step.name)) {
      results.push({
        step: i,
        name: step.name || null,
        error: step.name
          ? `"${step.name}" is a diagnostic/deferred tool (not allowed as a batch step)`
          : 'invalid step (missing name)',
      });
      if (!continueOnError) break;
      continue;
    }
    if (step.name === 'fast_evaluate') {
      const verdict = await relay.checkEvalAllowed();
      if (!verdict.ok) {
        results.push({ step: i, name: step.name, ok: false, error: verdict.error });
        if (!continueOnError) break;
        continue;
      }
    }
    const cv = await consentVerdict(relay, step.name);
    if (cv) {
      results.push({ step: i, name: step.name, ok: false, ...cv });
      if (!continueOnError) break;
      continue;
    }
    // Capture the URL BEFORE a possibly-navigating step that has a follower, so we
    // can detect an ACTUAL navigation afterward (the in-flight commit may lag the
    // step's own return, so before-vs-after is the only reliable signal).
    const navCandidate = i < actions.length - 1 && POSSIBLY_NAVIGATING.has(step.name);
    const urlBefore = navCandidate ? await batchTabUrl(relay) : null;
    try {
      const r = await relay.callExtension(step.name, step.args || {});
      relay.audit(step.name, step.args, !(r && r.error)); // best-effort
      if (r && r.error) {
        results.push({ step: i, name: step.name, ok: false, ...r });
        if (!continueOnError) break;
      } else {
        results.push({ step: i, name: step.name, ok: true, result: r.result });
        // If this step actually navigated the tab, settle on the new document
        // before dispatching the next step so it binds to the live page (BUG-2).
        if (navCandidate) {
          await settleIfNavigated(relay, step.name, urlBefore, r.result && r.result.willNavigate);
        }
      }
    } catch (e) {
      results.push({ step: i, name: step.name, ok: false, error: e.message });
      if (!continueOnError) break;
    }
  }
  return { ran: results.length, total: actions.length, results };
}
