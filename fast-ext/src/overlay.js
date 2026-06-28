// FastLink activity overlay — the SINGLE fixed top-right panel. It shows each
// tool call as it runs AND (folded in from the former transcriptOverlay.js, the
// old second box) the live claude.ai transcript, current-action, and permission
// Allow/Deny block while the relay is driving. Always on, content script in
// ISOLATED world. Speed principle: every message arrives via fire-and-forget
// chrome.tabs.sendMessage from the background, so nothing here ever blocks the
// action path.
//
// Two message streams feed this ONE host:
//   • {fastlink:'event', phase:start|heartbeat|end} — tool-call rows (both
//     transports; only ever reaches the DRIVEN tab).
//   • {fastlink:'transcript', transcript, activity} — scraped transcript +
//     permission + activity summary, pushed onto the user's active tab while a
//     relay session drives. {active:false} tears the transcript section down.
// There is no standalone idle/empty-state box: the transcript section only
// appears with real content (or a running/stuck session) and the whole host is
// removed when idle. The "waiting / unavailable" empty-state lives ONLY in the
// docked side panel.

(() => {
  // Re-injection (e.g. background re-injecting after a worker restart / extension
  // reload) must REBUILD, not no-op — the previous instance's chrome.runtime
  // context is dead and its onMessage listener can never fire again. Always remove
  // any existing host FIRST — unconditionally, not just when __fastlinkOverlayInstalled
  // is set: after a full extension reload the fresh script runs in a NEW isolated
  // world where that flag is unset, but the orphan's host DOM node still sits in the
  // page. Removing by id guarantees re-injection cleanly REPLACES the orphan instead
  // of stacking a second panel on top of the frozen one.
  try { document.getElementById('__fastlink_overlay_host__')?.remove(); } catch {}
  try { window.__fastlinkOverlayTeardown?.(); } catch {}
  window.__fastlinkOverlayInstalled = true;

  const HOST_ID = '__fastlink_overlay_host__';
  const MAX_ROWS = 8;
  const OV_MAX_LINES = 7;   // transcript section is small — show only recent lines
  const FADE_AFTER_MS = 1800;
  const REMOVE_AFTER_MS = 3000;
  // Tear the whole panel off the page this long after the LAST tool finishes
  // (no rows still running). The panel mounts lazily on the first tool, so this
  // gives it a symmetric lifecycle: appear on first tool, vanish after the last.
  // Kept short so a finished burst clears fast instead of lingering on the tab.
  const DISMISS_AFTER_MS = 2200;
  // HARD GUARD (belt-and-suspenders). Regardless of any stuck timer, lost 'end'
  // ping, or background bug, the panel must NEVER sit on a page indefinitely when
  // nothing is actually happening. A watchdog force-destroys the host once it has
  // been mounted this long with no running row, no live transcript, and no pending
  // permission. This is the last line of defense behind every other dismiss path.
  const HARD_MAX_IDLE_MS = 4000;

  let host = null;
  let shadow = null;
  let listEl = null;
  let statusEl = null;
  let hdrDot = null;
  let dismissTimer = null;
  let mountedAt = 0;   // performance.now() when the host was last mounted (hard-guard)
  const rows = new Map(); // id -> { rowEl, args, label, timers }

  // Transcript/permission section — folded in from the former transcriptOverlay.js
  // (the second box). Populated by {fastlink:'transcript'} pushes from background
  // during an active relay session; cleared when the relay stops driving.
  let permEl = null;
  let curEl = null;
  let msgEl = null;
  let transcriptActive = false;   // a live relay transcript is keeping the box up
  let tData = null;               // latest transcript { available, text, structured, permission }
  let tActivity = null;           // latest activity summary { state, label, secs, last }

  // Staleness watchdog. The background worker pings us (start / heartbeat / end)
  // while it's alive and working. If a row is still "running" but no ping has
  // arrived for STALE_MS, the worker driving this overlay died mid-action — so we
  // neutralize the frozen row instead of showing "▶ …" forever. A genuinely long
  // action keeps getting heartbeats, so this never false-positives on it.
  const STALE_MS = 8000;
  let lastMsgAt = performance.now();
  let staleNeutral = false;

  // Map a raw tool name to a human-readable present-tense verb the user can
  // grok at a glance. Anything unmapped falls back to the de-prefixed name.
  const VERB = {
    fast_snapshot: 'Reading page', fast_marks: 'Reading page',
    fast_text: 'Reading text', fast_vision_capture: 'Looking at page',
    fast_annotate_boxes: 'Looking at page', fast_screenshot: 'Capturing screenshot',
    fast_click: 'Clicking', fast_click_xy: 'Clicking',
    fast_fill: 'Typing', fast_type: 'Typing', fast_fill_vision: 'Typing',
    fast_fill_form: 'Filling form', fast_select_option: 'Selecting',
    fast_nav: 'Navigating to', fast_reload: 'Reloading',
    fast_scroll: 'Scrolling', fast_wheel: 'Scrolling',
    fast_hover: 'Hovering', fast_drag: 'Dragging', fast_drag_xy: 'Dragging',
    fast_wait: 'Waiting', fast_key: 'Pressing key', fast_key_press: 'Pressing key',
    fast_tab: 'Switching tab', fast_switch: 'Switching tab',
    fast_list: 'Listing tabs', fast_close: 'Closing tab',
    fast_console: 'Reading console', fast_network: 'Reading network',
    fast_network_replay: 'Replaying request', fast_evaluate: 'Running script',
    fast_macro_run: 'Running macro', fast_macro_save: 'Saving macro',
    fast_macro_list: 'Listing macros', fast_macro_delete: 'Deleting macro',
  };
  const humanVerb = (action) =>
    VERB[action] || String(action || '').replace(/^fast_/, '').replace(/_/g, ' ') || 'Working';

  // ---- prewarm mini-indicator -----------------------------------------------
  // Server-initiated pre-warm reads (snapshot/vision capture fired on navigation
  // to warm the scout cache) are NOT Claude driving the tab — mounting the full
  // "Claude is driving this tab" panel for them reads as phantom control. They
  // get a tiny dim pulsing dot instead. If the full panel is already up (real
  // tools running), the dot is skipped — the panel already signals activity.
  const PW_DOT_ID = '__fastlink_prewarm_dot__';
  const PW_LINGER_MS = 1200;   // dot lingers this long after the last prewarm ends
  const PW_MAX_MS = 15000;     // safety: a lost 'end' never leaves the dot stuck
  let pwHost = null;
  let pwTimer = null;          // pending removal (linger or safety)
  const pwActive = new Set();  // outstanding prewarm event ids

  const removePrewarmDot = () => {
    if (pwTimer) { clearTimeout(pwTimer); pwTimer = null; }
    try { pwHost?.remove(); } catch {}
    pwHost = null;
    pwActive.clear();
  };
  const showPrewarmDot = () => {
    if (host && document.documentElement.contains(host)) return; // full panel up
    if (pwHost && document.documentElement.contains(pwHost)) return;
    pwHost = document.createElement('div');
    pwHost.id = PW_DOT_ID;
    pwHost.title = 'FastLink is pre-reading this page (prewarm)';
    pwHost.style.cssText =
      'all:initial;position:fixed;top:14px;right:14px;width:9px;height:9px;' +
      'border-radius:50%;background:#F5AE3C;opacity:0.4;' +
      'box-shadow:0 0 5px rgba(245,174,60,0.5);z-index:2147483647;pointer-events:auto;';
    try {
      pwHost.animate(
        [{ opacity: 0.2 }, { opacity: 0.5 }, { opacity: 0.2 }],
        { duration: 1600, iterations: Infinity },
      );
    } catch {}
    document.documentElement.appendChild(pwHost);
  };
  const onPrewarmEvent = (msg) => {
    if (msg.phase === 'start') {
      pwActive.add(msg.id);
      showPrewarmDot();
      if (pwTimer) clearTimeout(pwTimer);
      pwTimer = setTimeout(removePrewarmDot, PW_MAX_MS);
    } else if (msg.phase === 'end') {
      pwActive.delete(msg.id);
      if (!pwActive.size) {
        if (pwTimer) clearTimeout(pwTimer);
        pwTimer = setTimeout(removePrewarmDot, PW_LINGER_MS);
      }
    }
  };

  const ensureMounted = () => {
    if (host && document.documentElement.contains(host)) return;
    mountedAt = performance.now();
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;top:12px;right:12px;z-index:2147483647;pointer-events:none;';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    // Palette literals mirror src/theme.css (DARK block) — keep in sync:
    //   signal #F5AE3C · ok #3FBE7D · err #F26A6A · text #E9ECF2 · dim #9BA5B5
    style.textContent = `
      :host, * { box-sizing:border-box; }
      .panel {
        font:12px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
        color:#E9ECF2;
        background:rgba(22,28,39,0.80);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        border:1px solid rgba(255,255,255,0.08);
        border-radius:12px;
        box-shadow:0 8px 24px rgba(0,0,0,0.4);
        padding:8px 10px;
        min-width:240px;
        max-width:360px;
        pointer-events:auto;
      }
      .hdr { display:flex; align-items:center; gap:7px; margin-bottom:6px; opacity:0.95; }
      .mark {
        flex:none; width:16px; height:16px; border-radius:5px;
        background:linear-gradient(135deg,#F5AE3C,#F5AE3C);
        box-shadow:inset 0 1px 0 rgba(255,255,255,0.25);
      }
      .dot { width:8px; height:8px; border-radius:50%; background:#F5AE3C; box-shadow:0 0 6px #F5AE3C; flex:none; }
      .dot.run  { background:#F5AE3C; box-shadow:0 0 6px #F5AE3C; animation:flpulse 1s ease-in-out infinite; }
      .dot.idle { background:#3FBE7D; box-shadow:0 0 6px #3FBE7D; animation:none; }
      .dot.stuck{ background:#F0863A; box-shadow:0 0 6px #F0863A; animation:flpulse 1.4s ease-in-out infinite; }
      @keyframes flpulse { 0%,100%{opacity:1;} 50%{opacity:0.25;} }
      .ttl { font-weight:600; letter-spacing:0.2px; }
      .status {
        display:flex; align-items:center; gap:4px;
        margin-bottom:6px; padding:3px 6px; border-radius:6px;
        font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        background:rgba(255,255,255,0.05); color:#9BA5B5;
      }
      .status.working { color:#FAC56B; background:rgba(245,174,60,0.14); }
      .status.done    { color:#6FD89A; background:rgba(95,207,138,0.14); }
      .status.stuck   { color:#f0b070; background:rgba(235,148,80,0.16); }
      /* ---- transcript / permission section (folded in from transcriptOverlay) -- */
      .perm {
        border:1px solid rgba(240,134,58,0.5); background:rgba(240,134,58,0.12);
        border-radius:8px; padding:7px 8px; margin-bottom:6px;
        display:flex; flex-direction:column; gap:6px;
      }
      .perm .q { color:#FAC56B; font-weight:600; font-size:11px; line-height:1.35; }
      .perm .hint { color:#9BA5B5; font-size:10px; }
      .perm .btns { display:flex; gap:6px; }
      .perm button {
        flex:1; cursor:pointer; font:inherit; font-size:11px; font-weight:600;
        border-radius:6px; padding:5px 8px; border:1px solid rgba(255,255,255,0.12);
      }
      .perm button.allow { background:#3FBE7D; color:#06130c; border-color:transparent; }
      .perm button.deny  { background:rgba(255,255,255,0.08); color:#E9ECF2; }
      .perm button:hover { filter:brightness(1.08); }
      .cur {
        font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11px;
        color:#0c1018; background:#F5AE3C; font-weight:600;
        border-radius:5px; padding:3px 7px; margin-bottom:6px; align-self:flex-start; max-width:100%;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      }
      .cur.hidden { display:none; }
      .msg {
        color:#d6dae3; background:rgba(255,255,255,0.04);
        border-radius:6px; padding:6px 8px; margin-bottom:6px;
        max-height:11em; overflow:hidden;
        display:flex; flex-direction:column; gap:5px;
        word-break:break-word;
      }
      .ln { white-space:pre-wrap; }
      .ln.bullet { padding-left:10px; position:relative; }
      .ln.bullet::before { content:'•'; position:absolute; left:0; color:#9BA5B5; }
      .ln.tool { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11px; color:#9BD0F5; opacity:0.95; }
      .list { display:flex; flex-direction:column; gap:4px; max-height:60vh; overflow:hidden; }
      .row {
        display:flex; align-items:baseline; gap:6px;
        padding:4px 6px; border-radius:6px;
        background:rgba(255,255,255,0.04);
        transition:opacity 600ms ease;
        opacity:1;
      }
      .row.fade { opacity:0.35; }
      .row.run  { box-shadow: inset 2px 0 0 #F5AE3C; }
      .row.ok   { box-shadow: inset 2px 0 0 #3FBE7D; }
      .row.err  { box-shadow: inset 2px 0 0 #F26A6A; }
      .tool { color:#E9ECF2; font-weight:600; white-space:nowrap; }
      .meta { color:#9BA5B5; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .ms   { color:#5F6B7E; font-variant-numeric:tabular-nums; }
      .empty { color:#5F6B7E; font-style:italic; padding:2px 6px; }
    `;
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `<div class="hdr"><span class="mark"></span><span class="dot"></span><span class="ttl">Claude is driving this tab</span></div><div class="status"></div><div class="perm" style="display:none"></div><div class="cur hidden"></div><div class="msg" style="display:none"></div><div class="list"></div>`;
    shadow.appendChild(style);
    shadow.appendChild(panel);
    listEl = panel.querySelector('.list');
    statusEl = panel.querySelector('.status');
    hdrDot = panel.querySelector('.dot');
    permEl = panel.querySelector('.perm');
    curEl = panel.querySelector('.cur');
    msgEl = panel.querySelector('.msg');
    document.documentElement.appendChild(host);
    updateStatus();
    renderTranscript();   // paint any transcript content captured before mount
  };

  // Reflect live driving state in the header so a user glancing over from the
  // claude.ai tab instantly sees what's happening — and, crucially, when it's
  // DONE. Three states: working (an action is mid-flight), done/idle (Claude
  // finished, nothing running), and connected (panel up, nothing yet).
  const updateStatus = () => {
    if (!statusEl) return;
    if (staleNeutral) {
      statusEl.textContent = '↻ reconnecting… (refresh tab if this persists)';
      statusEl.className = 'status';
      if (hdrDot) hdrDot.className = 'dot idle';
      return;
    }
    // Local tool-call rows (direct, low-latency) take priority when one is live.
    let running = null;
    for (const e of rows.values()) if (e.rowEl.classList.contains('run')) running = e;
    if (running) {
      statusEl.textContent = '▶ ' + running.label;
      statusEl.className = 'status working';
      if (hdrDot) hdrDot.className = 'dot run';
      return;
    }
    // No local row running — fall back to the relay activity summary, so a
    // NON-driven active tab (which gets transcript pushes but no event rows) still
    // shows a live running/stuck/idle status.
    const a = tActivity;
    if (a && a.state === 'stuck') {
      statusEl.textContent = `⚠ possibly stuck — ${a.label || ''} (${a.secs ?? 0}s)`;
      statusEl.className = 'status stuck';
      if (hdrDot) hdrDot.className = 'dot stuck';
      return;
    }
    if (a && a.state === 'running') {
      statusEl.textContent = `▶ ${a.label || 'working'} (${a.secs ?? 0}s)`;
      statusEl.className = 'status working';
      if (hdrDot) hdrDot.className = 'dot run';
      return;
    }
    if (rows.size) {
      statusEl.textContent = '✓ Done — idle';
      statusEl.className = 'status done';
      if (hdrDot) hdrDot.className = 'dot idle';
      return;
    }
    if (a && a.last) {
      statusEl.textContent = `✓ idle — last: ${a.last.action} ${a.last.ok ? '✓' : '✗'}`;
      statusEl.className = 'status done';
      if (hdrDot) hdrDot.className = 'dot idle';
      return;
    }
    if (transcriptActive) {
      statusEl.textContent = 'idle';
      statusEl.className = 'status';
      if (hdrDot) hdrDot.className = 'dot idle';
      return;
    }
    statusEl.textContent = 'Connected — waiting for Claude';
    statusEl.className = 'status';
    if (hdrDot) hdrDot.className = 'dot idle';
  };

  const fmtMeta = (action, args) => {
    if (!args) return '';
    if (args.text)      return `"${String(args.text).slice(0, 40)}"`;
    if (args.match)     return `"${String(args.match).slice(0, 40)}"`;
    if (args.from)      return `${args.from} → ${args.to ?? `(${args.toX},${args.toY})`}`;
    if (args.field)     return `${args.field}: ${args.option ?? ''}`;
    if (args.url)       return String(args.url).slice(0, 50);
    if (args.selector)  return String(args.selector).slice(0, 40);
    if (args.to)        return `scroll → ${args.to}`;
    if (typeof args.pixels === 'number') return `scroll ${args.pixels > 0 ? '+' : ''}${args.pixels}px`;
    if (args.fields)    return `${Object.keys(args.fields).length} fields`;
    if (args.name)      return String(args.name);
    return '';
  };

  const ensureRow = (id, action, args) => {
    cancelDismiss();   // a fresh tool means we're active again — keep the panel up
    ensureMounted();
    if (rows.has(id)) return rows.get(id);
    // Trim oldest if at cap.
    if (listEl.childElementCount >= MAX_ROWS) {
      const first = listEl.firstElementChild;
      if (first) {
        const oldId = first.dataset.id;
        first.remove();
        rows.delete(oldId);
      }
    }
    const verb = humanVerb(action);
    const meta = fmtMeta(action, args);
    const rowEl = document.createElement('div');
    rowEl.className = 'row run';
    rowEl.dataset.id = id;
    rowEl.innerHTML = `<span class="tool"></span><span class="meta"></span><span class="ms"></span>`;
    rowEl.querySelector('.tool').textContent = verb;
    rowEl.querySelector('.meta').textContent = meta;
    listEl.appendChild(rowEl);
    const entry = { rowEl, started: performance.now(), label: meta ? `${verb} ${meta}` : verb, timers: [] };
    rows.set(id, entry);
    updateStatus();
    return entry;
  };

  const completeRow = (id, ok, errMsg) => {
    const entry = rows.get(id);
    if (!entry) return;
    const ms = Math.round(performance.now() - entry.started);
    entry.rowEl.classList.remove('run');
    entry.rowEl.classList.add(ok ? 'ok' : 'err');
    entry.rowEl.querySelector('.ms').textContent = `${ms}ms`;
    if (!ok && errMsg) {
      const meta = entry.rowEl.querySelector('.meta');
      meta.textContent = (meta.textContent ? meta.textContent + ' — ' : '') + String(errMsg).slice(0, 60);
    }
    entry.timers.push(setTimeout(() => entry.rowEl.classList.add('fade'), FADE_AFTER_MS));
    entry.timers.push(setTimeout(() => { entry.rowEl.remove(); rows.delete(id); updateStatus(); }, REMOVE_AFTER_MS));
    // Refresh the header: flips to "✓ Done — idle" once nothing is still running.
    updateStatus();
    // If that was the last tool still running, start the countdown to close the
    // whole panel. A new tool (ensureRow → cancelDismiss) cancels it; otherwise
    // the panel disappears DISMISS_AFTER_MS after this final tool.
    if (!anyRunning()) scheduleDismiss();
  };

  const anyRunning = () => {
    for (const e of rows.values()) if (e.rowEl.classList.contains('run')) return true;
    return false;
  };

  const cancelDismiss = () => { if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; } };

  // Tear the whole host off the page and null every element ref so the NEXT tool
  // run / transcript push re-mounts a fresh panel via ensureMounted.
  const destroyHost = () => {
    try { host?.remove(); } catch {}
    host = shadow = listEl = statusEl = hdrDot = permEl = curEl = msgEl = null;
  };

  // Remove the entire overlay host (header dot + list + transcript) and reset
  // state so the NEXT tool run re-mounts a fresh panel via ensureMounted. A live
  // relay transcript keeps the box up — only the relay going inactive (handled in
  // onTranscript) tears it down then.
  const scheduleDismiss = () => {
    cancelDismiss();
    if (transcriptActive) return;   // a live relay transcript keeps the single box up
    dismissTimer = setTimeout(() => {
      dismissTimer = null;
      clearAll();
      destroyHost();
    }, DISMISS_AFTER_MS);
  };

  // ---- transcript / permission rendering (folded in from transcriptOverlay) ---
  // Whether the latest transcript/activity is worth surfacing the box for. We
  // never mount a standalone idle/empty box: real content (lines/permission/
  // current-action) OR a genuinely running/stuck relay session is required.
  const transcriptWorthShowing = () => {
    const t = tData, a = tActivity;
    // A pending permission prompt always surfaces — it needs the user regardless
    // of driving state.
    if (t && t.permission && t.permission.present) return true;
    // Otherwise surface ONLY while the relay is GENUINELY working (a relay command
    // running/stuck). Never mount for an IDLE relay just because stale transcript
    // text/lines are still cached from an earlier turn — that is what made the
    // "Claude is driving this tab / idle — last: …" card ride every tab.
    if (a && (a.state === 'running' || a.state === 'stuck')) return true;
    return false;
  };

  const clearTranscriptSections = () => {
    if (permEl) { permEl.style.display = 'none'; permEl.textContent = ''; }
    if (curEl) curEl.className = 'cur hidden';
    if (msgEl) { msgEl.style.display = 'none'; msgEl.textContent = ''; }
  };

  const renderTranscript = () => {
    if (!permEl) return;            // not mounted yet
    renderPermission(tData && tData.permission);
    const cur = tData && tData.structured && tData.structured.currentAction;
    if (curEl) {
      if (cur && !staleNeutral) { curEl.textContent = '▸ ' + cur; curEl.className = 'cur'; }
      else curEl.className = 'cur hidden';
    }
    renderMessage(tData);
  };

  // Render the latest turn as discrete lines (prose / bullet / tool). Small box,
  // so keep only the most recent OV_MAX_LINES. NO empty-state — when there's
  // nothing available the section hides entirely (the empty-state lives only in
  // the docked side panel).
  const renderMessage = (t) => {
    if (!msgEl) return;
    const lines = t && t.structured && Array.isArray(t.structured.lines) ? t.structured.lines : null;
    const hasLines = !!(lines && lines.length);
    if (staleNeutral || !t || !t.available || (!hasLines && !t.text)) {
      msgEl.style.display = 'none';
      msgEl.textContent = '';
      return;
    }
    msgEl.style.display = '';
    msgEl.className = 'msg';
    if (!hasLines) { msgEl.textContent = t.text; return; }   // back-compat: raw text only
    msgEl.textContent = '';
    const shown = lines.slice(-OV_MAX_LINES);
    if (lines.length > shown.length) {
      const more = document.createElement('div');
      more.className = 'ln tool';
      more.textContent = `… (+${lines.length - shown.length} earlier)`;
      msgEl.appendChild(more);
    }
    for (const ln of shown) {
      const d = document.createElement('div');
      d.className = 'ln ' + (ln.kind || 'prose');
      d.textContent = ln.text || '';
      msgEl.appendChild(d);
    }
  };

  // Permission ask + Allow/Deny. If not actionable (couldn't grab the real
  // buttons) we still SHOW it and tell the user to approve inside claude.ai.
  const renderPermission = (perm) => {
    if (!permEl) return;
    if (staleNeutral || !perm || !perm.present) { permEl.style.display = 'none'; permEl.textContent = ''; return; }
    permEl.style.display = '';
    permEl.textContent = '';
    const q = document.createElement('div');
    q.className = 'q';
    q.textContent = 'Claude is asking to use FastLink tools.';
    permEl.appendChild(q);
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
      permEl.appendChild(btns);
    } else {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = 'Approve it in the claude.ai tab to continue.';
      permEl.appendChild(hint);
    }
  };

  const respondPermission = (decision) => {
    try {
      chrome.runtime.sendMessage({ type: 'fastlink:permission-respond', decision }, () => void chrome.runtime.lastError);
    } catch {}
    // Optimistically hide; a fresh scrape will confirm it cleared.
    if (permEl) { permEl.style.display = 'none'; permEl.textContent = ''; }
  };

  // Handle a {fastlink:'transcript'} push from background. {active:false} means
  // the relay stopped driving — tear the transcript section down (and the whole
  // box if nothing else keeps it up). Otherwise fold the content into the box.
  const onTranscript = (msg) => {
    if (msg.active === false) {
      transcriptActive = false;
      tData = null;
      tActivity = null;
      clearTranscriptSections();
      updateStatus();
      if (!anyRunning()) scheduleDismiss();
      return;
    }
    // A fresh push proves the worker is alive: refresh liveness + drop stale state.
    lastMsgAt = performance.now();
    staleNeutral = false;
    tData = msg.transcript || tData;
    tActivity = msg.activity ?? tActivity;
    if (!transcriptWorthShowing()) {
      // Nothing meaningful (idle, no content) — never force an idle box open. If a
      // box is up only because the relay WAS active, re-arm the dismiss now that
      // it isn't (scheduleDismiss no-ops while real rows are still running).
      transcriptActive = false;
      if (host) {
        clearTranscriptSections();
        updateStatus();
        if (!anyRunning()) scheduleDismiss();
      }
      return;
    }
    transcriptActive = true;
    cancelDismiss();
    ensureMounted();
    renderTranscript();
    updateStatus();
  };

  const onMessage = (msg) => {
    if (!msg) return;
    if (msg.fastlink === 'transcript') { onTranscript(msg); return; }
    if (msg.fastlink !== 'event') return;
    // Any ping (start / heartbeat / end) proves the worker is alive: refresh the
    // liveness clock and drop a prior stale state so a revived session shows fresh.
    lastMsgAt = performance.now();
    if (staleNeutral) { staleNeutral = false; updateStatus(); }
    if (msg.phase === 'heartbeat') return;       // liveness ping only — no row
    if (msg.prewarm) { onPrewarmEvent(msg); return; }  // background pre-read → dot, not panel
    if (msg.phase === 'start') ensureRow(msg.id, msg.action, msg.args);
    else if (msg.phase === 'end') completeRow(msg.id, msg.ok, msg.error);
  };
  chrome.runtime.onMessage.addListener(onMessage);

  // Wipe every row + transcript and cancel its fade/remove timers. Used on page
  // transitions so nothing from a prior run survives.
  const clearAll = () => {
    for (const entry of rows.values()) {
      entry.timers.forEach(clearTimeout);
      try { entry.rowEl.remove(); } catch {}
    }
    rows.clear();
    removePrewarmDot();
    transcriptActive = false;
    tData = null;
    tActivity = null;
    clearTranscriptSections();
    updateStatus();
  };

  // bfcache trap: when this page is frozen into the back/forward cache, its rows
  // and their pending setTimeout fade/remove handlers freeze with it. On restore
  // the JS context resumes and those timers fire — so a stale run's tools appear
  // and fade out one-by-one on a page that isn't being driven at all. Clear on
  // the way out (pagehide) and on bfcache restore (pageshow.persisted).
  const onPageHide = () => clearAll();
  const onPageShow = (e) => { if (e.persisted) clearAll(); };
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);

  // Drop any 'run' rows and flip to a neutral note when the worker goes silent
  // mid-action (it was killed, or the extension reloaded). Then let the normal
  // dismiss timer fade the panel out, so we never sit frozen on "▶ …".
  const markStale = () => {
    for (const [id, e] of rows) {
      if (e.rowEl.classList.contains('run')) {
        e.timers.forEach(clearTimeout);
        try { e.rowEl.remove(); } catch {}
        rows.delete(id);
      }
    }
    staleNeutral = true;
    transcriptActive = false;      // let the reconnect note dismiss; a fresh push revives it
    clearTranscriptSections();     // drop stale transcript content during reconnect
    ensureMounted();
    updateStatus();
    scheduleDismiss();
  };
  // A relay session can be live on a NON-driven active tab too (transcript pushes,
  // no event rows). Treat a running/stuck activity summary as "believed running"
  // so the watchdog also catches a worker dying during a transcript-only session.
  const isTranscriptActiveState = () => !!tActivity && (tActivity.state === 'running' || tActivity.state === 'stuck');
  const staleWatch = setInterval(() => {
    if (staleNeutral) return;
    if (!anyRunning() && !isTranscriptActiveState()) return;   // only while we believe work is in flight
    if (performance.now() - lastMsgAt > STALE_MS) markStale();
  }, 2000);

  // HARD GUARD watchdog. Independent of every other dismiss path: if the host is
  // mounted but there is genuinely nothing to show — no row still running, no live
  // relay transcript, no pending permission prompt — for longer than
  // HARD_MAX_IDLE_MS, force it off the page. This catches any case the normal
  // timers miss (a lost 'end' ping, a stuck background gate, a re-mount that never
  // got a dismiss armed) so the panel can never ride a tab while idle.
  const permissionPending = () => !!(tData && tData.permission && tData.permission.present);
  const hardGuard = setInterval(() => {
    if (!host || !document.documentElement.contains(host)) return;
    if (anyRunning() || transcriptActive || permissionPending() || staleNeutral) return;
    // Idle since the last real signal (tool event / transcript push). mountedAt
    // seeds it so a panel that mounts and then goes silent still ages out.
    const idleSince = Math.max(lastMsgAt, mountedAt);
    if (performance.now() - idleSince < HARD_MAX_IDLE_MS) return;
    clearAll();
    destroyHost();
  }, 1000);

  // Self-heal: when the extension is reloaded, this content script is orphaned —
  // chrome.runtime.id starts throwing "Extension context invalidated" and no new
  // tool events can arrive. Show a TRANSIENT reconnecting note (not a permanent
  // stale line) and then remove the whole panel: the dead context can't receive
  // updates, and the manifest content script re-injects on the next page load.
  const ctxWatch = setInterval(() => {
    let alive = true;
    try { alive = !!chrome.runtime?.id; } catch { alive = false; }
    if (alive) return;
    clearInterval(ctxWatch);
    try { clearInterval(staleWatch); } catch {}
    try { clearInterval(hardGuard); } catch {}
    try {
      clearAll();                 // drop frozen rows so no stale "▶ …" lingers
      staleNeutral = true;
      ensureMounted();
      updateStatus();
    } catch {}
    setTimeout(() => { destroyHost(); }, 6000);
  }, 1500);

  // Allow a future re-injection to cleanly replace this instance.
  window.__fastlinkOverlayTeardown = () => {
    try { cancelDismiss(); } catch {}
    try { removePrewarmDot(); } catch {}
    try { clearInterval(ctxWatch); } catch {}
    try { clearInterval(staleWatch); } catch {}
    try { clearInterval(hardGuard); } catch {}
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
    try { window.removeEventListener('pagehide', onPageHide); } catch {}
    try { window.removeEventListener('pageshow', onPageShow); } catch {}
  };
})();
