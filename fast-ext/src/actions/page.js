// Lives in the target tab's MAIN world as a manifest content script
// (run_at: document_start). Self-attaches to window.__fastlink.run so the
// background can invoke it via a tiny 1-line bridge instead of re-serializing
// this whole file on every executeScript call.
//
// MUST stay self-contained — no imports, no closures from outside this file.

async function runPageAction(action, args) {
 try {
  const SELECTOR = 'a[href],button,input:not([type="hidden"]),select,textarea,[contenteditable="true"],[contenteditable=""],[role="button"],[role="link"],[role="checkbox"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="switch"],[role="option"],[role="radio"],[onclick],[tabindex]:not([tabindex="-1"])';

  const visible = (el, rect) => {
    if (rect.width < 2 || rect.height < 2) return false;
    const cs = getComputedStyle(el);
    return !(cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0');
  };

  // Walk the composed tree (shadow roots + same-origin iframes), invoking
  // `visit(el, offset)` for every element matching `selector`. Offset is the
  // delta from the outer page to the element's local viewport — non-zero only
  // for elements inside iframes. One walker for all snapshot/select/diagnose
  // needs; iframe + shadow handling stays consistent.
  const walkDeep = (root, selector, visit) => {
    const walk = (r, ox, oy) => {
      if (!r || !r.querySelectorAll) return;
      let matches, all;
      try { matches = r.querySelectorAll(selector); all = r.querySelectorAll('*'); }
      catch { return; }
      for (const el of matches) {
        try { visit(el, { ox, oy, inFrame: ox !== 0 || oy !== 0 }); } catch {}
      }
      for (const el of all) {
        try {
          if (el.shadowRoot) walk(el.shadowRoot, ox, oy);
          if (el.tagName === 'IFRAME') {
            let doc = null;
            try { doc = el.contentDocument; } catch { /* cross-origin */ }
            if (!doc) continue;
            let fr;
            try { fr = el.getBoundingClientRect(); } catch { continue; }
            walk(doc, ox + fr.x, oy + fr.y);
          }
        } catch { /* one weird element shouldn't kill the whole walk */ }
      }
    };
    walk(root, 0, 0);
  };

  // Collects interactive candidates with their iframe offsets.
  const candidates = (root) => {
    const elements = [];
    const offsets = new WeakMap();
    walkDeep(root, SELECTOR, (el, off) => { offsets.set(el, off); elements.push(el); });
    return { elements, offsets };
  };

  const lookupId = (el, id) => {
    let r = el.getRootNode && el.getRootNode();
    while (r) {
      if (r.getElementById) {
        const f = r.getElementById(id);
        if (f) return f;
      }
      // Climb out of shadow roots into the host's tree.
      r = r.host ? r.host.getRootNode() : null;
    }
    return document.getElementById(id);
  };

  const resolveIdRefs = (el, attr) => {
    const v = el.getAttribute && el.getAttribute(attr);
    if (!v) return null;
    const parts = [];
    for (const id of v.split(/\s+/).filter(Boolean)) {
      const ref = lookupId(el, id);
      if (ref) parts.push((ref.innerText || ref.textContent || '').trim());
    }
    const joined = parts.filter(Boolean).join(' ').trim();
    return joined || null;
  };

  // Implicit ARIA role per HTML-AAM. Lets role:"link" match a plain <a href>
  // and role:"button" match <button> without callers needing an explicit
  // role attribute on the element.
  const implicitRoleOf = (tag, type) => {
    if (tag === 'a')        return 'link';
    if (tag === 'button')   return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select')   return 'combobox';
    if (tag === 'option')   return 'option';
    if (tag === 'input') {
      const t = (type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio')    return 'radio';
      if (t === 'search')   return 'searchbox';
      return 'textbox';
    }
    return null;
  };

  const labelFor = (el) => {
    if (el.id) {
      const escId = CSS.escape(el.id);
      const root = el.getRootNode && el.getRootNode();
      const lbl = (root && root.querySelector && root.querySelector(`label[for="${escId}"]`))
                || document.querySelector(`label[for="${escId}"]`);
      if (lbl) return (lbl.innerText || '').trim();
    }
    let p = el.parentElement;
    while (p) {
      if (p.tagName === 'LABEL') {
        const t = (p.innerText || '').trim();
        return t.replace((el.value || ''), '').trim();
      }
      p = p.parentElement;
    }
    return resolveIdRefs(el, 'aria-labelledby');
  };

  // Direct element references by item.i — survives across iframe boundaries
  // where coordinate-based lookup (elementFromPoint) would just return the iframe.
  const elementsById = new Map();

  const buildSnapshot = () => {
    elementsById.clear();
    const out = [];
    let id = 0;
    const { elements, offsets } = candidates(document);
    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      if (!visible(el, rect)) continue;
      const off = offsets.get(el) || { ox: 0, oy: 0, inFrame: false };
      const lbl = labelFor(el);
      const innerText = (el.innerText || '').trim().slice(0, 120);
      const titleAttr = el.getAttribute('title') || null;
      const describedBy = resolveIdRefs(el, 'aria-describedby');
      const text = (innerText || el.value || el.getAttribute('aria-label') || lbl || el.getAttribute('placeholder') || titleAttr || '').trim().slice(0, 120);
      elementsById.set(id, el);
      out.push({
        i: id++,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || null,
        text,
        innerText: innerText || null,
        label: lbl || null,
        href: el.tagName === 'A' ? el.href : null,
        placeholder: el.getAttribute('placeholder') || null,
        ariaLabel: el.getAttribute('aria-label') || null,
        describedBy: describedBy ? describedBy.slice(0, 120) : null,
        title: titleAttr,
        type: el.getAttribute('type') || null,
        name: el.getAttribute('name') || null,
        x: Math.round(rect.x + off.ox), y: Math.round(rect.y + off.oy),
        w: Math.round(rect.width), h: Math.round(rect.height),
        inFrame: off.inFrame || undefined,
      });
    }
    return { url: location.href, title: document.title, count: out.length, items: out };
  };

  // Rank match sources: visible content > form labels > name/value > aria-label > title (tooltip).
  // This prefers actual buttons/links/menuitems over tooltip-only or screen-reader-only elements
  // that happen to share the query text.
  const matchScore = (it, t) => {
    const inT = (s) => s && s.toLowerCase().includes(t);
    let score = 0;
    if (inT(it.innerText))   score = Math.max(score, 4);
    if (inT(it.label))       score = Math.max(score, 3);
    if (inT(it.placeholder)) score = Math.max(score, 3);
    if (inT(it.name))        score = Math.max(score, 2);
    if (inT(it.ariaLabel))   score = Math.max(score, 1);
    if (inT(it.title))       score = Math.max(score, 0.5);
    if (score === 0 && inT(it.text)) score = 0.25;
    return score;
  };

  const matchItems = (items, text) => {
    const t = (text || '').toLowerCase();
    if (!t) return [];
    const scored = [];
    for (const it of items) {
      const s = matchScore(it, t);
      if (s > 0) scored.push({ it, s });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.map(x => x.it);
  };

  // Prefer the cached element ref (works across iframes/shadow); fall back to
  // hit-testing for stale items whose `i` isn't in the current snapshot.
  const elAt = (it) => elementsById.get(it.i) || document.elementFromPoint(it.x + it.w / 2, it.y + it.h / 2);

  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // Quick visual flash on the targeted element. Runs in same MAIN-world
  // injection as the action — no extra script round-trip. Restores prior
  // outline asynchronously after ~700ms; the action proceeds immediately.
  const flashEl = (el, label) => {
    try {
      if (!el || !el.style) return;
      const prev = { outline: el.style.outline, outlineOffset: el.style.outlineOffset, boxShadow: el.style.boxShadow };
      el.style.outline = '2px solid #5cc8ff';
      el.style.outlineOffset = '2px';
      el.style.boxShadow = '0 0 0 4px rgba(92,200,255,0.25)';
      let tagEl = null;
      try {
        const r = el.getBoundingClientRect();
        tagEl = document.createElement('div');
        tagEl.textContent = label || '';
        tagEl.style.cssText = `position:fixed;left:${Math.max(0,r.x)}px;top:${Math.max(0,r.y-18)}px;background:#5cc8ff;color:#0b0d12;font:11px/1 -apple-system,BlinkMacSystemFont,sans-serif;font-weight:600;padding:2px 5px;border-radius:4px;z-index:2147483647;pointer-events:none;`;
        document.documentElement.appendChild(tagEl);
      } catch {}
      setTimeout(() => {
        try { el.style.outline = prev.outline; el.style.outlineOffset = prev.outlineOffset; el.style.boxShadow = prev.boxShadow; } catch {}
        if (tagEl) try { tagEl.remove(); } catch {}
      }, 700);
    } catch {}
  };

  // Shared form-fill helpers — used by fast_fill and fast_fill_form.
  const isFillable = (it) => {
    if (it.tag === 'input' || it.tag === 'textarea') return true;
    const el = elAt(it);
    return el ? (el.isContentEditable || el.getAttribute('role') === 'textbox') : false;
  };
  const fieldMatchesText = (it, m) =>
    (it.placeholder && it.placeholder.toLowerCase().includes(m)) ||
    (it.label       && it.label.toLowerCase().includes(m)) ||
    (it.ariaLabel   && it.ariaLabel.toLowerCase().includes(m)) ||
    (it.name        && it.name.toLowerCase().includes(m)) ||
    (it.text        && it.text.toLowerCase().includes(m));
  const fillItem = (found, value, append) => {
    const el = elAt(found);
    if (!el) return { error: 'no element' };
    flashEl(el, 'fill');
    el.focus();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, append ? (el.value + value) : value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.innerText = append ? (el.innerText + value) : value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }
    return { filled: { tag: found.tag, label: found.label, placeholder: found.placeholder, name: found.name }, valueSet: value };
  };

  // exact > startsWith > substring
  const pickByText = (items, getText, query) => {
    const lo = query.toLowerCase();
    return items.find(o => getText(o) === lo)
        || items.find(o => getText(o).startsWith(lo))
        || items.find(o => getText(o).includes(lo));
  };

  if (action === 'fast_snapshot') {
    const snap = buildSnapshot();
    if (args.viewport) {
      const vh = window.innerHeight, vw = window.innerWidth;
      snap.items = snap.items.filter(it => it.y + it.h > 0 && it.y < vh && it.x + it.w > 0 && it.x < vw);
      snap.count = snap.items.length;
    }
    return snap;
  }

  if (action === 'fast_wait') {
    const t = (args.text || '').toLowerCase();
    // networkIdle mode is intercepted before injection, so here `text` is required.
    if (!t) return { error: 'fast_wait needs either text or networkIdle:true' };
    const deadline = Date.now() + (args.timeoutMs || 5000);
    return new Promise((resolve) => {
      const poll = () => {
        const found = buildSnapshot().items.find(it => it.text && it.text.toLowerCase().includes(t));
        if (found) return resolve({ found });
        if (Date.now() > deadline) return resolve({ error: `Timed out waiting for "${args.text}"` });
        setTimeout(poll, 150);
      };
      poll();
    });
  }

  if (action === 'fast_select_option') {
    const fieldQ = (args.field || '').toLowerCase();
    const optionText = String(args.option || '');
    if (!fieldQ || !optionText) return { error: 'field and option required' };

    // Shadow-DOM + iframe-aware querySelectorAll, via the shared deep walker.
    const queryAllDeep = (root, selector) => {
      const out = [];
      walkDeep(root, selector, (el) => out.push(el));
      return out;
    };

    const findField = () => {
      // 1. Explicit name / id wins.
      const escName = CSS.escape(args.field);
      const byName = queryAllDeep(document, `[name="${escName}" i]`)[0];
      if (byName) return byName;
      const byId = lookupId(document.documentElement, args.field);
      if (byId) return byId;

      // 2. Resolve labels via labelFor (handles <label for>, ancestor LABEL,
      //    and aria-labelledby across shadow boundaries).
      const fieldish = 'input,select,textarea,[role="combobox"],[role="listbox"],[role="textbox"],[role="searchbox"],[contenteditable="true"],[contenteditable=""],[aria-labelledby],[aria-label],[placeholder]';
      const candidatesAll = queryAllDeep(document, fieldish);
      for (const el of candidatesAll) {
        const lbl = labelFor(el);
        if (lbl && lbl.toLowerCase().includes(fieldQ)) return el;
      }
      for (const el of candidatesAll) {
        const al = el.getAttribute && el.getAttribute('aria-label');
        if (al && al.toLowerCase().includes(fieldQ)) return el;
      }
      for (const el of candidatesAll) {
        const ph = el.getAttribute && el.getAttribute('placeholder');
        if (ph && ph.toLowerCase().includes(fieldQ)) return el;
      }
      return null;
    };

    const field = findField();
    if (!field) return { error: `field "${args.field}" not found` };
    const optText = (o) => (o.innerText || o.textContent || '').trim().toLowerCase();

    if (field.tagName === 'SELECT') {
      const all = Array.from(field.options);
      const target = pickByText(all, o => (o.text || '').trim().toLowerCase(), optionText)
                  || all.find(o => (o.value || '').toLowerCase() === optionText.toLowerCase());
      if (!target) return { error: 'option not found in <select>', available: all.map(o => o.text) };
      field.value = target.value;
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return { picked: target.text, kind: 'native-select' };
    }

    const ctrl = field.closest('.react-select__control');
    if (ctrl) {
      if (!ctrl.classList.contains('react-select__control--menu-is-open')) ctrl.click();
      await wait(250);
      const input = ctrl.querySelector('input[id^="react-select-"]') || (field.tagName === 'INPUT' ? field : null);
      if (input) {
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, optionText);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(400);
      }
      const listboxId = input?.id ? input.id.replace('-input', '-listbox') : null;
      const listbox = (listboxId && document.getElementById(listboxId)) || document.querySelector('[role="listbox"]');
      const opts = listbox ? Array.from(listbox.querySelectorAll('[id*="-option-"], [role="option"]')) : [];
      const target = pickByText(opts, optText, optionText);
      if (!target) {
        return { error: 'no matching option in react-select', tried: optionText, available: opts.slice(0, 10).map(o => (o.innerText || '').trim()) };
      }
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      target.click();
      await wait(250);
      return { picked: (target.innerText || '').trim(), kind: 'react-select' };
    }

    field.focus();
    field.click();
    await wait(350);
    const listbox = queryAllDeep(document, '[role="listbox"]:not([hidden])')[0]
                 || queryAllDeep(document, '[role="menu"]:not([hidden])')[0]
                 || queryAllDeep(document, '[role="listbox"]')[0]
                 || queryAllDeep(document, '[role="menu"]')[0];
    if (listbox) {
      const opts = queryAllDeep(listbox, '[role="option"], [role="menuitem"], mat-option, [id*="-option-"]');
      const target = pickByText(opts, optText, optionText);
      if (target) {
        target.click();
        await wait(250);
        return { picked: (target.innerText || '').trim(), kind: 'aria-listbox' };
      }
      return { error: 'no matching option in listbox', available: opts.slice(0, 10).map(o => (o.innerText || '').trim()) };
    }

    return { error: 'unknown dropdown type, no strategy matched. Try fast_evaluate for full control.' };
  }

  if (action === 'fast_hover') {
    const snap = buildSnapshot();
    const matches = matchItems(snap.items, args.text);
    if (matches.length === 0) return { error: `No element matching "${args.text}"`, diagnostics: diagnoseNoMatch(args.text) };
    const idx = typeof args.index === 'number' ? args.index : 0;
    if (idx >= matches.length) return { error: `Only ${matches.length} matches for "${args.text}", index ${idx} out of range` };
    const item = matches[idx];
    const el = elAt(item);
    if (!el) return { error: 'Element not at expected coords' };
    // Bring off-viewport elements into view so the dispatched mouseover hits a
    // place where tooltip libraries actually fire — matches fast_click's
    // behavior, which works regardless because el.click() ignores viewport.
    let r = el.getBoundingClientRect();
    const vh = window.innerHeight, vw = window.innerWidth;
    const offViewport = r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw;
    if (offViewport) {
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
      await wait(60);
      r = el.getBoundingClientRect();
    }
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    flashEl(el, 'hover');
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mouseenter', opts));
    el.dispatchEvent(new MouseEvent('mousemove', opts));
    return { hovered: { tag: item.tag, text: item.text, x: Math.round(x), y: Math.round(y), scrolledIntoView: offViewport, totalMatches: matches.length, index: idx } };
  }

  if (action === 'fast_drag') {
    const snap = buildSnapshot();
    const fromMatches = matchItems(snap.items, args.from);
    if (fromMatches.length === 0) return { error: `No "from" element matching "${args.from}"` };
    const fromIdx = typeof args.fromIndex === 'number' ? args.fromIndex : 0;
    const fromItem = fromMatches[fromIdx];
    if (!fromItem) return { error: `Only ${fromMatches.length} from-matches for "${args.from}", index ${fromIdx} out of range` };
    const fromEl = elAt(fromItem);
    if (!fromEl) return { error: 'From element not at expected coords' };
    const fr = fromEl.getBoundingClientRect();
    const fx = fr.x + fr.width / 2, fy = fr.y + fr.height / 2;
    let tx, ty, toLabel = null;
    if (typeof args.toX === 'number' && typeof args.toY === 'number') {
      tx = args.toX; ty = args.toY; toLabel = `(${tx},${ty})`;
    } else if (args.to) {
      const toMatches = matchItems(snap.items, args.to);
      if (toMatches.length === 0) return { error: `No "to" element matching "${args.to}"` };
      const toIdx = typeof args.toIndex === 'number' ? args.toIndex : 0;
      const toItem = toMatches[toIdx];
      if (!toItem) return { error: `Only ${toMatches.length} to-matches for "${args.to}", index ${toIdx} out of range` };
      const toEl = elAt(toItem);
      if (!toEl) return { error: 'To element not at expected coords' };
      const tr = toEl.getBoundingClientRect();
      tx = tr.x + tr.width / 2; ty = tr.y + tr.height / 2;
      toLabel = toItem.text;
    } else {
      return { error: 'Pass either to (text match) or toX+toY (coordinates)' };
    }
    const fire = (target, type, x, y) => target.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1,
    }));
    fire(fromEl, 'mousedown', fx, fy);
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const x = fx + (tx - fx) * (i / steps);
      const y = fy + (ty - fy) * (i / steps);
      fire(document.elementFromPoint(x, y) || document.body, 'mousemove', x, y);
    }
    fire(document.elementFromPoint(tx, ty) || document.body, 'mouseup', tx, ty);
    return { dragged: { from: fromItem.text, to: toLabel, fromXY: [Math.round(fx), Math.round(fy)], toXY: [Math.round(tx), Math.round(ty)] } };
  }

  // Diagnostic for "why didn't this match?" — runs only on a 0-match miss.
  const diagnoseNoMatch = (queryText) => {
    const q = (queryText || '').toLowerCase();
    if (!q) return ['empty text query'];
    const out = [];

    // Walk + bucket hits in one pass — avoids materializing a full-DOM array.
    const hidden = [], nonInteractive = [], ariaHiddenHits = [], offScreen = [];
    let interactiveHits = 0;
    walkDeep(document, '*', (el) => {
      const txt = (
        (el.innerText || '') + ' ' +
        (el.value || '') + ' ' +
        (el.getAttribute?.('aria-label') || '') + ' ' +
        (el.getAttribute?.('placeholder') || '') + ' ' +
        (el.getAttribute?.('title') || '')
      ).toLowerCase();
      if (!txt.includes(q)) return;
      const cs = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
      const rect = el.getBoundingClientRect?.();
      const tag = el.tagName.toLowerCase();
      const isHidden = cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0');
      const isAriaHidden = el.closest?.('[aria-hidden="true"]') != null;
      const isInteractive = el.matches?.(SELECTOR);
      const isOffScreen = rect && (rect.width < 2 || rect.height < 2);
      if (isHidden) hidden.push(tag);
      else if (isAriaHidden) ariaHiddenHits.push(tag);
      else if (isInteractive && isOffScreen) offScreen.push(tag);
      else if (!isInteractive) nonInteractive.push(tag);
      else interactiveHits++;
    });

    // Count cross-origin iframes — these are invisible to us and could hold the element.
    let crossOrigin = 0;
    for (const f of document.querySelectorAll('iframe')) {
      try { if (!f.contentDocument) crossOrigin++; } catch { crossOrigin++; }
    }

    const totalHits = hidden.length + nonInteractive.length + ariaHiddenHits.length + offScreen.length + interactiveHits;
    if (totalHits === 0) {
      out.push(`Text "${queryText}" not found in document, open shadow DOM, or same-origin iframes.`);
      if (crossOrigin > 0) out.push(`Page has ${crossOrigin} cross-origin iframe(s) — content there is not inspectable; the element may live inside.`);
    } else {
      if (interactiveHits > 0) out.push(`${interactiveHits} interactive match(es) exist but were skipped — the snapshot already includes them, so this is unexpected. Try increasing window size or scroll first.`);
      if (hidden.length) {
        const tags = [...new Set(hidden)].slice(0, 4).join(', ');
        out.push(`${hidden.length} match(es) hidden via display:none / visibility:hidden / opacity:0 (${tags}). A parent likely needs to be opened first — dropdown, accordion, or modal.`);
      }
      if (ariaHiddenHits.length) {
        out.push(`${ariaHiddenHits.length} match(es) sit under aria-hidden="true" — usually behind an active modal/overlay.`);
      }
      if (offScreen.length) {
        out.push(`${offScreen.length} interactive match(es) have 0×0 / off-screen bounds. Try fast_scroll to bring them into view.`);
      }
      if (nonInteractive.length) {
        const tags = [...new Set(nonInteractive)].slice(0, 4).join(', ');
        out.push(`${nonInteractive.length} non-interactive match(es) (${tags}) — fast_click only fires on buttons/links/inputs/[role]/[onclick]/etc. Use fast_evaluate to dispatch a click on a plain element if needed.`);
      }
    }
    return out;
  };

  if (action === 'fast_click') {
    const snap = buildSnapshot();
    const preFilter = matchItems(snap.items, args.text);
    let matches = preFilter;
    if (args.role) {
      const wantRole = String(args.role).toLowerCase();
      matches = matches.filter(m => {
        const explicit = (m.role || '').toLowerCase();
        if (explicit === wantRole) return true;
        return implicitRoleOf(m.tag, m.type) === wantRole;
      });
    }
    if (args.tag) {
      const wantTag = String(args.tag).toLowerCase();
      matches = matches.filter(m => m.tag === wantTag);
    }
    if (matches.length === 0) {
      // Filter (role/tag) killed all hits — explain which qualifier disqualified them.
      if (preFilter.length > 0) {
        const qual = [];
        if (args.role) qual.push(`role="${args.role}"`);
        if (args.tag) qual.push(`tag="${args.tag}"`);
        return {
          error: `Found ${preFilter.length} match(es) for "${args.text}" but none satisfied ${qual.join(' and ')}.`,
          available: preFilter.slice(0, 8).map(m => ({ tag: m.tag, role: m.role, text: m.text, label: m.label })),
        };
      }
      return {
        error: `No element matching "${args.text}"`,
        diagnostics: diagnoseNoMatch(args.text),
      };
    }
    const idx = typeof args.index === 'number' ? args.index : 0;
    if (idx >= matches.length) {
      return { error: `Only ${matches.length} matches for "${args.text}", index ${idx} out of range`, matches: matches.map(m => ({ tag: m.tag, role: m.role, text: m.text, label: m.label })) };
    }
    const item = matches[idx];
    const el = elAt(item);
    if (!el) return { error: 'Element not at expected coords' };
    const willNavigate = el.tagName === 'A' && el.href && el.target !== '_blank' &&
      !el.href.startsWith('javascript:') && el.href !== location.href + '#';
    flashEl(el, 'click');
    el.click();
    return { clicked: item, willNavigate, totalMatches: matches.length, index: idx };
  }

  if (action === 'fast_scroll') {
    const isScrollableBox = (el) => {
      if (!el?.getBoundingClientRect) return false;
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      return /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY);
    };
    const findScroller = () => {
      if (args.selector) {
        const el = document.querySelector(args.selector);
        if (!el) return { error: `selector "${args.selector}" not found` };
        return { el, kind: 'selector' };
      }
      let el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      while (el && el !== document.body && el !== document.documentElement) {
        if (isScrollableBox(el)) return { el, kind: 'ancestor' };
        el = el.parentElement;
      }
      let best = null, bestArea = 0;
      for (const e of document.querySelectorAll('main, main *, [role="main"], [role="main"] *, body > *, body > * *')) {
        if (!isScrollableBox(e)) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 100 || r.height < 100) continue;
        const area = r.width * r.height;
        if (area > bestArea) { best = e; bestArea = area; }
      }
      if (best) return { el: best, kind: 'largest' };
      return { el: document.scrollingElement || document.documentElement, kind: 'document' };
    };
    const found = findScroller();
    if (found.error) return found;
    const target = found.el;
    const isDoc = target === document.scrollingElement || target === document.documentElement || target === document.body;
    const max = target.scrollHeight - target.clientHeight;
    let dest;
    if (args.to === 'top') dest = 0;
    else if (args.to === 'bottom') dest = max;
    else if (typeof args.to === 'string' && args.to.endsWith('%')) dest = max * (parseFloat(args.to) / 100);
    else if (typeof args.pixels === 'number') dest = (isDoc ? window.scrollY : target.scrollTop) + args.pixels;
    else return { error: 'Pass either to (top|bottom|"50%") or pixels (number), optional selector to target a specific scroller' };
    if (isDoc) window.scrollTo({ top: dest, behavior: 'instant' });
    else target.scrollTop = dest;
    const desc = target.tagName.toLowerCase()
      + (target.id ? `#${target.id}` : '')
      + (target.className && typeof target.className === 'string' ? '.' + target.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
    return { scrolled: true, scrollTop: isDoc ? window.scrollY : target.scrollTop, max, kind: found.kind, target: desc };
  }

  if (action === 'fast_network_replay') {
    const url = args.url;
    if (!url) return { error: 'url required' };
    const method = (args.method || 'GET').toUpperCase();
    const maxBytes = typeof args.maxBodyBytes === 'number' && args.maxBodyBytes > 0 ? args.maxBodyBytes : 16384;
    const startedAt = Date.now();
    try {
      const init = { method, credentials: 'include' };
      if (args.headers && typeof args.headers === 'object') init.headers = args.headers;
      if (args.body != null && method !== 'GET' && method !== 'HEAD') init.body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
      const resp = await fetch(url, init);
      const respHeaders = {};
      try { for (const [k, v] of resp.headers.entries()) respHeaders[k] = v; } catch {}
      let body = null;
      try { body = await resp.text(); } catch {}
      const truncated = body != null && body.length > maxBytes;
      return {
        url, method, status: resp.status, ok: resp.ok,
        durationMs: Date.now() - startedAt,
        headers: respHeaders,
        body: body == null ? null : (truncated ? body.slice(0, maxBytes) : body),
        bodyTruncated: truncated,
        bodyFullLength: body?.length || 0,
      };
    } catch (e) {
      return { error: String(e?.message || e), url, method, durationMs: Date.now() - startedAt };
    }
  }

  if (action === 'fast_fill') {
    const m = (args.match || '').toLowerCase();
    const found = buildSnapshot().items.find(it => isFillable(it) && fieldMatchesText(it, m));
    if (!found) return { error: `No fillable element matching "${args.match}"` };
    return fillItem(found, args.value, args.append);
  }

  if (action === 'fast_fill_form') {
    const fields = (args.fields && typeof args.fields === 'object') ? args.fields : null;
    if (!fields) return { error: 'fields object required, e.g. { email: "...", phone: "...", country: "US" }' };
    const append = !!args.append;
    const stopOnError = !!args.stopOnError;
    const items = buildSnapshot().items;
    const usedI = new Set();
    const results = {};
    let filled = 0, missed = 0;
    for (const [match, value] of Object.entries(fields)) {
      if (value == null) { results[match] = { error: 'value is null' }; missed++; continue; }
      const m = String(match).toLowerCase();
      const found = items.find(it => !usedI.has(it.i) && isFillable(it) && fieldMatchesText(it, m));
      if (!found) { results[match] = { error: 'not found' }; missed++; if (stopOnError) break; continue; }
      usedI.add(found.i);
      const r = fillItem(found, String(value), append);
      results[match] = r;
      if (r.error) { missed++; if (stopOnError) break; }
      else filled++;
    }
    return { filled, missed, total: Object.keys(fields).length, results };
  }

  return { error: `Unknown action: ${action}` };
 } catch (e) {
  return { error: 'page action threw: ' + (e?.stack || e?.message || String(e)).slice(0, 600) };
 }
}

// Self-install. The background's bridge calls window.__fastlink.run(action, args).
if (typeof window !== 'undefined') {
  window.__fastlink = window.__fastlink || {};
  window.__fastlink.run = runPageAction;
}
