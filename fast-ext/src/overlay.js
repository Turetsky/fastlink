// FastLink activity overlay — fixed top-right panel that shows each tool call
// as it runs. Always on, content script in ISOLATED world. Speed principle:
// every message arrives via fire-and-forget chrome.tabs.sendMessage from the
// background, so nothing here ever blocks the action path.

(() => {
  // Re-injection (e.g. background re-injecting after an extension reload) must
  // REBUILD, not no-op — the previous instance's chrome.runtime context is dead
  // and its onMessage listener can never fire again. Tear down the old host so
  // this fresh, live-context instance takes over.
  if (window.__fastlinkOverlayInstalled) {
    try { document.getElementById('__fastlink_overlay_host__')?.remove(); } catch {}
    try { window.__fastlinkOverlayTeardown?.(); } catch {}
  }
  window.__fastlinkOverlayInstalled = true;

  const HOST_ID = '__fastlink_overlay_host__';
  const MAX_ROWS = 8;
  const FADE_AFTER_MS = 4000;
  const REMOVE_AFTER_MS = 6000;
  // Tear the whole panel off the page this long after the LAST tool finishes
  // (no rows still running). The panel mounts lazily on the first tool, so this
  // gives it a symmetric lifecycle: appear on first tool, vanish after the last.
  const DISMISS_AFTER_MS = 5000;

  let host = null;
  let shadow = null;
  let listEl = null;
  let statusEl = null;
  let hdrDot = null;
  let dismissTimer = null;
  const rows = new Map(); // id -> { rowEl, args, label, timers }

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

  const ensureMounted = () => {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;top:12px;right:12px;z-index:2147483647;pointer-events:none;';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host, * { box-sizing:border-box; }
      .panel {
        font:12px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
        color:#e7e9ee;
        background:rgba(20,22,28,0.72);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border:1px solid rgba(255,255,255,0.08);
        border-radius:10px;
        box-shadow:0 8px 24px rgba(0,0,0,0.35);
        padding:8px 10px;
        min-width:240px;
        max-width:360px;
        pointer-events:auto;
      }
      .hdr { display:flex; align-items:center; gap:6px; margin-bottom:6px; opacity:0.92; }
      .dot { width:8px; height:8px; border-radius:50%; background:#5cc8ff; box-shadow:0 0 6px #5cc8ff; flex:none; }
      .dot.run  { background:#5cc8ff; box-shadow:0 0 6px #5cc8ff; animation:flpulse 1s ease-in-out infinite; }
      .dot.idle { background:#6dd58c; box-shadow:0 0 6px #6dd58c; animation:none; }
      @keyframes flpulse { 0%,100%{opacity:1;} 50%{opacity:0.25;} }
      .ttl { font-weight:600; letter-spacing:0.2px; }
      .status {
        display:flex; align-items:center; gap:4px;
        margin-bottom:6px; padding:3px 6px; border-radius:6px;
        font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        background:rgba(255,255,255,0.05); color:#9aa3b2;
      }
      .status.working { color:#bcd4ff; background:rgba(92,200,255,0.12); }
      .status.done    { color:#6dd58c; background:rgba(109,213,140,0.12); }
      .list { display:flex; flex-direction:column; gap:4px; max-height:60vh; overflow:hidden; }
      .row {
        display:flex; align-items:baseline; gap:6px;
        padding:4px 6px; border-radius:6px;
        background:rgba(255,255,255,0.04);
        transition:opacity 600ms ease;
        opacity:1;
      }
      .row.fade { opacity:0.35; }
      .row.run  { box-shadow: inset 2px 0 0 #5cc8ff; }
      .row.ok   { box-shadow: inset 2px 0 0 #6dd58c; }
      .row.err  { box-shadow: inset 2px 0 0 #ff6b6b; }
      .tool { color:#c8d2ff; font-weight:600; white-space:nowrap; }
      .meta { color:#9aa3b2; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .ms   { color:#7d8696; font-variant-numeric:tabular-nums; }
      .empty { color:#7d8696; font-style:italic; padding:2px 6px; }
    `;
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `<div class="hdr"><span class="dot"></span><span class="ttl">Claude is driving this tab</span></div><div class="status"></div><div class="list"></div>`;
    shadow.appendChild(style);
    shadow.appendChild(panel);
    listEl = panel.querySelector('.list');
    statusEl = panel.querySelector('.status');
    hdrDot = panel.querySelector('.dot');
    document.documentElement.appendChild(host);
    updateStatus();
  };

  // Reflect live driving state in the header so a user glancing over from the
  // claude.ai tab instantly sees what's happening — and, crucially, when it's
  // DONE. Three states: working (an action is mid-flight), done/idle (Claude
  // finished, nothing running), and connected (panel up, nothing yet).
  const updateStatus = () => {
    if (!statusEl) return;
    let running = null;
    for (const e of rows.values()) if (e.rowEl.classList.contains('run')) running = e;
    if (running) {
      statusEl.textContent = '▶ ' + running.label;
      statusEl.className = 'status working';
      if (hdrDot) hdrDot.className = 'dot run';
    } else if (rows.size) {
      statusEl.textContent = '✓ Done — idle';
      statusEl.className = 'status done';
      if (hdrDot) hdrDot.className = 'dot idle';
    } else {
      statusEl.textContent = 'Connected — waiting for Claude';
      statusEl.className = 'status';
      if (hdrDot) hdrDot.className = 'dot idle';
    }
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

  // Remove the entire overlay host (header dot + list) and reset state so the
  // NEXT tool run re-mounts a fresh panel via ensureMounted.
  const scheduleDismiss = () => {
    cancelDismiss();
    dismissTimer = setTimeout(() => {
      dismissTimer = null;
      clearAll();
      try { host?.remove(); } catch {}
      host = shadow = listEl = null;
    }, DISMISS_AFTER_MS);
  };

  const onMessage = (msg) => {
    if (!msg || msg.fastlink !== 'event') return;
    if (msg.phase === 'start') ensureRow(msg.id, msg.action, msg.args);
    else if (msg.phase === 'end') completeRow(msg.id, msg.ok, msg.error);
  };
  chrome.runtime.onMessage.addListener(onMessage);

  // Wipe every row and cancel its fade/remove timers. Used on page transitions
  // so nothing from a prior run survives.
  const clearAll = () => {
    for (const entry of rows.values()) {
      entry.timers.forEach(clearTimeout);
      try { entry.rowEl.remove(); } catch {}
    }
    rows.clear();
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

  // Self-heal: when the extension is reloaded, this content script is orphaned —
  // chrome.runtime.id starts throwing "Extension context invalidated" and no new
  // tool events can arrive. Detect that and show a one-time "reload tab" hint so
  // the panel never silently freezes on a stale row. Stop the watcher after.
  const ctxWatch = setInterval(() => {
    let alive = true;
    try { alive = !!chrome.runtime?.id; } catch { alive = false; }
    if (alive) return;
    clearInterval(ctxWatch);
    try {
      ensureMounted();
      const note = document.createElement('div');
      note.className = 'empty';
      note.textContent = '↻ extension reloaded — refresh this tab to resume';
      listEl.appendChild(note);
    } catch {}
  }, 1500);

  // Allow a future re-injection to cleanly replace this instance.
  window.__fastlinkOverlayTeardown = () => {
    try { cancelDismiss(); } catch {}
    try { clearInterval(ctxWatch); } catch {}
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
    try { window.removeEventListener('pagehide', onPageHide); } catch {}
    try { window.removeEventListener('pageshow', onPageShow); } catch {}
  };
})();
