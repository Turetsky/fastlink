// FastLink claude.ai transcript scraper.
//
// WHY THIS EXISTS: the cloud relay carries only tool CALLS / RESULTS, never
// Claude's chat prose. So the only place "what Claude is saying" lives is the
// DOM of the claude.ai tab itself. This content script (ISOLATED world, matched
// to https://claude.ai/*) watches that DOM and ships the latest assistant turn
// to the background, which fans it out to the side panel + the active-tab
// overlay. It NEVER drives the page — read-only.
//
// RESILIENCE: claude.ai is React with hashed/obfuscated class names, so we anchor
// on stable-ish signals (data-* attributes, ARIA, role) with layered fallbacks
// and degrade to {available:false} rather than throwing. A layout change should
// surface a graceful "transcript unavailable" message, never a broken script.

(() => {
  // Re-injection guard. A content script can be evaluated twice (extension
  // reload / SPA quirks); the previous instance's runtime context is dead, so
  // tear it down and let this live one take over.
  if (window.__fastlinkScrapeInstalled) {
    try { window.__fastlinkScrapeTeardown?.(); } catch {}
  }
  window.__fastlinkScrapeInstalled = true;

  const DEBOUNCE_MS = 400;   // coalesce streaming mutations (~300-500ms target)
  const MAX_TEXT    = 4000;  // cap payload so a long answer never bloats messages

  const MAX_LINES   = 40;    // cap structured lines so a huge turn never bloats messages
  const MAX_LINE    = 320;   // per-line char cap

  let debounceTimer = null;
  let lastSig = '';          // last (text|activity|available) signature sent — dedupe

  // Task D (best-effort): live refs to the real Allow/Deny buttons in claude.ai's
  // permission dialog, captured by detectPermission() so a respond message can
  // click them. Cleared whenever no prompt is detected.
  let permButtons = { allow: null, deny: null };

  // Relay-driving gate. The transcript must surface ONLY while claude.ai-web (the
  // cloud relay) is actively driving this browser — not when idle or when only the
  // local broker drives. Background is the authoritative gate, but we also suppress
  // sends here when known-inactive (cheaper) and force a fresh push when it resumes.
  // Default false until background answers the gate-query below, so we don't leak
  // scraped text before we know the relay is driving.
  let relayActive = false;

  // ---- DOM anchoring -------------------------------------------------------
  // Find the LATEST assistant message element. We try several anchors in order
  // of reliability and take the LAST match in document order (newest turn).
  // Returns an Element or null.
  function findLatestAssistant() {
    const tryLast = (sel) => {
      let els;
      try { els = document.querySelectorAll(sel); } catch { return null; }
      return els && els.length ? els[els.length - 1] : null;
    };

    // 1. The streaming message wrapper — claude.ai marks the in-progress (and
    //    most-recent) assistant message with data-is-streaming. Most reliable
    //    anchor while Claude is actively typing.
    let el = tryLast('[data-is-streaming]');
    if (el) return el;

    // 2. The assistant message body. Historically `.font-claude-message`; also
    //    accept testid-based content anchors. Class names can churn, hence the
    //    union and the fallbacks below.
    el = tryLast('.font-claude-message')
      || tryLast('[data-testid="message-content"]')
      || tryLast('[data-testid*="assistant" i]');
    if (el) return el;

    // 3. Role/aria fallback: some builds tag turns with role="article" or a
    //    data-test-render-count on each message block. Take the last one that
    //    is NOT obviously the user's own message.
    const blocks = document.querySelectorAll('[data-test-render-count], [role="article"]');
    if (blocks && blocks.length) {
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        const human = b.querySelector('[data-testid="user-message"]')
          || b.matches?.('[data-testid="user-message"]');
        if (!human) return b;
      }
      return blocks[blocks.length - 1];
    }

    return null;
  }

  // Locate the conversation container at all — used to decide available:false.
  function conversationPresent() {
    return !!(
      document.querySelector('[data-is-streaming]')
      || document.querySelector('.font-claude-message')
      || document.querySelector('[data-testid="message-content"]')
      || document.querySelector('[data-test-render-count]')
      || document.querySelector('main [role="article"]')
    );
  }

  // ---- tool-use / activity extraction --------------------------------------
  // Best-effort: surface any "tool" chip / running indicator inside the latest
  // assistant turn. claude.ai renders tool invocations as small interactive
  // widgets; we sniff a few likely anchors and the streaming flag. Returns a
  // short human string or null.
  function extractToolActivity(scope) {
    const root = scope || document;
    // Streaming flag = Claude is mid-response.
    let streaming = false;
    try {
      const s = document.querySelector('[data-is-streaming="true"]');
      streaming = !!s;
    } catch {}

    let chip = null;
    const chipSels = [
      '[data-testid*="tool" i]',
      'button[aria-label*="tool" i]',
      '[class*="tool" i][class*="use" i]',
      '[data-testid*="artifact" i]',
    ];
    for (const sel of chipSels) {
      let nodes;
      try { nodes = root.querySelectorAll(sel); } catch { continue; }
      if (nodes && nodes.length) {
        const t = (nodes[nodes.length - 1].textContent || '').trim();
        if (t) { chip = t.slice(0, 80); break; }
      }
    }

    if (chip) return streaming ? `${chip} (running)` : chip;
    if (streaming) return 'responding…';
    return null;
  }

  // ---- structured segmentation ---------------------------------------------
  // Turn the latest assistant turn's flat innerText into readable UNITS instead
  // of one blob: split on blank lines, classify each as prose / bullet / tool, and
  // surface the CURRENT action (the tool chip). The side panel + overlay render
  // this; the raw `text` is still sent for back-compat with the stored shape.
  function classifyLine(s, chip) {
    if (/^\s*[-*•]\s+/.test(s)) return 'bullet';
    if (/^\s*\d+[.)]\s+/.test(s)) return 'bullet';
    if (/\bfast_[a-z][a-z_]*/.test(s)) return 'tool';          // a tool name appears inline
    if (chip && s.length <= 90 && s.includes(chip)) return 'tool';
    return 'prose';
  }
  function buildStructured(el, chip) {
    let lines = [];
    try {
      const raw = (el.innerText || el.textContent || '');
      const segs = raw.split(/\n+/).map((s) => s.replace(/\s+$/, '').trim()).filter(Boolean);
      for (let s of segs) {
        if (s.length > MAX_LINE) s = s.slice(0, MAX_LINE) + '…';
        const kind = classifyLine(s, chip);
        // Strip the leading list marker for bullets — the renderers add their own
        // bullet glyph, so keeping "- " / "1. " would double it up.
        const text = kind === 'bullet' ? s.replace(/^\s*([-*•]|\d+[.)])\s+/, '') : s;
        lines.push({ kind, text });
      }
      if (lines.length > MAX_LINES) lines = lines.slice(lines.length - MAX_LINES);
    } catch { lines = []; }
    // currentAction: the most recent tool/step the surfaces highlight in mono.
    let currentAction = null;
    if (chip) currentAction = chip.replace(/\s*\(running\)\s*$/i, '').slice(0, 80) || null;
    return { lines, currentAction };
  }

  // ---- tool-permission prompt detection (Task D — BEST-EFFORT) --------------
  // claude.ai shows an Allow/Decline dialog when Claude wants to use the FastLink
  // (MCP) tools. We can't assume exact markup, so we sniff defensively by button
  // text inside a dialog-ish container and capture live refs to the real buttons.
  // If nothing matches we return {present:false} and never throw — the surfaces
  // then show nothing extra. If we find the dialog but not both buttons, we still
  // report present:true so the user is told to approve it in claude.ai directly.
  function detectPermission() {
    permButtons = { allow: null, deny: null };
    try {
      // Prefer an explicit dialog; fall back to scanning the whole document.
      const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
      const scopes = dialogs.length ? Array.from(dialogs) : [document];

      for (const scope of scopes) {
        const txt = (scope.textContent || '').toLowerCase();
        // Heuristic relevance: the dialog mentions permission/tool/connector use,
        // OR (whole-document fallback) we just look for an Allow+Deny button pair.
        const looksPermission = /\b(allow|permission|use this tool|use the tool|connector|wants to use|approve)\b/.test(txt);
        let allow = null, deny = null;
        let btns;
        try { btns = scope.querySelectorAll('button, [role="button"]'); } catch { btns = []; }
        for (const b of btns) {
          const t = (b.textContent || '').trim().toLowerCase();
          if (!t || t.length > 40) continue;
          if (!allow && /^(allow|approve|accept|always allow|allow (once|always|for))/.test(t)) allow = b;
          if (!deny  && /^(deny|decline|reject|cancel|don.?t allow|no,? thanks)/.test(t)) deny = b;
        }
        const inDialog = scope !== document;
        if ((inDialog && looksPermission && (allow || deny)) || (allow && deny)) {
          permButtons = { allow, deny };
          return {
            present: true,
            allowText: allow ? (allow.textContent || '').trim().slice(0, 30) : null,
            denyText:  deny  ? (deny.textContent  || '').trim().slice(0, 30) : null,
            // If we couldn't grab the real buttons, the surfaces still show the
            // prompt but tell the user to approve it inside claude.ai.
            actionable: !!(allow || deny),
          };
        }
      }
    } catch { /* fail closed: no prompt surfaced */ }
    return { present: false };
  }

  // ---- collect + send ------------------------------------------------------
  function collectAndSend() {
    if (!relayActive) return;   // gate: don't surface scraped text unless the relay is driving
    // Permission detection runs regardless of whether a turn is present — the
    // prompt can appear before/around any assistant text. Best-effort + never throws.
    let permission = null;
    try { const p = detectPermission(); if (p && p.present) permission = p; } catch {}

    let payload;
    try {
      if (!conversationPresent()) {
        payload = { available: false, ts: Date.now() };
      } else {
        const el = findLatestAssistant();
        if (!el) {
          payload = { available: false, ts: Date.now() };
        } else {
          let text = (el.innerText || el.textContent || '').replace(/\s+\n/g, '\n').trim();
          if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '…';
          const toolActivity = extractToolActivity(el);
          payload = {
            available: true,
            text,
            structured: buildStructured(el, toolActivity),
            toolActivity,
            ts: Date.now(),
          };
        }
      }
    } catch {
      payload = { available: false, ts: Date.now() };
    }
    payload.permission = permission;

    // Dedupe identical consecutive states (ts excluded from the signature).
    const permSig = permission ? `P:${permission.actionable ? 1 : 0}|${permission.allowText || ''}|${permission.denyText || ''}` : '';
    const sig = `${payload.available ? 1 : 0}|${payload.text || ''}|${payload.toolActivity || ''}|${permSig}`;
    if (sig === lastSig) return;
    lastSig = sig;

    try {
      chrome.runtime.sendMessage(
        { type: 'fastlink:transcript', ...payload },
        () => void chrome.runtime.lastError,
      );
    } catch {
      // Extension context invalidated (reload) — stop observing.
      teardown();
    }
  }

  function schedule() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(collectAndSend, DEBOUNCE_MS);
  }

  // ---- observe -------------------------------------------------------------
  // Observe the whole document subtree (the conversation root mounts late and
  // re-mounts on navigation between chats); a debounce keeps it cheap.
  const observer = new MutationObserver(schedule);
  function startObserving() {
    try {
      observer.observe(document.documentElement || document.body, {
        childList: true, subtree: true, characterData: true,
      });
    } catch {}
  }

  // ---- relay-driving gate wiring -------------------------------------------
  // Listen for the background's gate broadcasts; when the relay STARTS driving,
  // reset the dedupe signature and re-scrape so the current turn surfaces
  // immediately (the DOM may be static, so a mutation-driven send isn't coming).
  const onGate = (msg) => {
    if (!msg) return;
    if (msg.fastlink === 'relay-active') {
      const was = relayActive;
      relayActive = !!msg.active;
      if (relayActive && !was) { lastSig = ''; schedule(); }
      return;
    }
    // Task D (best-effort): user clicked Allow/Deny in the overlay/side panel.
    // Click the corresponding real button in claude.ai's permission dialog. If we
    // never captured it (markup changed), this no-ops — we never throw.
    if (msg.fastlink === 'permission-respond') {
      try {
        const btn = msg.decision === 'deny' ? permButtons.deny : permButtons.allow;
        if (btn && typeof btn.click === 'function') btn.click();
      } catch {}
      // Re-scrape so the (now dismissed) prompt clears from the surfaces.
      lastSig = ''; schedule();
      return;
    }
  };
  try { chrome.runtime.onMessage.addListener(onGate); } catch {}

  // Ask the background for the current gate on load (default stays false until
  // it answers, so no text leaks before we know the relay is driving).
  function queryGate() {
    try {
      chrome.runtime.sendMessage({ type: 'fastlink:gate-query' }, (resp) => {
        void chrome.runtime.lastError;
        const was = relayActive;
        relayActive = !!(resp && resp.active);
        if (relayActive && !was) { lastSig = ''; schedule(); }
      });
    } catch {}
  }

  // SPA route changes (switching chats) don't always trigger DOM churn at the
  // observed root; hook history + popstate to re-read.
  const onNav = () => schedule();
  let _push = null, _replace = null;
  try {
    _push = history.pushState;
    _replace = history.replaceState;
    history.pushState = function (...a) { const r = _push.apply(this, a); onNav(); return r; };
    history.replaceState = function (...a) { const r = _replace.apply(this, a); onNav(); return r; };
    window.addEventListener('popstate', onNav);
  } catch {}

  function teardown() {
    try { observer.disconnect(); } catch {}
    try { if (debounceTimer) clearTimeout(debounceTimer); } catch {}
    try { chrome.runtime.onMessage.removeListener(onGate); } catch {}
    try { window.removeEventListener('popstate', onNav); } catch {}
    try { if (_push) history.pushState = _push; } catch {}
    try { if (_replace) history.replaceState = _replace; } catch {}
    window.__fastlinkScrapeInstalled = false;
  }
  window.__fastlinkScrapeTeardown = teardown;

  // Kick off once the DOM is ready enough to query. queryGate() seeds relayActive
  // from the background; collectAndSend no-ops until it (or a gate broadcast)
  // turns the gate on, so the observer can run harmlessly in the meantime.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { startObserving(); queryGate(); schedule(); }, { once: true });
  } else {
    startObserving();
    queryGate();
    schedule();
  }
})();
