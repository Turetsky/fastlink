// FastLink side panel — the always-visible-across-tabs surface for the live
// transcript. Reads the SAME shared pipeline the active-tab overlay uses:
//   • chrome.storage.session['fastlink.transcript'] — latest assistant turn
//     (text + toolActivity), scraped from the claude.ai tab by claudeScrape.js.
//   • chrome.storage.session['fastlink.activity']   — running/idle/stuck state
//     written by background.js's activity tracker (one source of truth).
// It subscribes to storage.onChanged so it updates live without polling, plus a
// 1s ticker to advance the elapsed-seconds display while an action runs.

const TRANSCRIPT_KEY = 'fastlink.transcript';
const ACTIVITY_KEY   = 'fastlink.activity';
const RELAY_GATE_KEY = 'fastlink.relayActive';   // mirror background.js — transcript gate

// Action-aware stuck thresholds — mirror background.js. Form/vision/long actions
// legitimately run tens of seconds, so they get more grace than the 30s base.
const STUCK_BASE_MS = 30000;
const STUCK_LONG_MS = 50000;
const STUCK_LONG_ACTIONS = new Set([
  'fast_fill_form', 'fast_fill_vision', 'fast_fill', 'fast_do',
  'fast_scout', 'fast_locate', 'fast_point',
]);
const stuckThreshold = (action) => (STUCK_LONG_ACTIONS.has(action) ? STUCK_LONG_MS : STUCK_BASE_MS);

const els = {
  dot: document.getElementById('dot'),
  sub: document.getElementById('sub'),
  status: document.getElementById('status'),
  tool: document.getElementById('tool'),
  msg: document.getElementById('msg'),
};

// Permission + current-action surfaces aren't in the static HTML; create them once
// and slot them in (permission above the tool chip, current action below it).
const els2 = (() => {
  const perm = document.createElement('div');
  perm.id = 'perm';
  perm.style.display = 'none';
  const cur = document.createElement('div');
  cur.id = 'cur';
  cur.style.display = 'none';
  // Insert the permission block right after the status line, the current-action
  // line right after the tool chip — both before the message body.
  try { els.status.insertAdjacentElement('afterend', perm); } catch {}
  try { els.tool.insertAdjacentElement('afterend', cur); } catch {}
  injectSidepanelStyles();
  return { perm, cur };
})();

function injectSidepanelStyles() {
  const css = `
    #cur {
      margin: 8px 12px 0; font-family: var(--fl-mono); font-size: 11px; font-weight: 600;
      color: #0c1018; background: var(--fl-signal); border-radius: 6px; padding: 4px 8px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #perm {
      margin: 10px 12px 0; padding: 9px 10px; border-radius: var(--fl-r);
      border: 1px solid var(--fl-stuck); background: var(--fl-stuck-bg);
      display: flex; flex-direction: column; gap: 7px;
    }
    #perm .q { color: var(--fl-stuck-text); font-weight: 600; font-size: 12px; line-height: 1.4; }
    #perm .hint { color: var(--fl-text-faint); font-size: 11px; }
    #perm .btns { display: flex; gap: 8px; }
    #perm button {
      flex: 1; cursor: pointer; font: inherit; font-weight: 600; font-size: 12px;
      border-radius: 7px; padding: 7px 10px; border: 1px solid var(--fl-border);
    }
    #perm button.allow { background: var(--fl-ok); color: #06130c; border-color: transparent; }
    #perm button.deny  { background: rgba(255,255,255,0.08); color: var(--fl-text); }
    #perm button:hover { filter: brightness(1.08); }
    #msg .ln { white-space: pre-wrap; margin: 0 0 6px; }
    #msg .ln:last-child { margin-bottom: 0; }
    #msg .ln.bullet { padding-left: 14px; position: relative; }
    #msg .ln.bullet::before { content: '•'; position: absolute; left: 2px; color: var(--fl-text-faint); }
    #msg .ln.tool { font-family: var(--fl-mono); font-size: 12px; color: #9BD0F5; }
  `;
  try { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); } catch {}
}

let transcript = null;   // { available, text, toolActivity, ts }
let activity = null;     // { running:[{action,start}], inFlight, stuck, last, ts }
let relayActive = false; // gate: is claude.ai-web (relay) currently driving this browser?

// Build a normalized activity summary (running | idle | stuck + label/secs).
function summarize() {
  if (!activity || !activity.running || activity.running.length === 0) {
    return { state: 'idle', last: activity?.last || null };
  }
  // Oldest in-flight action drives the label + elapsed.
  let oldest = activity.running[0];
  for (const r of activity.running) if (r.start < oldest.start) oldest = r;
  const secs = Math.round((Date.now() - oldest.start) / 1000);
  const stuck = activity.stuck || (Date.now() - oldest.start >= stuckThreshold(oldest.action));
  const more = activity.running.length > 1 ? ` +${activity.running.length - 1}` : '';
  return {
    state: stuck ? 'stuck' : 'running',
    label: humanVerb(oldest.action) + more,
    secs,
    last: activity.last || null,
  };
}

const VERB = {
  fast_snapshot: 'Reading page', fast_marks: 'Reading page', fast_text: 'Reading text',
  fast_vision_capture: 'Looking at page', fast_annotate_boxes: 'Looking at page',
  fast_screenshot: 'Capturing screenshot', fast_click: 'Clicking', fast_click_xy: 'Clicking',
  fast_fill: 'Typing', fast_type: 'Typing', fast_fill_vision: 'Typing',
  fast_fill_form: 'Filling form', fast_select_option: 'Selecting',
  fast_nav: 'Navigating', fast_reload: 'Reloading', fast_scroll: 'Scrolling',
  fast_wheel: 'Scrolling', fast_hover: 'Hovering', fast_drag: 'Dragging',
  fast_upload: 'Uploading file',
  fast_wait: 'Waiting', fast_key: 'Pressing key', fast_tab: 'Switching tab',
  fast_switch: 'Switching tab', fast_list: 'Listing tabs', fast_close: 'Closing tab',
  fast_console: 'Reading console', fast_network: 'Reading network', fast_evaluate: 'Running script',
};
const humanVerb = (a) => VERB[a] || String(a || '').replace(/^fast_/, '').replace(/_/g, ' ') || 'Working';

function render() {
  // GATE: the transcript surfaces only while claude.ai-web (the relay) is driving
  // this browser. Otherwise show a neutral "no active claude.ai session" state
  // rather than a stale message or local-broker activity.
  if (!relayActive) {
    els.status.textContent = 'No active claude.ai session';
    els.status.className = 'status idle';
    els.dot.className = 'dot idle';
    els.tool.textContent = '';
    els2.cur.style.display = 'none';
    els2.perm.style.display = 'none';
    els.msg.textContent = 'No active claude.ai session — Claude isn’t driving this browser from the web right now.';
    els.msg.className = 'msg empty';
    els.sub.textContent = '';
    return;
  }

  const a = summarize();
  // Status line + header dot.
  if (a.state === 'stuck') {
    els.status.textContent = `⚠ possibly stuck — ${a.label} (${a.secs}s)`;
    els.status.className = 'status stuck';
    els.dot.className = 'dot stuck';
  } else if (a.state === 'running') {
    els.status.textContent = `▶ ${a.label} (${a.secs}s)`;
    els.status.className = 'status working';
    els.dot.className = 'dot run';
  } else if (a.last) {
    const ago = Math.round((Date.now() - a.last.endedAt) / 1000);
    els.status.textContent = `✓ idle — last: ${a.last.action} ${a.last.ok ? '✓' : '✗'} ${ago}s ago`;
    els.status.className = 'status idle';
    els.dot.className = 'dot idle';
  } else {
    els.status.textContent = 'idle — waiting for Claude';
    els.status.className = 'status idle';
    els.dot.className = 'dot idle';
  }

  // Permission prompt (Task D, best-effort).
  renderPermission(transcript && transcript.permission);

  // Current action highlight (mono) from the structured shape.
  const cur = transcript && transcript.structured && transcript.structured.currentAction;
  if (cur) { els2.cur.textContent = '▸ ' + cur; els2.cur.style.display = ''; }
  else els2.cur.style.display = 'none';

  // Tool activity chip — superseded by the mono current-action line when present.
  els.tool.textContent = (transcript && transcript.available && transcript.toolActivity && !cur)
    ? '🔧 ' + transcript.toolActivity : '';

  // Latest message body — structured lines (prose / bullet / tool) when available.
  renderMessage();

  // Freshness sub-label.
  const ts = transcript?.ts;
  els.sub.textContent = ts ? `updated ${Math.max(0, Math.round((Date.now() - ts) / 1000))}s ago` : '';
}

function renderMessage() {
  if (!transcript || !transcript.available) {
    els.msg.textContent = 'Transcript unavailable — open a claude.ai tab (or its layout changed).';
    els.msg.className = 'msg empty';
    return;
  }
  const lines = transcript.structured && Array.isArray(transcript.structured.lines)
    ? transcript.structured.lines : null;
  if ((!lines || !lines.length) && !transcript.text) {
    els.msg.textContent = 'Waiting for Claude…';
    els.msg.className = 'msg empty';
    return;
  }
  if (!lines || !lines.length) {            // back-compat: only raw text available
    els.msg.textContent = transcript.text;
    els.msg.className = 'msg';
    return;
  }
  els.msg.className = 'msg';
  els.msg.textContent = '';
  for (const ln of lines) {
    const d = document.createElement('div');
    d.className = 'ln ' + (ln.kind || 'prose');
    d.textContent = ln.text || '';
    els.msg.appendChild(d);
  }
}

// Task D (best-effort): render the permission ask + Allow/Deny. If not actionable
// (real buttons not found in claude.ai), still SHOW the ask and tell the user to
// approve it inside claude.ai.
function renderPermission(perm) {
  if (!perm || !perm.present) { els2.perm.style.display = 'none'; els2.perm.textContent = ''; return; }
  els2.perm.style.display = '';
  els2.perm.textContent = '';
  const q = document.createElement('div');
  q.className = 'q';
  q.textContent = 'Claude is asking to use FastLink tools.';
  els2.perm.appendChild(q);
  if (perm.actionable) {
    const btns = document.createElement('div');
    btns.className = 'btns';
    const allow = document.createElement('button');
    allow.className = 'allow';
    allow.textContent = perm.allowText || 'Allow';
    allow.addEventListener('click', () => respondPermission('allow'));
    const deny = document.createElement('button');
    deny.className = 'deny';
    deny.textContent = perm.denyText || 'Deny';
    deny.addEventListener('click', () => respondPermission('deny'));
    btns.appendChild(allow); btns.appendChild(deny);
    els2.perm.appendChild(btns);
  } else {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Approve it in the claude.ai tab to continue.';
    els2.perm.appendChild(hint);
  }
}

function respondPermission(decision) {
  try {
    chrome.runtime.sendMessage({ type: 'fastlink:permission-respond', decision }, () => void chrome.runtime.lastError);
  } catch {}
  els2.perm.style.display = 'none';
  els2.perm.textContent = '';
}

// Initial load.
chrome.storage.session.get([TRANSCRIPT_KEY, ACTIVITY_KEY, RELAY_GATE_KEY]).then((o) => {
  transcript = o?.[TRANSCRIPT_KEY] || null;
  activity = o?.[ACTIVITY_KEY] || null;
  relayActive = !!(o?.[RELAY_GATE_KEY]?.active);
  render();
}).catch(() => render());

// Live updates from the shared pipeline.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes[TRANSCRIPT_KEY]) transcript = changes[TRANSCRIPT_KEY].newValue || null;
  if (changes[ACTIVITY_KEY]) activity = changes[ACTIVITY_KEY].newValue || null;
  if (changes[RELAY_GATE_KEY]) relayActive = !!(changes[RELAY_GATE_KEY].newValue?.active);
  if (changes[TRANSCRIPT_KEY] || changes[ACTIVITY_KEY] || changes[RELAY_GATE_KEY]) render();
});

// Advance elapsed counters once a second while something is running. No-op while
// the gate is off (the neutral state has no live counters to tick).
setInterval(() => {
  if (!relayActive) return;
  if (activity && activity.running && activity.running.length) render();
  else if (transcript?.ts) els.sub.textContent = `updated ${Math.round((Date.now() - transcript.ts) / 1000)}s ago`;
}, 1000);
