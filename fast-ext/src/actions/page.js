// Lives in the target tab's MAIN world as a manifest content script
// (run_at: document_start). Self-attaches to window.__fastlink.run so the
// background can invoke it via a tiny 1-line bridge instead of re-serializing
// this whole file on every executeScript call.
//
// MUST stay self-contained — no imports, no closures from outside this file.
//
// Architecture:
//   • Persistent in-page INDEX (Map<Element, Entry>) built once on first
//     page-action invocation. Initial walk is chunked via requestIdleCallback
//     so it doesn't block paint.
//   • A MutationObserver keeps the index current as the page changes. Per-
//     mutation work is tiny — one element re-classified, no full walk.
//   • fast_snapshot serializes the index. Reads getBoundingClientRect in one
//     tight loop (single layout pass per snapshot) instead of scanning the
//     entire DOM. Typically <20ms even on huge SPAs.

// ───────────────────────────── module helpers ─────────────────────────────

const SELECTOR = 'a[href],button,input:not([type="hidden"]),select,textarea,[contenteditable="true"],[contenteditable=""],[role="button"],[role="link"],[role="checkbox"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="switch"],[role="option"],[role="radio"],[onclick],[tabindex]:not([tabindex="-1"])';

const SKIP_SUBTREE = new Set([
  'script','style','noscript','template','head','title','meta','link','svg',
]);

// Hard cap on index size. Interactive elements are always indexed; only NEW
// non-interactive 'content' entries are dropped once this is hit. Stops a
// churning SPA (GCP) from growing the index without bound — which is what blew
// the serialize loop and wedged the renderer.
const MAX_INDEX = 10000;

const visible = (el, rect) => {
  if (rect.width < 2 || rect.height < 2) return false;
  const cs = getComputedStyle(el);
  return !(cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0');
};

const lookupId = (el, id) => {
  let r = el.getRootNode && el.getRootNode();
  while (r) {
    if (r.getElementById) {
      const f = r.getElementById(id);
      if (f) return f;
    }
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
    if (ref) parts.push((ref.textContent || '').trim());
  }
  const joined = parts.filter(Boolean).join(' ').trim();
  return joined || null;
};

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
    if (lbl) return (lbl.textContent || '').trim();
  }
  let p = el.parentElement;
  while (p) {
    if (p.tagName === 'LABEL') {
      const t = (p.textContent || '').trim();
      return t.replace((el.value || ''), '').trim();
    }
    p = p.parentElement;
  }
  return resolveIdRefs(el, 'aria-labelledby');
};

// Walks the composed tree (shadow roots + same-origin iframes). Generic
// version used by diagnose / select_option. Indexing has its own walker.
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
          try { doc = el.contentDocument; } catch {}
          if (!doc) continue;
          let fr;
          try { fr = el.getBoundingClientRect(); } catch { continue; }
          walk(doc, ox + fr.x, oy + fr.y);
        }
      } catch {}
    }
  };
  walk(root, 0, 0);
};

// Compute the offset of `el` relative to the outer-page viewport, accounting
// for nested same-origin iframes. Shadow roots don't add offset.
const offsetFor = (el) => {
  let ox = 0, oy = 0, inFrame = false;
  try {
    let win = el.ownerDocument && el.ownerDocument.defaultView;
    while (win && win !== window && win.frameElement) {
      const fr = win.frameElement.getBoundingClientRect();
      ox += fr.x; oy += fr.y;
      inFrame = true;
      win = win.parent === win ? null : win.parent;
    }
  } catch {}
  return { ox, oy, inFrame };
};

// ─────────────────────────────── the index ───────────────────────────────

// One persistent index per page. Survives runPageAction invocations.
const INDEX = (typeof window !== 'undefined' && window.__fastlinkIndex)
  ? window.__fastlinkIndex
  : {
      byEl: new Map(),  // Element → Entry
      byId: new Map(),  // number  → Element
      // Side set of "option-like" elements (role=option/menuitem/mat-option).
      // Lets fast_select_option's poll loop iterate ~tens of items instead
      // of the whole index. Maintained in lockstep with byEl by indexElement
      // / unindexElement so the option lookup is always a Set scan.
      options: new Set(),
      nextId: 0,
      ready: false,
      initStarted: false,
      observer: null,
      // Dynamic/self-limiting state (so the content script is never a
      // background parasite on heavy SPAs like GCP):
      lastActivityMs: 0,   // last time a tool call touched this page
      suspended: false,    // observer currently disconnected (idle or storm)
      stormTripped: false,  // breaker fired: page re-renders too hot to watch
      mutWindowStart: 0,    // mutation-rate sampling window start
      mutCount: 0,         // mutations seen in the current window
    };
if (typeof window !== 'undefined') window.__fastlinkIndex = INDEX;

// Decide if an entry should also live in the options side-set.
const isOptionEntry = (entry) => {
  if (!entry || entry.kind !== 'click') return false;
  if (entry.tag === 'mat-option') return true;
  const role = (entry.role || '').toLowerCase();
  return role === 'option' || role === 'menuitem' || role === 'menuitemcheckbox' || role === 'menuitemradio';
};

// Collapse a string that is just the same unit repeated 2–4× with no
// separator — the tripled-innerText artifact on custom elements / web
// components (LWC LIGHTNING-BUTTON-STATEFUL renders the label in several
// stacked state spans, so textContent = "FooFooFoo"). Scoped by the caller
// to custom/shadow hosts so plain text ("haha") is never touched. Cheap:
// only runs on short strings and bails on the first non-match.
const collapseRepeat = (s) => {
  const n = s.length;
  if (n < 4 || n > 400) return s;
  for (let k = 2; k <= 4; k++) {
    if (n % k !== 0) continue;
    const unit = s.slice(0, n / k);
    if (unit.length >= 2 && unit.repeat(k) === s) return unit;
  }
  return s;
};

// Build a click entry. Uses textContent (does NOT force layout) — that's
// critical for letting the MutationObserver re-index on every attribute
// change without thrashing layout. The minor accuracy loss vs innerText
// (no rendered-only-via-CSS text, no respect for display:none kids) is
// the right tradeoff for keeping the page responsive.
const makeClickEntry = (el) => {
  const lbl = labelFor(el);
  // Only de-dup on custom elements / shadow hosts — that's where the
  // host+slot+inner concatenation artifact occurs; normal elements are left
  // exactly as-is so we never mangle legitimately-repeating text.
  const rawText = (el.textContent || '').trim();
  const isCustom = (el.tagName && el.tagName.includes('-')) || !!el.shadowRoot;
  const innerText = (isCustom ? collapseRepeat(rawText) : rawText).slice(0, 120);
  const titleAttr = el.getAttribute('title') || null;
  const describedBy = resolveIdRefs(el, 'aria-describedby');
  const text = (innerText || el.value || el.getAttribute('aria-label') || lbl || el.getAttribute('placeholder') || titleAttr || '').trim().slice(0, 120);
  return {
    kind: 'click',
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
  };
};

const makeContentEntry = (el) => {
  const text = (el.textContent || '').trim();
  return {
    kind: 'content',
    tag: el.tagName.toLowerCase(),
    text: text.slice(0, 500),
  };
};

// Classify what an element should be in the index (or null = don't index).
//   click   → matches SELECTOR
//   content → has its own (non-descendant) text
//
// We INTENTIONALLY do NOT check `closest(SELECTOR)` here — on a deeply
// nested Angular/React tree, that selector eval against ~50 ancestors per
// element × thousands of elements adds up to seconds. Duplicate content
// inside clickables is caught later by the exact-text dedup in
// serializeSnapshot, so the only loss is content entries with text that
// DIFFERS from the wrapping clickable's text — those are useful to keep
// anyway (a button labeled "Submit" with inner "submits the form" hint).
const classifyElement = (el) => {
  if (!el || el.nodeType !== 1) return null;
  const tag = el.tagName.toLowerCase();
  if (SKIP_SUBTREE.has(tag)) return null;
  try { if (el.matches && el.matches(SELECTOR)) return 'click'; } catch {}
  for (const c of el.childNodes) {
    if (c.nodeType === 3 && c.textContent && c.textContent.trim()) return 'content';
  }
  return null;
};

// Add / update / remove an element in the index based on its current state.
// Stable id across re-classifications of the same element.
const indexElement = (el) => {
  const kind = classifyElement(el);
  const existing = INDEX.byEl.get(el);
  if (!kind) {
    if (existing) {
      INDEX.byEl.delete(el);
      INDEX.byId.delete(existing.id);
    }
    return;
  }
  if (existing && existing.kind === kind) {
    // Refresh fields while preserving id.
    const id = existing.id;
    Object.assign(existing, kind === 'click' ? makeClickEntry(el) : makeContentEntry(el));
    existing.id = id;
    if (isOptionEntry(existing)) INDEX.options.add(el); else INDEX.options.delete(el);
    return;
  }
  if (existing) { INDEX.byId.delete(existing.id); INDEX.options.delete(el); }
  // Cap the index so a churning SPA (GCP spawns tens of thousands of text-bearing
  // divs → 'content' entries) can't grow it without bound and blow the serialize
  // loop. Interactive ('click') entries are always allowed — they're what actions
  // target and are far fewer; only NEW 'content' entries are dropped once full.
  if (kind === 'content' && INDEX.byEl.size >= MAX_INDEX) return;
  const entry = kind === 'click' ? makeClickEntry(el) : makeContentEntry(el);
  entry.id = INDEX.nextId++;
  INDEX.byEl.set(el, entry);
  INDEX.byId.set(entry.id, el);
  if (isOptionEntry(entry)) INDEX.options.add(el);
};

const unindexElement = (el) => {
  const entry = INDEX.byEl.get(el);
  if (entry) {
    INDEX.byEl.delete(el);
    INDEX.byId.delete(entry.id);
    INDEX.options.delete(el);
  }
};

// Walk a subtree and apply `onEl` to every element (including shadow + iframe).
// Iterative to handle deeply-nested DOMs without blowing the JS stack.
const walkSubtree = (root, onEl) => {
  const stack = [root];
  while (stack.length) {
    const el = stack.pop();
    if (!el || el.nodeType !== 1) continue;
    const tag = el.tagName.toLowerCase();
    if (SKIP_SUBTREE.has(tag)) continue;
    onEl(el);
    if (el.children) for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i]);
    if (el.shadowRoot && el.shadowRoot.children) {
      for (let i = el.shadowRoot.children.length - 1; i >= 0; i--) stack.push(el.shadowRoot.children[i]);
    }
    if (tag === 'iframe') {
      let doc = null;
      try { doc = el.contentDocument; } catch {}
      if (doc) {
        const inner = doc.body || doc.documentElement;
        if (inner && inner.children) {
          for (let i = inner.children.length - 1; i >= 0; i--) stack.push(inner.children[i]);
        }
      }
    }
  }
};

// Initial population, chunked into ~500-element bites yielded via
// requestIdleCallback. Never blocks paint; finishes in the background.
const populateIndexAsync = () => {
  if (INDEX.initStarted) return;
  INDEX.initStarted = true;
  const stack = [];
  const root = document.body || document.documentElement;
  if (root) stack.push(root);
  const CHUNK = 500;
  const step = (deadline) => {
    let n = 0;
    while (stack.length && n < CHUNK && (!deadline || deadline.timeRemaining() > 1)) {
      const el = stack.pop();
      if (!el || el.nodeType !== 1) continue;
      const tag = el.tagName.toLowerCase();
      if (SKIP_SUBTREE.has(tag)) continue;
      indexElement(el);
      if (el.children) for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i]);
      if (el.shadowRoot && el.shadowRoot.children) {
        for (let i = el.shadowRoot.children.length - 1; i >= 0; i--) stack.push(el.shadowRoot.children[i]);
      }
      if (tag === 'iframe') {
        let doc = null;
        try { doc = el.contentDocument; } catch {}
        if (doc) {
          const inner = doc.body || doc.documentElement;
          if (inner && inner.children) {
            for (let i = inner.children.length - 1; i >= 0; i--) stack.push(inner.children[i]);
          }
        }
      }
      n++;
    }
    if (stack.length) {
      if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(step, { timeout: 200 });
      else setTimeout(() => step(null), 0);
    } else {
      INDEX.ready = true;
    }
  };
  // {timeout:200} so the initial walk completes even when Angular starves idle
  // time — otherwise INDEX.ready never flips and the index stays partial.
  if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(step, { timeout: 200 });
  else setTimeout(() => step(null), 0);
};

// Deferred observer. The MutationObserver callback itself does almost no
// work — just stuffs mutated nodes into pending sets. The actual re-indexing
// happens in requestIdleCallback time, so heavy mutation bursts (Cloud
// Console's Angular re-renders) don't block the page. Snapshot reads call
// drainPendingSync(budget) up front, so a moderate amount of fresh data is
// included in each snapshot without any "stale" surprises in normal flows.
const PENDING = INDEX._pending || (INDEX._pending = {
  adds: new Set(),
  removes: new Set(),
  reindex: new Set(),
  scheduled: false,
  // An in-progress, resumable subtree walk. A single huge re-render (one giant
  // added subtree) is processed across multiple slices via this cursor instead
  // of in one uninterruptible call, so the wall-clock cap below can't be blown
  // by a single op. Persisted on INDEX so it survives runPageAction calls.
  cursor: null,
});

const nowMs = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

// Pull the next unit of indexing work into a resumable cursor.
//   removes / adds → descend the whole subtree (a node was attached/detached).
//   reindex        → single element only (an attribute / text change); descend
//                    is false so we DON'T re-walk its subtree, matching the
//                    original behaviour where a reindex touched just that node.
const nextWork = () => {
  for (const el of PENDING.removes) { PENDING.removes.delete(el); return { stack: [el], onEl: unindexElement, descend: true }; }
  for (const el of PENDING.adds)    { PENDING.adds.delete(el);    return { stack: [el], onEl: indexElement,   descend: true }; }
  for (const el of PENDING.reindex) { PENDING.reindex.delete(el); return { stack: [el], onEl: indexElement,   descend: false }; }
  return null;
};

// Process exactly ONE element off the cursor's stack. Keeping the unit of work
// at element granularity is what lets the time cap be honoured mid-subtree.
const stepCursor = (cur) => {
  const el = cur.stack.pop();
  if (!el || el.nodeType !== 1) return;
  const tag = el.tagName.toLowerCase();
  if (SKIP_SUBTREE.has(tag)) return;
  try { cur.onEl(el); } catch {}
  if (!cur.descend) return;
  if (el.children) for (let i = el.children.length - 1; i >= 0; i--) cur.stack.push(el.children[i]);
  if (el.shadowRoot && el.shadowRoot.children) {
    for (let i = el.shadowRoot.children.length - 1; i >= 0; i--) cur.stack.push(el.shadowRoot.children[i]);
  }
  if (tag === 'iframe') {
    let doc = null;
    try { doc = el.contentDocument; } catch {}
    if (doc) {
      const inner = doc.body || doc.documentElement;
      if (inner && inner.children) {
        for (let i = inner.children.length - 1; i >= 0; i--) cur.stack.push(inner.children[i]);
      }
    }
  }
};

const hasPending = () =>
  PENDING.adds.size > 0 || PENDING.removes.size > 0 || PENDING.reindex.size > 0 ||
  !!(PENDING.cursor && PENDING.cursor.stack.length);

// Run up to `budget` element-steps, stopping early when `overBudget()` is true.
// Shared by the synchronous snapshot-time drain and the idle-time drain.
const drainSteps = (budget, overBudget) => {
  let n = 0;
  while (n < budget) {
    if (!(PENDING.cursor && PENDING.cursor.stack.length)) {
      PENDING.cursor = nextWork();
      if (!PENDING.cursor) return;
    }
    stepCursor(PENDING.cursor);
    if (!PENDING.cursor.stack.length) PENDING.cursor = null;
    n++;
    if (overBudget && overBudget()) return;
  }
};

// Drain up to `budget` element-steps synchronously, bailing after `timeBudgetMs`
// of wall clock. The time check is now per-ELEMENT (not per-subtree), so one
// giant re-render can no longer monopolise a snapshot — its walk is spread
// across slices via PENDING.cursor and finished on idle.
const drainPendingSync = (budget, timeBudgetMs) => {
  const start = nowMs();
  drainSteps(budget, () => timeBudgetMs && (nowMs() - start) > timeBudgetMs);
};

const scheduleDrain = () => {
  if (PENDING.scheduled || !hasPending()) return;
  PENDING.scheduled = true;
  const step = (deadline) => {
    PENDING.scheduled = false;
    drainSteps(200, () => deadline && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() < 1);
    if (hasPending()) scheduleDrain();
  };
  // {timeout:200} is critical: on a busy Angular SPA (GCP) the main thread is
  // never idle, so a bare requestIdleCallback may NEVER fire — the drain then
  // never runs and the PENDING sets grow without bound (pinning detached nodes)
  // until the renderer OOMs. The timeout forces the drain to run regardless.
  if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(step, { timeout: 200 });
  else setTimeout(() => step(null), 0);
};

// Self-limiting MutationObserver. Two protections so this is never a background
// parasite on heavy SPAs (the bug that wedged GCP):
//   • STORM BREAKER — if mutations exceed STORM_RATE in a sampling window, the
//     observer DISCONNECTS and sets stormTripped. The page is telling us it
//     re-renders too hot to track live; we get out of the way and rebuild the
//     index on demand (serializeSnapshot drains pending / re-walks as needed).
//   • IDLE SUSPEND — checked at snapshot time: if no tool call for IDLE_MS, the
//     observer disconnects until the next tool call re-arms it (armObserver).
const STORM_WINDOW_MS = 1000;
const STORM_RATE = 1500;   // mutations/sec above which we stop watching live
const IDLE_MS = 15000;     // disconnect the observer after this much inactivity

const disconnectObserver = (reason) => {
  if (INDEX.observer) { try { INDEX.observer.disconnect(); } catch {} INDEX.observer = null; }
  INDEX.suspended = true;
  if (reason === 'storm') INDEX.stormTripped = true;
};

const setupObserver = () => {
  if (INDEX.observer || typeof MutationObserver === 'undefined') return;
  try {
    const obs = new MutationObserver((muts) => {
      // Storm sampling: count mutations per window; trip the breaker if too hot.
      const t = nowMs();
      if (t - INDEX.mutWindowStart > STORM_WINDOW_MS) { INDEX.mutWindowStart = t; INDEX.mutCount = 0; }
      INDEX.mutCount += muts.length;
      if (INDEX.mutCount > STORM_RATE) { disconnectObserver('storm'); return; }
      // Backstop the rate breaker: a SUSTAINED sub-threshold mutation rate
      // (~500-1400/s on GCP, under STORM_RATE) never trips the spike detector,
      // but if the drain can't keep up the PENDING sets grow without bound and
      // OOM the renderer. Cap total backlog → trip the breaker and let snapshots
      // rebuild on demand instead.
      if (PENDING.adds.size + PENDING.reindex.size + PENDING.removes.size > 20000) {
        disconnectObserver('storm'); return;
      }

      for (const m of muts) {
        if (m.type === 'childList') {
          for (const node of m.removedNodes) if (node.nodeType === 1) PENDING.removes.add(node);
          for (const node of m.addedNodes)   if (node.nodeType === 1) PENDING.adds.add(node);
        } else if (m.type === 'characterData') {
          const p = m.target.parentElement;
          if (p) PENDING.reindex.add(p);
        } else if (m.type === 'attributes' && m.target && m.target.nodeType === 1) {
          PENDING.reindex.add(m.target);
        }
      }
      scheduleDrain();
    });
    // Narrow config = the browser builds far smaller MutationRecord batches.
    // Dropped characterData (fired on every text re-render) and the `value`
    // attribute (fires per keystroke) — the two biggest record generators on
    // Angular. Content-entry text staleness is fine; it's refreshed by the
    // snapshot-time drain / detached cleanup. This is PREVENTIVE (fewer records
    // ever made), complementing the reactive storm breaker.
    obs.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'role','aria-label','aria-labelledby','href','contenteditable','tabindex','type','placeholder',
      ],
    });
    INDEX.observer = obs;
    INDEX.suspended = false;
    INDEX.mutWindowStart = nowMs();
    INDEX.mutCount = 0;
  } catch {}
};

// Re-arm the observer on a tool call (after idle-suspend or a storm trip). On a
// storm-tripped page we stay disconnected and rely on on-demand index rebuilds
// in serializeSnapshot — re-attaching would just re-trip. Idle-suspend re-arms
// freely. Always stamps activity so idle-suspend measures from the last call.
const armObserver = () => {
  INDEX.lastActivityMs = nowMs();
  if (INDEX.stormTripped) return;        // stay out of the way on hot pages
  if (!INDEX.observer) setupObserver();
};

// Called at snapshot time: if FastLink has been idle, disconnect the observer
// so an unused-but-live tab carries no background watcher.
const maybeIdleSuspend = () => {
  if (INDEX.observer && INDEX.lastActivityMs && (nowMs() - INDEX.lastActivityMs) > IDLE_MS) {
    disconnectObserver('idle');
  }
};

// Kick off init. Called on every runPageAction but no-op after the first.
// Observer is enabled with a deferred drain queue (PENDING + scheduleDrain
// above) so heavy mutation bursts don't block the page.
const initIndex = () => {
  if (INDEX.initStarted) return;
  const start = () => { populateIndexAsync(); setupObserver(); };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
};

// Known transient-popover / portal containers. Radix, react-select, MUI,
// Angular cdk-overlay, and any [role=menu]/[role=listbox] mount their items
// into a PORTAL (usually end of <body>), and/or animate open — so a snapshot
// taken at the wrong instant misses the very items the agent needs to click.
const OVERLAY_CONTAINERS =
  '[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper],' +
  '.cdk-overlay-container,[class*="react-select__menu"],' +
  '[class*="MuiPopover"],[class*="MuiMenu"]';

// Find every interactive element living inside an open overlay container,
// across the composed tree (shadow roots + same-origin iframes). Force-indexes
// each so it gets a stable id and is clickable/markable even if the
// MutationObserver hasn't drained the portal's added nodes yet (beats the
// open-animation race). Returns a Set<Element> for inOverlay tagging.
const collectOverlayEls = () => {
  const set = new Set();
  walkDeep(document, OVERLAY_CONTAINERS, (container) => {
    try { walkDeep(container, SELECTOR, (el) => set.add(el)); } catch {}
  });
  for (const el of set) { try { indexElement(el); } catch {} }
  return set;
};

// Read the index → snapshot payload. Single layout pass for all rect reads.
// Cleans up entries whose elements have been detached (defense in depth;
// MutationObserver usually catches removals first).
const serializeSnapshot = (viewportOnly, opts) => {
  // ALWAYS bound the serialize. Previously budgetMs was undefined on the
  // pre-action matching snapshots (serializeSnapshot(false) in fast_click/fill/
  // etc.), so the per-element time guard below was dead code and the loop walked
  // the ENTIRE index — tens of thousands of nodes on a heavy SPA like GCP — until
  // the 30s broker timeout wedged the renderer. Default to a hard budget so a
  // match snapshot can never hang the page.
  const budgetMs = (opts && opts.budgetMs) || 2500;
  const drainMs = (opts && opts.drainMs) || 40;
  const startMs = nowMs();
  // Disconnect the observer if FastLink has gone idle (no background watcher on
  // an unused tab).
  maybeIdleSuspend();
  // On a storm-tripped page the observer is OFF, so the index isn't being kept
  // live by mutations. Re-walk the DOM on demand here (bounded) so this snapshot
  // still reflects current state — this is the "rebuild on demand instead of
  // watch forever" path. The walk is queued and drained under the same budget.
  if (INDEX.stormTripped) {
    // Re-seed a full-DOM walk ONLY when the previous one has fully drained —
    // do NOT null the cursor, which threw away the in-progress walk every call
    // so each snapshot restarted DFS from <body> and only ever re-indexed the
    // same first ~2000 nodes (deep GCP elements never got indexed). Letting the
    // resumable cursor finish converges the index across snapshots.
    const root = document.body || document.documentElement;
    if (root && !hasPending()) PENDING.adds.add(root);
  }
  // Drain a chunk of pending mutations synchronously so post-click /
  // post-nav snapshots reflect the dropdown / modal that just appeared.
  // Bounded by both op count AND wall-clock time so a giant listbox
  // expansion can't hang the snapshot.
  drainPendingSync(2000, drainMs);
  // Opt-in overlay/portal sweep: directly scan known popover containers and
  // force-index their interactive items so currently-open Radix/MUI/react-select
  // menus and [role=menu/listbox] panes are included even when the index race
  // would otherwise miss them. Default snapshots skip this entirely.
  let overlayEls = null;
  if (opts && opts.overlay) {
    try { overlayEls = collectOverlayEls(); } catch { overlayEls = null; }
  }
  const items = [];
  const content = [];
  let timedOut = false;
  let seen = 0;
  const vh = window.innerHeight, vw = window.innerWidth;
  const detached = [];
  for (const [el, entry] of INDEX.byEl) {
    // Per-element wall-clock guard (checked every 256 items to stay cheap): a
    // successful action must never hang on serialization — bail with a
    // partial-but-rich snapshot flagged snapshotTimedOut instead of letting the
    // whole call hit the broker timeout.
    if (budgetMs && ((++seen & 63) === 0) && (nowMs() - startMs) > budgetMs) { timedOut = true; break; }
    if (!el.isConnected) { detached.push(el); continue; }
    let rect;
    try { rect = el.getBoundingClientRect(); } catch { continue; }
    if (!visible(el, rect)) continue;
    const isOverlayEl = overlayEls && overlayEls.has(el);
    if (viewportOnly && !isOverlayEl && (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw)) continue;
    const off = offsetFor(el);
    const x = Math.round(rect.x + off.ox);
    const y = Math.round(rect.y + off.oy);
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (entry.kind === 'click') {
      items.push({
        i: entry.id, tag: entry.tag, role: entry.role,
        text: entry.text, innerText: entry.innerText, label: entry.label,
        href: entry.href, placeholder: entry.placeholder, ariaLabel: entry.ariaLabel,
        describedBy: entry.describedBy, title: entry.title, type: entry.type, name: entry.name,
        x, y, w, h, inFrame: off.inFrame || undefined,
        inOverlay: (overlayEls && overlayEls.has(el)) || undefined,
      });
    } else {
      content.push({ tag: entry.tag, text: entry.text, x, y, w, h, inFrame: off.inFrame || undefined });
    }
  }
  for (const el of detached) unindexElement(el);
  // Exact-text dedup: drop content blocks whose text matches a click item.
  if (content.length) {
    const clickTexts = new Set();
    for (const it of items) if (it.text) clickTexts.add(it.text);
    for (let i = content.length - 1; i >= 0; i--) {
      if (clickTexts.has(content[i].text)) content.splice(i, 1);
    }
  }
  return {
    url: location.href, title: document.title,
    count: items.length, items,
    contentCount: content.length, content,
    indexing: !INDEX.ready || undefined,
    snapshotTimedOut: timedOut || undefined,
  };
};

// Look up an element by snapshot id. Stable for the page's lifetime.
const elById = (id) => INDEX.byId.get(id);

// ──────────────────────────── action dispatch ────────────────────────────

async function runPageAction(action, args) {
 try {
  initIndex();
  // Re-arm the observer (after idle-suspend / build it lazily on first call)
  // and stamp activity so idle-suspend measures from this call.
  armObserver();

  // Match-ranking & helpers used by multiple actions.
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
  const elAt = (it) => elById(it.i) || document.elementFromPoint(it.x + it.w / 2, it.y + it.h / 2);
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // Auto-attach a fresh viewport snapshot to action returns so callers don't
  // have to follow every fast_click / fast_fill / etc. with a separate
  // fast_snapshot. Yields one requestAnimationFrame so click handlers, Angular
  // zones, React effects, etc. have a chance to mutate before we serialize.
  // Opt-out per call with args.noSnapshot. Skipped on error returns and when
  // an action already returns its own snapshot.
  const withSnap = async (result) => {
    if (!result || typeof result !== 'object') return result;
    if (result.error || result.snapshot || args.noSnapshot) return result;
    await new Promise(r => (typeof requestAnimationFrame === 'function')
      ? requestAnimationFrame(r)
      : setTimeout(r, 0));
    // The auto-snapshot is a convenience, never the point of the call. Bound it
    // and swallow failures so a slow/huge serialize can NEVER turn a successful
    // action into a broker timeout. On overrun the action result is returned
    // with whatever partial snapshot was gathered + snapshotTimedOut:true, so
    // the agent still has rich text to act on instead of reaching for a
    // screenshot.
    try {
      const snap = serializeSnapshot(true, { budgetMs: 4000, drainMs: 40 });
      result.snapshot = snap;
      if (snap && snap.snapshotTimedOut) result.snapshotTimedOut = true;
    } catch (e) {
      result.snapshot = null;
      result.snapshotTimedOut = true;
    }
    return result;
  };

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
        // The chip is fixed-positioned on the outer document, so an iframe-local
        // rect needs the frame offset added to land in outer-page coords.
        const { ox, oy } = offsetFor(el);
        tagEl = document.createElement('div');
        tagEl.textContent = label || '';
        tagEl.style.cssText = `position:fixed;left:${Math.max(0,r.x+ox)}px;top:${Math.max(0,r.y+oy-18)}px;background:#5cc8ff;color:#0b0d12;font:11px/1 -apple-system,BlinkMacSystemFont,sans-serif;font-weight:600;padding:2px 5px;border-radius:4px;z-index:2147483647;pointer-events:none;`;
        document.documentElement.appendChild(tagEl);
      } catch {}
      setTimeout(() => {
        try { el.style.outline = prev.outline; el.style.outlineOffset = prev.outlineOffset; el.style.boxShadow = prev.boxShadow; } catch {}
        if (tagEl) try { tagEl.remove(); } catch {}
      }, 700);
    } catch {}
  };

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

  const pickByText = (items, getText, query) => {
    const lo = query.toLowerCase();
    return items.find(o => getText(o) === lo)
        || items.find(o => getText(o).startsWith(lo))
        || items.find(o => getText(o).includes(lo));
  };

  // Diagnostic for "why didn't this match?" — runs only on a 0-match miss.
  const diagnoseNoMatch = (queryText) => {
    const q = (queryText || '').toLowerCase();
    if (!q) return ['empty text query'];
    const out = [];
    const hidden = [], nonInteractive = [], ariaHiddenHits = [], offScreen = [];
    let interactiveHits = 0;
    walkDeep(document, '*', (el) => {
      const txt = (
        (el.textContent || '') + ' ' +
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

  if (action === 'fast_snapshot') {
    return serializeSnapshot(!!args.viewport, { overlay: !!args.overlay });
  }

  if (action === 'fast_wait') {
    const t = (args.text || '').toLowerCase();
    if (!t) return { error: 'fast_wait needs either text or networkIdle:true' };
    const deadline = Date.now() + (args.timeoutMs || 5000);
    // Cheap text-only scan over the index — no rect reads, no layout.
    // Only when we find a match do we serialize that ONE entry with
    // coords, so a polling fast_wait doesn't repeatedly force layout
    // on the whole page while it's still rendering.
    const findEntryByText = () => {
      for (const [el, entry] of INDEX.byEl) {
        if (entry.kind !== 'click') continue;
        if (entry.text && entry.text.toLowerCase().includes(t)) return el;
      }
      return null;
    };
    return new Promise((resolve) => {
      const poll = () => {
        drainPendingSync(500, 15);
        const el = findEntryByText();
        if (el && el.isConnected) {
          // Only now read rect/visibility for the matched element.
          let rect; try { rect = el.getBoundingClientRect(); } catch { rect = null; }
          if (rect && visible(el, rect)) {
            const entry = INDEX.byEl.get(el);
            const off = offsetFor(el);
            // Attach a post-wait snapshot (like fast_click/fast_fill) so the
            // agent can chain off the now-settled view without a second call.
            // withSnap is bounded + non-fatal and honors noSnapshot:true.
            return resolve(withSnap({ found: {
              i: entry.id, tag: entry.tag, role: entry.role,
              text: entry.text, label: entry.label, href: entry.href,
              ariaLabel: entry.ariaLabel,
              x: Math.round(rect.x + off.ox), y: Math.round(rect.y + off.oy),
              w: Math.round(rect.width), h: Math.round(rect.height),
            }}));
          }
        }
        if (Date.now() > deadline) {
          // Direct DOM read (no snapshot/INDEX): give the agent a peek at the
          // current view so it can tell it landed somewhere wrong.
          const headings = [];
          try {
            const hs = document.querySelectorAll('h1,h2,h3,[role="heading"]');
            for (const h of hs) {
              if (headings.length >= 6) break;
              let r; try { r = h.getBoundingClientRect(); } catch { r = null; }
              if (!r || !visible(h, r)) continue;
              const txt = (h.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
              if (txt) headings.push(txt);
            }
          } catch {}
          return resolve({ error: `Timed out waiting for "${args.text}"`, headings });
        }
        setTimeout(poll, 150);
      };
      poll();
    });
  }

  if (action === 'fast_select_option') {
    const fieldQ = (args.field || '').toLowerCase();
    const optionText = String(args.option || '');
    if (!fieldQ || !optionText) return { error: 'field and option required' };

    const queryAllDeep = (root, selector) => {
      const out = [];
      walkDeep(root, selector, (el) => out.push(el));
      return out;
    };

    const findField = () => {
      const escName = CSS.escape(args.field);
      const byName = queryAllDeep(document, `[name="${escName}" i]`)[0];
      if (byName) return byName;
      const byId = lookupId(document.documentElement, args.field);
      if (byId) return byId;
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
    const optText = (o) => (o.textContent || '').trim().toLowerCase();

    if (field.tagName === 'SELECT') {
      const all = Array.from(field.options);
      const target = pickByText(all, o => (o.text || '').trim().toLowerCase(), optionText)
                  || all.find(o => (o.value || '').toLowerCase() === optionText.toLowerCase());
      if (!target) return { error: 'option not found in <select>', available: all.map(o => o.text) };
      field.value = target.value;
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return withSnap({ picked: target.text, kind: 'native-select' });
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
        return { error: 'no matching option in react-select', tried: optionText, available: opts.slice(0, 10).map(o => (o.textContent || '').trim()) };
      }
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      target.click();
      await wait(250);
      return withSnap({ picked: (target.textContent || '').trim(), kind: 'react-select' });
    }

    // Generic ARIA listbox / menu. Index-driven: open the field, then poll
    // INDEX for option/menuitem entries matching the requested text. Much
    // faster than re-walking the document on every poll cycle.
    field.focus();
    field.click();
    const optTextLo = optionText.toLowerCase();
    // Scan the side-set of option-like entries — typically tens of elements,
    // not the whole INDEX. Maintained at index-time by isOptionEntry().
    const findOptInIndex = () => {
      let exact = null, starts = null, sub = null;
      for (const el of INDEX.options) {
        if (!el.isConnected) continue;
        const entry = INDEX.byEl.get(el);
        if (!entry) continue;
        const t = (entry.text || '').toLowerCase().trim();
        if (!t) continue;
        if (t === optTextLo)              { exact  = el; break; }
        if (!starts && t.startsWith(optTextLo)) starts = el;
        if (!sub    && t.includes(optTextLo))   sub   = el;
      }
      return exact || starts || sub;
    };
    const deadline = Date.now() + (args.timeoutMs || 3000);
    let target = null;
    while (Date.now() < deadline) {
      drainPendingSync(2000, 30);
      target = findOptInIndex();
      if (target) break;
      await wait(50);
    }
    if (target) {
      target.click();
      return withSnap({ picked: (target.textContent || '').trim(), kind: 'aria-listbox' });
    }
    // Build a small `available` list from the options side-set so Claude
    // has something to work with on a miss.
    const available = [];
    for (const el of INDEX.options) {
      if (!el.isConnected) continue;
      const entry = INDEX.byEl.get(el);
      if (entry) available.push((entry.text || '').trim());
      if (available.length >= 10) break;
    }
    return { error: 'no matching option in listbox / no listbox detected', tried: optionText, available };
  }

  if (action === 'fast_hover') {
    const snap = serializeSnapshot(false);
    const matches = matchItems(snap.items, args.text);
    if (matches.length === 0) return { error: `No element matching "${args.text}"`, diagnostics: diagnoseNoMatch(args.text) };
    const idx = typeof args.index === 'number' ? args.index : 0;
    if (idx >= matches.length) {
      return { error: `Only ${matches.length} matches for "${args.text}", index ${idx} out of range`, matches: matches.map(m => ({ tag: m.tag, role: m.role, text: m.text, label: m.label })) };
    }
    const item = matches[idx];
    const el = elAt(item);
    if (!el) return { error: 'Element not at expected coords' };
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
    return withSnap({ hovered: { tag: item.tag, text: item.text, x: Math.round(x), y: Math.round(y), scrolledIntoView: offViewport, totalMatches: matches.length, index: idx } });
  }

  if (action === 'fast_drag') {
    const snap = serializeSnapshot(false);
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
    return withSnap({ dragged: { from: fromItem.text, to: toLabel, fromXY: [Math.round(fx), Math.round(fy)], toXY: [Math.round(tx), Math.round(ty)] } });
  }

  if (action === 'fast_click') {
    const snap = serializeSnapshot(false);
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
      if (preFilter.length > 0) {
        const qual = [];
        if (args.role) qual.push(`role="${args.role}"`);
        if (args.tag) qual.push(`tag="${args.tag}"`);
        return {
          error: `Found ${preFilter.length} match(es) for "${args.text}" but none satisfied ${qual.join(' and ')}.`,
          available: preFilter.slice(0, 8).map(m => ({ tag: m.tag, role: m.role, text: m.text, label: m.label })),
        };
      }
      return { error: `No element matching "${args.text}"`, diagnostics: diagnoseNoMatch(args.text) };
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
    return withSnap({ clicked: item, willNavigate, totalMatches: matches.length, index: idx });
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
    return withSnap({ scrolled: true, scrollTop: isDoc ? window.scrollY : target.scrollTop, max, kind: found.kind, target: desc });
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
    const snap = serializeSnapshot(false);
    const found = snap.items.find(it => isFillable(it) && fieldMatchesText(it, m));
    if (!found) return { error: `No fillable element matching "${args.match}"` };
    return withSnap(fillItem(found, args.value, args.append));
  }

  if (action === 'fast_fill_form') {
    const fields = (args.fields && typeof args.fields === 'object') ? args.fields : null;
    if (!fields) return { error: 'fields object required, e.g. { email: "...", phone: "...", country: "US" }' };
    const append = !!args.append;
    const stopOnError = !!args.stopOnError;
    const verify = !!args.verify;
    const items = serializeSnapshot(false).items;
    const usedI = new Set();
    const results = {};
    let filled = 0, missed = 0;
    // Field is filled-but-not-visible if it has no offsetParent (display:none on
    // it or an ancestor, or detached) yet isn't disabled — such fields still
    // submit, so the agent should be warned the value went somewhere invisible.
    const isHidden = (el) => el != null && !el.disabled && el.offsetParent === null;
    const readValue = (el) => {
      if (!el) return null;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.value;
      return (el.isContentEditable || el.getAttribute('role') === 'textbox') ? el.innerText : el.value;
    };
    for (const [match, raw] of Object.entries(fields)) {
      // Each value may be a plain string, or an object form for disambiguation:
      // { value, name, index, exact }. value is required in the object form.
      const spec = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : { value: raw };
      const value = spec.value;
      if (value == null) { results[match] = { error: 'value is null' }; missed++; if (stopOnError) break; continue; }
      // Exact 'name' attribute match (case-insensitive) takes precedence over the
      // label/placeholder/aria/name substring match used for plain string fields.
      const exactName = (spec.name != null) ? String(spec.name).toLowerCase()
        : (spec.exact ? String(match).toLowerCase() : null);
      const m = String(match).toLowerCase();
      const matches = items.filter(it => !usedI.has(it.i) && isFillable(it) && (
        exactName != null ? (it.name && it.name.toLowerCase() === exactName)
                          : fieldMatchesText(it, m)));
      // occurrence index picks the N-th candidate when labels/names collide.
      const idx = (typeof spec.index === 'number' && spec.index >= 0) ? spec.index : 0;
      const found = matches[idx];
      if (!found) {
        results[match] = matches.length > 0
          ? { error: `index ${idx} out of range (${matches.length} match(es))` }
          : { error: 'not found' };
        missed++; if (stopOnError) break; continue;
      }
      usedI.add(found.i);
      const r = fillItem(found, String(value), append);
      results[match] = r;
      const el = elAt(found);
      if (!r.error && isHidden(el)) r.filledButNotVisible = true;
      if (verify && !r.error) {
        // Re-read the field's current value after filling. A mismatch means an
        // async re-render (e.g. a Drupal AJAX widget) wiped what we wrote, which
        // would otherwise masquerade as a clean fill.
        const expected = String(value);
        const current = readValue(el);
        const stuck = append ? (current != null && current.endsWith(expected))
                             : (current === expected);
        if (!stuck) {
          r.reverted = true;
          r.currentValue = current;
        }
      }
      if (r.error) { missed++; if (stopOnError) break; }
      else filled++;
    }
    const reverted = Object.entries(results).filter(([, r]) => r && r.reverted).map(([k]) => k);
    const out = { filled, missed, total: Object.keys(fields).length, results };
    if (verify) out.reverted = reverted;
    return withSnap(out);
  }

  return { error: `Unknown action: ${action}` };
 } catch (e) {
  return { error: 'page action threw: ' + (e?.stack || e?.message || String(e)).slice(0, 600) };
 }
}

// Self-install. The background's bridge calls window.__fastlink.run(action, args).
// We DELIBERATELY do NOT build the index here. Eager indexing on every page load
// made this script a background parasite — on heavy SPAs (e.g. GCP) the initial
// DOM walk + a forever-on MutationObserver pegged the renderer with zero tool
// calls. The index now builds LAZILY on the first tool call (initIndex inside
// runPageAction), and the observer self-suspends on idle / disconnects on
// re-render storms. Cost on tabs you never automate: zero.
if (typeof window !== 'undefined') {
  window.__fastlink = window.__fastlink || {};
  window.__fastlink.run = runPageAction;
}
