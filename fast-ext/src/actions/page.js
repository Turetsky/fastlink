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

// ─── Heavy-page guards (issue #7: heavy-DOM main-thread freeze) ───
// The DOM walk and the snapshot serialize are chunked: after at most SLICE_MS
// of contiguous main-thread work we YIELD to the event loop, so even mid-index
// the page never goes "unresponsive". A node-walk CEILING bails the full walk
// on giant SPAs (50k+ nodes) so we never even attempt to serialize the world.
const SLICE_MS = 25;     // max contiguous main-thread time before yielding
const SNAP_SLICE_MS = 12; // serialize yields MORE eagerly than the index walk:
                         // each item does 3-5 layout reads (rect + computed-style +
                         // per-iframe offset), so we keep contiguous work well under
                         // one frame (16ms) and never drop input on a heavy SPA.
const MAX_WALK = 25000;  // hard ceiling on DOM nodes VISITED by the index walk
const HUGE_INDEX = 8000; // above this many entries, snapshots degrade to viewport-only
                         // (kept under MAX_INDEX 10000; normal rich pages sit far below)

// Interactive CONTROL preference (match ranking). A real control (button/input/
// radio/checkbox/option/menuitem/tab/…) should be preferred over a generic link
// or text node when text scores are close — e.g. a radio whose accessible name
// comes from a wrapping <label> vs a plain <a> that merely contains the same word.
const CONTROL_TAGS = new Set(['button', 'input', 'select', 'textarea']);
const CONTROL_ROLES = new Set([
  'button', 'radio', 'checkbox', 'option', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'switch', 'link',
]);
const CONTROL_BONUS = 1.25; // additive, crosses at most ~one scoring tier — never a hard override
const isControlItem = (it) => {
  if (!it) return false;
  if (CONTROL_TAGS.has(it.tag)) return true;
  return CONTROL_ROLES.has((it.role || '').toLowerCase());
};

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

// Collapse internal runs of whitespace (newlines/indentation between a wrapping
// <label>'s text and its control) to single spaces so the label string is a
// clean, matchable phrase — e.g. "Delivery instructions:\n  " → "Delivery
// instructions:". Without this, source-formatted labels carry stray whitespace
// that breaks exact/substring matching downstream.
const cleanLabel = (s) => (s || '').replace(/\s+/g, ' ').trim();
const labelFor = (el) => {
  // 1) Explicit association: <label for="id">. Works across the element's own
  //    root (shadow DOM) and the main document.
  if (el.id) {
    const escId = CSS.escape(el.id);
    const root = el.getRootNode && el.getRootNode();
    const lbl = (root && root.querySelector && root.querySelector(`label[for="${escId}"]`))
              || document.querySelector(`label[for="${escId}"]`);
    if (lbl) return cleanLabel(lbl.textContent);
  }
  // 2) Implicit association: a wrapping <label> ancestor (the control sits
  //    INSIDE the label, e.g. httpbin's `<label>Delivery instructions:
  //    <textarea></textarea></label>`). Strip the control's current value so a
  //    filled field's text isn't mistaken for its label.
  let p = el.parentElement;
  while (p) {
    if (p.tagName === 'LABEL') {
      const t = cleanLabel(p.textContent);
      const v = cleanLabel(el.value || '');
      return v ? cleanLabel(t.replace(v, '')) : t;
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
      capped: false,       // node-walk ceiling hit → index is intentionally partial
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

// Shared initial-walk state, persisted on INDEX so the async (idle-time) build
// and the snapshot-time build (buildIndexAsync) advance the SAME cursor and
// converge — instead of each restarting DFS from <body>. `walked` is a monotonic
// count of nodes VISITED, enforcing the MAX_WALK ceiling across all slices.
const INIT = INDEX._init || (INDEX._init = { stack: null, walked: 0 });
const ensureInitStack = () => {
  if (INIT.stack) return;
  const root = document.body || document.documentElement;
  INIT.stack = root ? [root] : [];
};

// Process up to `budget` elements off the shared initial-walk stack, stopping
// early when `overBudget()` returns true. Flips INDEX.ready once the walk
// drains. Returns the number of elements processed this slice.
const stepInitWalk = (budget, overBudget) => {
  ensureInitStack();
  const stack = INIT.stack;
  let n = 0;
  while (stack.length && n < budget) {
    // Hard node ceiling: a 50k-node SPA (GCP) must NEVER attempt a full walk —
    // visiting every node is itself the main-thread hog (matches(SELECTOR) per
    // node). Once we've VISITED MAX_WALK nodes, stop expanding: the entries we
    // have plus viewport-only serialization are enough, and a complete walk
    // would just freeze the page. Flagged so snapshots advertise partial:true.
    if (INIT.walked >= MAX_WALK) { INIT.stack = []; INDEX.ready = true; INDEX.capped = true; break; }
    const el = stack.pop();
    n++;
    INIT.walked++;
    if (el && el.nodeType === 1) {
      const tag = el.tagName.toLowerCase();
      if (!SKIP_SUBTREE.has(tag)) {
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
      }
    }
    if (overBudget && overBudget()) break;
  }
  if (!stack.length) INDEX.ready = true;
  return n;
};

// Advance the initial walk under a wall-clock deadline, YIELDING between slices.
// Called at snapshot time when INDEX.ready is still false — on ad/tracker-heavy
// pages the main thread never goes idle, so requestIdleCallback is perpetually
// starved and the async (idle) build can stall with the index EMPTY. This forces
// progress while still releasing the main thread every SLICE_MS, so the heavy
// walk NEVER blocks the page into "unresponsive" (issue #7). Never waits on the
// network. Returns true if the walk completed within the deadline.
const buildIndexAsync = async (deadlineMs) => {
  if (INDEX.ready) return true;
  const start = nowMs();
  let sliceStart = start;
  while (!INDEX.ready) {
    let k = 0;
    // Bound this slice by SLICE_MS, sampled every 32 nodes. Each node runs
    // classifyElement→el.matches(SELECTOR) (expensive on deep trees), so a coarse
    // 256-node cadence let a slow selector run hundreds of times before the first
    // time-check — long enough to blow past the slice and jank the page.
    stepInitWalk(5_000_000, () => ((++k & 31) === 0) && (nowMs() - sliceStart) > SLICE_MS);
    if (INDEX.ready) break;
    if ((nowMs() - start) > deadlineMs) break;   // overall deadline → partial index
    await yieldControl();                          // let the page breathe
    sliceStart = nowMs();
  }
  return !!INDEX.ready;
};

// Initial population, chunked and yielded via requestIdleCallback so it never
// blocks paint. A guaranteed per-tick FLOOR is processed regardless of how much
// idle time the callback reports: a busy SPA (GCP / ad-heavy pages) hands back
// callbacks with ~0 timeRemaining, and the old `while timeRemaining > 1` guard
// then made ZERO progress forever — leaving the index empty and INDEX.ready
// stuck false. The floor guarantees forward progress; snapshots additionally
// force-build (yielding) via buildIndexAsync.
const INIT_FLOOR = 400;    // elements indexed per tick even under idle starvation
const INIT_CHUNK = 2000;   // opportunistic extra while real idle time remains
const populateIndexAsync = () => {
  if (INDEX.initStarted) return;
  INDEX.initStarted = true;
  ensureInitStack();
  const step = (deadline) => {
    stepInitWalk(INIT_FLOOR, null);   // unconditional floor — always advances
    if (!INDEX.ready) {
      stepInitWalk(INIT_CHUNK, () => deadline && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() <= 1);
    }
    if (!INDEX.ready) {
      if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(step, { timeout: 200 });
      else setTimeout(() => step(null), 0);
    }
  };
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

// Yield the main thread for one macrotask so the page can paint / handle input
// between work slices. MessageChannel is used (not setTimeout) because timers
// are clamped to ≥1s in BACKGROUND tabs — which is exactly the relay case where
// Claude drives a backgrounded tab — and requestAnimationFrame is paused there
// entirely. MessageChannel postMessage is not throttled, so a heavy snapshot in
// a background tab still progresses promptly. scheduler.yield() is preferred
// when available (keeps us ahead of the line on re-entry).
const yieldControl = () => {
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
    try { return scheduler.yield(); } catch {}
  }
  return new Promise((resolve) => {
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(0);
    } catch { setTimeout(resolve, 0); }
  });
};

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
const OVERLAY_MAX_ELS = 500;   // never let the portal sweep itself become the freeze
const OVERLAY_BUDGET_MS = 60;
const collectOverlayEls = () => {
  const set = new Set();
  const start = nowMs();
  // walkDeep can't break early, but the callbacks bail cheaply once we hit the
  // element cap or wall-clock budget — so a giant open listbox can't hang here.
  walkDeep(document, OVERLAY_CONTAINERS, (container) => {
    if (set.size >= OVERLAY_MAX_ELS || (nowMs() - start) > OVERLAY_BUDGET_MS) return;
    try { walkDeep(container, SELECTOR, (el) => { if (set.size < OVERLAY_MAX_ELS) set.add(el); }); } catch {}
  });
  for (const el of set) { try { indexElement(el); } catch {} }
  return set;
};

// Read the index → snapshot payload. Single layout pass for all rect reads.
// Cleans up entries whose elements have been detached (defense in depth;
// MutationObserver usually catches removals first).
const serializeSnapshot = async (viewportOnly, opts) => {
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
  // If the initial index walk hasn't finished, advance it synchronously under
  // the snapshot indexer's OWN deadline so we return a POPULATED partial index
  // rather than empty-and-hanging. This does NOT wait on network idle (which
  // often never fires on ad/tracker-heavy pages) — it's a bounded DOM walk.
  let indexPartial = false;
  if (!INDEX.ready) {
    const indexMs = (opts && opts.indexMs) || 2500;
    await buildIndexAsync(indexMs);
    indexPartial = !INDEX.ready;
  }
  // Auto-degrade: on a giant DOM (node ceiling hit, or an index already past
  // HUGE_INDEX entries) force viewport-only output. Reading + offsetting rects
  // for tens of thousands of entries is the freeze; viewport-only keeps the
  // payload small and the loop short. Heavy pages get partial-but-usable data
  // instead of a hang.
  const heavy = INDEX.capped || INDEX.byEl.size > HUGE_INDEX;
  if (heavy) viewportOnly = true;
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
  let sliceStart = nowMs();
  // Memoize the per-iframe offset for THIS pass: every element in a given
  // document shares the same frame-offset chain (shadow roots add none), so we
  // compute it once per ownerDocument instead of walking + reading a rect per
  // frame-ancestor on EVERY element — the dominant layout cost on framed pages.
  const offsetCache = new Map();
  const offsetForCached = (el) => {
    const doc = el.ownerDocument || document;
    let off = offsetCache.get(doc);
    if (off === undefined) { off = offsetFor(el); offsetCache.set(doc, off); }
    return off;
  };
  for (const [el, entry] of INDEX.byEl) {
    // Check the budget OFTEN (every 16 items): each item does 3-5 layout reads,
    // so a coarse 64-item cadence could run ~300 layouts between checks and blow
    // a whole frame before yielding. Two bounds:
    //   • overall budget → bail with a partial-but-rich snapshot flagged
    //     snapshotTimedOut, never hang the whole call to the broker timeout.
    //   • per-slice SNAP_SLICE_MS → YIELD the main thread so even a 10k-entry
    //     serialize can't freeze the page into "unresponsive" (issue #7).
    if ((++seen & 15) === 0) {
      const t = nowMs();
      if (budgetMs && (t - startMs) > budgetMs) { timedOut = true; break; }
      if ((t - sliceStart) > SNAP_SLICE_MS) { await yieldControl(); sliceStart = nowMs(); }
    }
    if (!el.isConnected) { detached.push(el); continue; }
    let rect;
    try { rect = el.getBoundingClientRect(); } catch { continue; }
    if (!visible(el, rect)) continue;
    const isOverlayEl = overlayEls && overlayEls.has(el);
    if (viewportOnly && !isOverlayEl && (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw)) continue;
    const off = offsetForCached(el);
    const x = Math.round(rect.x + off.ox);
    const y = Math.round(rect.y + off.oy);
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (entry.kind === 'click') {
      // Emit only keys that carry a meaningful value — null/undefined/empty-string
      // fields are dropped entirely (roughly halves the payload with zero info
      // loss; every consumer reads `it.X && …` / `(it.X || '')`, so absent and
      // null are equivalent to them). i, tag, text and geometry are always kept.
      const item = { i: entry.id, tag: entry.tag, text: entry.text, x, y, w, h };
      if (entry.role)        item.role = entry.role;
      if (entry.innerText)   item.innerText = entry.innerText;
      if (entry.label)       item.label = entry.label;
      if (entry.href)        item.href = entry.href;
      if (entry.name)        item.name = entry.name;
      if (entry.placeholder) item.placeholder = entry.placeholder;
      if (entry.ariaLabel)   item.ariaLabel = entry.ariaLabel;
      if (entry.describedBy) item.describedBy = entry.describedBy;
      if (entry.title)       item.title = entry.title;
      if (entry.type)        item.type = entry.type;
      if (off.inFrame)       item.inFrame = true;
      if (overlayEls && overlayEls.has(el)) item.inOverlay = true;
      items.push(item);
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
    partial: (indexPartial || INDEX.capped) || undefined,
    capped: INDEX.capped || undefined,
    snapshotTimedOut: timedOut || undefined,
  };
};

// ─────────────────────── output trimming (rank + cap) ───────────────────────
// serializeSnapshot returns the FULL index (every matchable element) — that's
// what the internal fast_click/fast_fill match walks consume. capSnapshot is
// applied ONLY to the snapshot handed back to the model: it RANKS items so
// interactive controls + on-screen / above-the-fold elements come first and the
// long tail (dozens of footer/nav links far down the page) comes last, then CAPS
// to keep the payload small. A `truncated` count tells the model more exist;
// fast_snapshot's `full`/`limit` args bypass the cap for the complete set.
const ITEM_CAP_DEFAULT    = 70;   // explicit fast_snapshot default
const CONTENT_CAP_DEFAULT = 30;   // content text array default
const AUTO_ITEM_CAP       = 30;   // action-result preview snapshot (tighter)
const AUTO_CONTENT_CAP    = 15;
const RANK_INTERACTIVE_TAGS  = new Set(['input', 'button', 'select', 'textarea']);
const RANK_INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'option', 'menuitem', 'tab',
  'combobox', 'switch', 'textbox',
]);
const rankItemScore = (it, vh, vw) => {
  let r = 0;
  if (it.inOverlay) r += 1000;                              // open menu/dropdown items: always first
  if (RANK_INTERACTIVE_TAGS.has(it.tag)) r += 100;
  else if (it.tag === 'a' && it.text) r += 40;
  if (RANK_INTERACTIVE_ROLES.has((it.role || '').toLowerCase())) r += 50;
  const onScreen = it.y >= 0 && it.y <= vh && it.x >= 0 && it.x <= vw;
  if (onScreen) r += 60;                                     // in-viewport
  else if (it.y >= 0 && it.y < vh) r += 30;                  // above-the-fold-ish
  if (it.y > vh * 3) r -= 20;                                // deep long tail (footers)
  return r;
};
// Rank → keep top N (in rank order, so interactive/on-screen lead) → set a
// `truncated` count when items were dropped. Mutates and returns `snap`.
const capSnapshot = (snap, itemCap, contentCap) => {
  if (!snap || typeof snap !== 'object') return snap;
  const vh = window.innerHeight, vw = window.innerWidth;
  if (Array.isArray(snap.items) && itemCap >= 0 && snap.items.length > itemCap) {
    const ranked = snap.items
      .map((it, idx) => ({ it, idx, s: rankItemScore(it, vh, vw) }))
      .sort((a, b) => (b.s - a.s) || (a.idx - b.idx));
    snap.truncated = snap.items.length - itemCap;
    snap.items = ranked.slice(0, itemCap).map((x) => x.it);
    snap.count = snap.items.length;
  }
  if (Array.isArray(snap.content) && contentCap >= 0 && snap.content.length > contentCap) {
    const ranked = snap.content
      .map((c, idx) => ({ c, idx, s: (c.y >= 0 && c.y <= vh ? 100 : 0) - (c.y > vh * 3 ? 20 : 0) }))
      .sort((a, b) => (b.s - a.s) || (a.idx - b.idx));
    snap.contentTruncated = snap.content.length - contentCap;
    snap.content = ranked.slice(0, contentCap).map((x) => x.c);
    snap.contentCount = snap.content.length;
  }
  return snap;
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
    // Type preference: nudge real interactive CONTROLS above generic links/text
    // when scores are close. Without this a plain <a>"External" (innerText=4)
    // outranks the radio whose name "External" comes from a <label> (label=3).
    // Additive (CONTROL_BONUS crosses ~one tier), never a hard override.
    if (score > 0 && isControlItem(it)) score += CONTROL_BONUS;
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

  // Stable DOM-order comparator on snapshot items. Used wherever an explicit
  // `index` disambiguates repeated matches — rank order shuffles when sibling
  // sections re-render, so index:N must address a fixed document-order slot.
  // Falls back to visual top→bottom / left→right when the elements live in
  // different trees (iframe/shadow → compareDocumentPosition is DISCONNECTED).
  const docOrderCmp = (a, b) => {
    const ea = elById(a.i), eb = elById(b.i);
    if (ea && eb && ea !== eb) {
      try {
        const pos = ea.compareDocumentPosition(eb);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      } catch {}
    }
    return (a.y - b.y) || (a.x - b.x);
  };

  // When a matched element is a descendant link (or a link sharing a <label>)
  // inside a matched CONTROL with the same text, the inner <a> competes with the
  // real control and can win — e.g. a checkbox beside "I agree to the
  // <a>Policy</a>", or a radio named "External" wrapping an <a>External</a>.
  // Drop the redundant plain link so the control is reachable by its label text.
  const dropRedundantDescendantLinks = (list) => {
    if (list.length < 2) return list;
    const els = new Map();
    for (const it of list) els.set(it, elById(it.i));
    return list.filter((it) => {
      if (it.tag !== 'a' || isControlItem(it)) return true;   // only plain links
      const el = els.get(it);
      if (!el) return true;
      const lbl = (el.closest && el.closest('label')) || null;
      for (const other of list) {
        if (other === it || !isControlItem(other)) continue;
        const oe = els.get(other);
        if (!oe || oe === el) continue;
        // control contains the link, OR both sit under the same wrapping <label>.
        if (oe.contains(el) || (lbl && lbl.contains(oe))) return false;
      }
      return true;
    });
  };

  // Auto-attach a fresh viewport snapshot to action returns so callers don't
  // have to follow every fast_click / fast_fill / etc. with a separate
  // fast_snapshot. Yields one requestAnimationFrame so click handlers, Angular
  // zones, React effects, etc. have a chance to mutate before we serialize.
  // Opt-out per call with args.noSnapshot. Skipped on error returns and when
  // an action already returns its own snapshot.
  const withSnap = async (result, preSnap) => {
    if (!result || typeof result !== 'object') return result;
    if (result.error || result.snapshot || args.noSnapshot) return result;
    // Yield ~one frame so click handlers / framework effects settle before we
    // serialize — but NEVER hang on it. requestAnimationFrame is FROZEN in a
    // backgrounded / occluded tab (the relay drives exactly such tabs: the
    // claude.ai tab is foreground while the target tab is hidden), so the rAF
    // callback may never fire and the bare `await requestAnimationFrame` would
    // stall withSnap — and therefore the whole action — until the 30s broker/
    // relay timeout, even though the action (e.g. a fill) already completed.
    // Race the frame against a wall-clock cap so a foreground tab still waits a
    // real frame while a hidden tab falls through promptly. (BUG-4)
    await Promise.race([
      new Promise(r => (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame(() => r())
        : setTimeout(r, 0)),
      // Hard cap. Background tabs clamp setTimeout to ~1s, which is the effective
      // bound here — still orders of magnitude under the 30s tool timeout — so a
      // hidden tab whose rAF never fires falls through instead of hanging.
      new Promise(r => setTimeout(r, 250)),
    ]);
    // Avoid the double-walk: most actions already serialized a FULL match
    // snapshot (serializeSnapshot(false)) to FIND their target. Rather than walk
    // the entire index a SECOND time here, REUSE that result — viewport-filtered
    // (cheap array filter, no layout) to keep the payload small. One walk per
    // action instead of two. The reused view reflects match-time DOM; callers
    // needing post-action state (a dropdown the click opened) should fast_snapshot
    // / fast_wait. Actions with no precomputed snapshot (fast_scroll, fast_wait,
    // fast_select_option) fall through to a single fresh serialize below.
    if (preSnap && typeof preSnap === 'object' && Array.isArray(preSnap.items)) {
      try {
        const vh = window.innerHeight, vw = window.innerWidth;
        const inView = (it) => !!it.inOverlay || !(it.y + it.h < 0 || it.y > vh || it.x + it.w < 0 || it.x > vw);
        const items = preSnap.items.filter(inView);
        const content = Array.isArray(preSnap.content) ? preSnap.content.filter(inView) : [];
        // Action-result snapshot is a compact convenience preview — cap it
        // tighter than an explicit fast_snapshot (the caller can always issue a
        // full fast_snapshot for the complete set).
        result.snapshot = capSnapshot(
          { ...preSnap, count: items.length, items, contentCount: content.length, content },
          AUTO_ITEM_CAP, AUTO_CONTENT_CAP,
        );
        if (preSnap.snapshotTimedOut || preSnap.partial || preSnap.capped) {
          result.snapshotPartial = true;
          if (preSnap.snapshotTimedOut) result.snapshotTimedOut = true;
          if (preSnap.capped) result.snapshotNote = 'page too heavy — viewport-only / partial index returned';
        }
      } catch {
        result.snapshot = preSnap;
      }
      return result;
    }
    // The auto-snapshot is a convenience, never the point of the call. Bound it
    // and swallow failures so a slow/huge serialize can NEVER turn a successful
    // action into a broker timeout. On overrun the action result is returned
    // with whatever partial snapshot was gathered + snapshotTimedOut:true, so
    // the agent still has rich text to act on instead of reaching for a
    // screenshot.
    try {
      // Time-boxed + abortable: serialize now yields the main thread every
      // SLICE_MS and bails at budgetMs, so a heavy page can NEVER turn a
      // successful click/fill into a 30s broker timeout or freeze the renderer.
      // indexMs is bounded too so the auto-snapshot returns within a couple
      // seconds (partial is fine — the action already succeeded).
      const snap = await serializeSnapshot(true, { budgetMs: 2000, drainMs: 30, indexMs: 1500 });
      // Compact preview cap (tighter than an explicit fast_snapshot).
      capSnapshot(snap, AUTO_ITEM_CAP, AUTO_CONTENT_CAP);
      result.snapshot = snap;
      if (snap && (snap.snapshotTimedOut || snap.partial || snap.capped)) {
        result.snapshotPartial = true;
        if (snap.snapshotTimedOut) result.snapshotTimedOut = true;
        if (snap.capped) result.snapshotNote = 'page too heavy — viewport-only / partial index returned';
      }
    } catch (e) {
      result.snapshot = null;
      result.snapshotPartial = true;
      result.snapshotNote = 'snapshot skipped — page too heavy to serialize';
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
    // Native <select> is fillable: fillItem matches the value against option
    // text/value and sets it. Lets fast_fill / fast_fill_form set native
    // dropdowns alongside text inputs in one call.
    if (it.tag === 'input' || it.tag === 'textarea' || it.tag === 'select') return true;
    const el = elAt(it);
    return el ? (el.isContentEditable || el.getAttribute('role') === 'textbox') : false;
  };
  const fieldMatchesText = (it, m) =>
    (it.placeholder && it.placeholder.toLowerCase().includes(m)) ||
    (it.label       && it.label.toLowerCase().includes(m)) ||
    (it.ariaLabel   && it.ariaLabel.toLowerCase().includes(m)) ||
    (it.name        && it.name.toLowerCase().includes(m)) ||
    (it.text        && it.text.toLowerCase().includes(m));
  // EXACT field match (label / aria / placeholder / name equal, not substring).
  // Preferred over the loose substring match so "URIs 1" doesn't grab "URIs 10"
  // or a different section's "URIs" field.
  const fieldMatchesExact = (it, m) =>
    (it.label       && it.label.toLowerCase() === m) ||
    (it.ariaLabel   && it.ariaLabel.toLowerCase() === m) ||
    (it.placeholder && it.placeholder.toLowerCase() === m) ||
    (it.name        && it.name.toLowerCase() === m);
  // Restrict candidate fields to those under a heading/legend whose text matches
  // `nearLo` — i.e. the nearest preceding section anchor IS the requested one.
  // Lets callers disambiguate repeated fields by section ("URIs 1" under
  // "Authorized redirect URIs" vs under "Authorized JavaScript origins") without
  // guessing an occurrence index. Bounded scans; returns [] when no anchor matches.
  const scopeItemsToSection = (poolItems, nearLo) => {
    let headings;
    try { headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,legend,[role="heading"]')).slice(0, 400); }
    catch { return []; }
    if (!headings.length) return [];
    const matchH = headings.filter(h => ((h.textContent || '').trim().toLowerCase()).includes(nearLo));
    if (!matchH.length) return [];
    const precedes = (a, b) => { // a strictly before b in document order
      try { return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); } catch { return false; }
    };
    const inSection = (el) => {
      let nearest = null;   // nearest heading at-or-before el
      for (const h of headings) {
        if (h === el) continue;
        if (h.contains(el) || precedes(h, el)) {
          if (!nearest || precedes(nearest, h)) nearest = h;
        }
      }
      return !!nearest && matchH.includes(nearest);
    };
    const out = [];
    for (const it of poolItems) {
      const el = elById(it.i);
      if (el && inSection(el)) out.push(it);
    }
    return out;
  };
  const fillItem = (found, value, append) => {
    const el = elAt(found);
    if (!el) return { error: 'no element' };
    // NEVER write the literal "undefined"/"null". A missing value must be caught
    // before we stringify, or String(undefined) -> "undefined" lands in the field
    // (confirmed bug: a "Customer name" field read `undefined`). An explicit ""
    // is a REAL value that CLEARS the field, so only null/undefined is rejected.
    if (value == null) return { error: "fast_fill: no value provided — pass value (use value:'' to clear the field)" };
    const v = String(value); // safe now: value is present (may be "")
    flashEl(el, 'fill');
    el.focus();
    // Native <select>: don't type into it — match the value against option TEXT
    // or VALUE (exact > startsWith > substring on text, then exact value), set
    // .value and fire change. Lets fast_fill_form set native dropdowns inline.
    if (el.tagName === 'SELECT') {
      const all = Array.from(el.options);
      const target = pickByText(all, o => (o.text || '').trim().toLowerCase(), v)
                  || all.find(o => (o.value || '').toLowerCase() === v.toLowerCase());
      if (!target) return { error: 'option not found in <select>', available: all.map(o => o.text) };
      el.value = target.value;
      // composed:true so the input/change cross any shadow boundary — a web-
      // component / Angular-Material control whose validator listens OUTSIDE the
      // select's shadow root only revalidates if the event escapes it.
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return { filled: { tag: found.tag, label: found.label, name: found.name }, valueSet: target.text, kind: 'native-select' };
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, append ? (el.value + v) : v); // v==="" -> empties the field
      // composed:true so validators across a shadow boundary still see input/change.
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    } else {
      el.innerText = append ? (el.innerText + v) : v; // contenteditable: "" clears
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: v }));
    }
    return { filled: { tag: found.tag, label: found.label, placeholder: found.placeholder, name: found.name }, valueSet: v };
  };

  const pickByText = (items, getText, query) => {
    const lo = query.toLowerCase();
    return items.find(o => getText(o) === lo)
        || items.find(o => getText(o).startsWith(lo))
        || items.find(o => getText(o).includes(lo));
  };

  // Diagnostic for "why didn't this match?" — runs only on a 0-match miss.
  // This is ONLY a hint; it must NEVER freeze the page. The old version walked
  // the WHOLE DOM doing getComputedStyle + getBoundingClientRect + closest() per
  // textual hit (5-10s freeze on GCP's 50k-node tree). Now:
  //   • hard-cap elements EXAMINED and a wall-clock BUDGET, both checked often;
  //   • the scan does NO layout — text test uses own text-nodes + a few short
  //     attributes (cheap, no quadratic textContent), type test is matches();
  //   • layout reads (style/rect/closest) run on at most a handful of the best
  //     interactive candidates AFTER the scan;
  //   • over budget → degrade to a cheap count-only answer.
  const DIAG_MAX_EXAMINE = 1500;
  const DIAG_BUDGET_MS = 150;
  const DIAG_LAYOUT_CAP = 24;
  const diagnoseNoMatch = (queryText) => {
    const q = (queryText || '').toLowerCase();
    if (!q) return ['empty text query'];
    const out = [];
    const start = nowMs();
    let examined = 0, stopped = false;
    let interactiveHits = 0, nonInteractiveHits = 0;
    const layoutCandidates = [];
    walkDeep(document, '*', (el) => {
      if (stopped) return;
      if (examined >= DIAG_MAX_EXAMINE || ((examined & 15) === 0 && (nowMs() - start) > DIAG_BUDGET_MS)) { stopped = true; return; }
      examined++;
      // Cheap, bounded text source: short attributes + this element's OWN text
      // nodes (not the whole subtree → no quadratic textContent blowup). The
      // sought text lives on some leaf whose own text contains it, so leaves are
      // still found.
      let txt = (el.getAttribute?.('aria-label') || '') + ' ' +
                (el.getAttribute?.('placeholder') || '') + ' ' +
                (el.getAttribute?.('title') || '') + ' ' + (el.value || '');
      if (el.childNodes) {
        for (const c of el.childNodes) {
          if (c.nodeType === 3 && c.data) { txt += ' ' + c.data; if (txt.length > 300) break; }
        }
      }
      if (!txt.toLowerCase().includes(q)) return;
      const isInteractive = el.matches?.(SELECTOR);   // no layout
      if (isInteractive) { interactiveHits++; if (layoutCandidates.length < DIAG_LAYOUT_CAP) layoutCandidates.push(el); }
      else nonInteractiveHits++;
    });
    // Layout reads ONLY for the capped sample of interactive candidates.
    let hidden = 0, ariaHidden = 0, offScreen = 0, visibleInteractive = 0;
    const hiddenTags = [];
    for (const el of layoutCandidates) {
      let cs = null, rect = null;
      try { cs = el.ownerDocument?.defaultView?.getComputedStyle?.(el); } catch {}
      try { rect = el.getBoundingClientRect?.(); } catch {}
      const isHidden = cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0');
      const isAriaHidden = el.closest?.('[aria-hidden="true"]') != null;
      const isOff = rect && (rect.width < 2 || rect.height < 2);
      if (isHidden) { hidden++; hiddenTags.push(el.tagName.toLowerCase()); }
      else if (isAriaHidden) ariaHidden++;
      else if (isOff) offScreen++;
      else visibleInteractive++;
    }
    let crossOrigin = 0;
    for (const f of document.querySelectorAll('iframe')) {
      try { if (!f.contentDocument) crossOrigin++; } catch { crossOrigin++; }
    }
    const totalHits = interactiveHits + nonInteractiveHits;
    const more = (examined >= DIAG_MAX_EXAMINE || layoutCandidates.length >= DIAG_LAYOUT_CAP) ? '+' : '';
    if (totalHits === 0) {
      if (stopped) out.push(`Text "${queryText}" not found in the first ${examined} elements (page too large to scan fully). Try more specific/visible text, fast_scroll, or narrow with role/tag.`);
      else out.push(`Text "${queryText}" not found in document, open shadow DOM, or same-origin iframes.`);
      if (crossOrigin > 0) out.push(`Page has ${crossOrigin} cross-origin iframe(s) — content there is not inspectable; the element may live inside.`);
    } else {
      if (visibleInteractive > 0) out.push(`${visibleInteractive}${more} interactive match(es) appear visible but were skipped — the snapshot should already include them; try increasing window size or scroll first.`);
      if (hidden) {
        const tags = [...new Set(hiddenTags)].slice(0, 4).join(', ');
        out.push(`${hidden}${more} match(es) hidden via display:none / visibility:hidden / opacity:0 (${tags}). A parent likely needs opening first — dropdown, accordion, or modal.`);
      }
      if (ariaHidden) out.push(`${ariaHidden}${more} match(es) sit under aria-hidden="true" — usually behind an active modal/overlay.`);
      if (offScreen) out.push(`${offScreen}${more} interactive match(es) have 0×0 / off-screen bounds. Try fast_scroll to bring them into view.`);
      if (nonInteractiveHits) out.push(`${nonInteractiveHits}${more} non-interactive match(es) — fast_click only fires on buttons/links/inputs/[role]/[onclick]/etc. Use fast_evaluate to dispatch a click on a plain element if needed.`);
      if (stopped) out.push(`(diagnostic stopped early at ${examined} elements / ${DIAG_BUDGET_MS}ms — counts are partial.)`);
    }
    return out;
  };

  if (action === 'fast_snapshot') {
    const snap = await serializeSnapshot(!!args.viewport, { overlay: !!args.overlay });
    // full:true → the complete, uncapped set. Otherwise rank + cap (interactive /
    // on-screen first); `limit` overrides the default item cap.
    if (args.full) return snap;
    const itemCap = (typeof args.limit === 'number' && args.limit >= 0) ? args.limit : ITEM_CAP_DEFAULT;
    return capSnapshot(snap, itemCap, CONTENT_CAP_DEFAULT);
  }

  if (action === 'fast_wait') {
    const t = (args.text || '').toLowerCase();
    if (!t) return { error: 'fast_wait needs either text or networkIdle:true' };
    const deadline = Date.now() + (args.timeoutMs || 5000);
    // Cheap text-only scan over the index — no rect reads, no layout.
    // Only when we find a match do we serialize that ONE entry with
    // coords, so a polling fast_wait doesn't repeatedly force layout
    // on the whole page while it's still rendering.
    // Scan the index for a match. Prefer an interactive ('click') entry so the
    // clickable path keeps returning coords; fall back to a non-interactive
    // ('content') entry — headings, paragraphs, <pre> JSON, body text — so
    // fast_wait can resolve on plain page content too. Returns { el, content }.
    const findEntryByText = () => {
      // Bound the per-poll scan so polling (every 150ms) can never jank: on a
      // 10k-entry index an unbounded scan + drain every tick adds up. Cap nodes
      // and wall-clock; a real match is found in the first slice on normal pages.
      let scanned = 0;
      const start = nowMs();
      let contentEl = null;
      for (const [el, entry] of INDEX.byEl) {
        if ((++scanned & 511) === 0 && (nowMs() - start) > 20) break;
        if (scanned > 12000) break;
        if (entry.kind === 'click') {
          if (entry.text && entry.text.toLowerCase().includes(t)) return { el, content: false };
        } else if (entry.kind === 'content') {
          // Remember the first content hit but keep scanning — a clickable hit
          // (richer result with coords) is preferred if one also matches.
          if (!contentEl && entry.text && entry.text.toLowerCase().includes(t)) contentEl = el;
        }
      }
      return contentEl ? { el: contentEl, content: true } : null;
    };
    // Cheap, bounded descent to the smallest element fully containing `t`, so a
    // content match can still carry coords. One child scan per level, depth-
    // capped — never a full-document walk.
    const smallestContaining = () => {
      try {
        let el = document.body;
        if (!el || !(el.textContent || '').toLowerCase().includes(t)) return null;
        for (let depth = 0; depth < 200; depth++) {
          let next = null;
          for (const child of el.children) {
            if (child.nodeType === 1 && (child.textContent || '').toLowerCase().includes(t)) { next = child; break; }
          }
          if (!next) break;
          el = next;
        }
        return el;
      } catch { return null; }
    };
    return new Promise((resolve) => {
      // A content/body match: resolve found.contentMatch without requiring an
      // interactive element. Attach coords when we can locate a containing
      // element (visible), but never drop the match for lack of one. Still
      // attaches the bounded post-wait snapshot (honors noSnapshot).
      const resolveContent = (el, matched) => {
        const found = { text: matched, contentMatch: true };
        if (el && el.isConnected) {
          let rect; try { rect = el.getBoundingClientRect(); } catch { rect = null; }
          if (rect && visible(el, rect)) {
            const off = offsetFor(el);
            found.x = Math.round(rect.x + off.ox);
            found.y = Math.round(rect.y + off.oy);
            found.w = Math.round(rect.width);
            found.h = Math.round(rect.height);
          }
        }
        return resolve(withSnap({ found }));
      };
      let polls = 0;
      const poll = () => {
        polls++;
        drainPendingSync(500, 15);
        const hit = findEntryByText();
        if (hit && hit.el && hit.el.isConnected) {
          const entry = INDEX.byEl.get(hit.el);
          if (hit.content) {
            // Non-interactive content entry — resolve as a content match.
            return resolveContent(hit.el, (entry && entry.text) || args.text);
          }
          // Interactive entry: only now read rect/visibility for the match.
          let rect; try { rect = hit.el.getBoundingClientRect(); } catch { rect = null; }
          if (rect && visible(hit.el, rect)) {
            const off = offsetFor(hit.el);
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
          // Click entry matched but not yet visible — fall through to the body
          // fallback / keep polling.
        }
        // Fallback: visible text that isn't an index entry (e.g. a raw <pre>
        // JSON blob may not be indexed as a content entry). Runs ONLY after the
        // cheap index scan misses. textContent does NOT force layout; gate to
        // every other poll so even a multi-MB body can't jank a 150ms loop.
        if (polls & 1) {
          try {
            const tc = document.body && document.body.textContent;
            if (tc && tc.toLowerCase().includes(t)) {
              return resolveContent(smallestContaining(), args.text);
            }
          } catch {}
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
    const queryAllDeep = (root, selector) => {
      const out = [];
      walkDeep(root, selector, (el) => out.push(el));
      return out;
    };

    const findField = (fieldRaw, fieldLo) => {
      const escName = CSS.escape(fieldRaw);
      const byName = queryAllDeep(document, `[name="${escName}" i]`)[0];
      if (byName) return byName;
      const byId = lookupId(document.documentElement, fieldRaw);
      if (byId) return byId;
      const fieldish = 'input,select,textarea,[role="combobox"],[role="listbox"],[role="textbox"],[role="searchbox"],[contenteditable="true"],[contenteditable=""],[aria-labelledby],[aria-label],[placeholder]';
      const candidatesAll = queryAllDeep(document, fieldish);
      for (const el of candidatesAll) {
        const lbl = labelFor(el);
        if (lbl && lbl.toLowerCase().includes(fieldLo)) return el;
      }
      for (const el of candidatesAll) {
        const al = el.getAttribute && el.getAttribute('aria-label');
        if (al && al.toLowerCase().includes(fieldLo)) return el;
      }
      for (const el of candidatesAll) {
        const ph = el.getAttribute && el.getAttribute('placeholder');
        if (ph && ph.toLowerCase().includes(fieldLo)) return el;
      }
      return null;
    };

    const optText = (o) => (o.textContent || '').trim().toLowerCase();

    // Set ONE dropdown. Returns a plain result object (no snapshot) so it can be
    // looped for batch mode. Shapes mirror the original single-call returns:
    // success { picked, kind }, miss { error, ... }. Shared by both forms.
    const setOne = async (fieldRaw, optionRaw) => {
      const fieldLo = String(fieldRaw == null ? '' : fieldRaw).toLowerCase();
      const optionText = String(optionRaw == null ? '' : optionRaw);
      if (!fieldLo || !optionText) return { error: 'field and option required' };

      const field = findField(fieldRaw, fieldLo);
      if (!field) return { error: `field "${fieldRaw}" not found` };

      if (field.tagName === 'SELECT') {
        const all = Array.from(field.options);
        const target = pickByText(all, o => (o.text || '').trim().toLowerCase(), optionText)
                    || all.find(o => (o.value || '').toLowerCase() === optionText.toLowerCase());
        if (!target) return { error: 'option not found in <select>', available: all.map(o => o.text) };
        field.value = target.value;
        // composed:true so a validator listening OUTSIDE the select's shadow root
        // (web-component / Angular-Material composite control) revalidates — a
        // non-composed change does not cross the shadow boundary (GitHub #1).
        field.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
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
          input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          await wait(400);
        }
        const listboxId = input?.id ? input.id.replace('-input', '-listbox') : null;
        const listbox = (listboxId && document.getElementById(listboxId)) || document.querySelector('[role="listbox"]');
        const opts = listbox ? Array.from(listbox.querySelectorAll('[id*="-option-"], [role="option"]')) : [];
        const target = pickByText(opts, optText, optionText);
        if (!target) {
          return { error: 'no matching option in react-select', tried: optionText, available: opts.slice(0, 10).map(o => (o.textContent || '').trim()) };
        }
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
        target.click();
        await wait(250);
        return { picked: (target.textContent || '').trim(), kind: 'react-select' };
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
        return { picked: (target.textContent || '').trim(), kind: 'aria-listbox' };
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
    };

    // BATCH mode: a { field: option } map sets many dropdowns in one call —
    // each resolved + set in document via setOne, looped. An explicit single
    // field+option passed alongside is merged in (the selections map wins on a
    // key collision). Returns a per-field results map (like fast_fill_form).
    const selections = (args.selections && typeof args.selections === 'object' && !Array.isArray(args.selections))
      ? args.selections : null;
    if (selections) {
      const combined = { ...selections };
      if (args.field != null && args.option != null && !(args.field in combined)) {
        combined[args.field] = args.option;
      }
      const results = {};
      let picked = 0, failed = 0;
      for (const [fieldKey, opt] of Object.entries(combined)) {
        const r = await setOne(fieldKey, opt);
        results[fieldKey] = r;
        if (r && !r.error) picked++; else failed++;
      }
      return withSnap({ picked, failed, total: Object.keys(combined).length, results });
    }

    // Single form (unchanged behaviour): success wrapped with a fresh snapshot,
    // misses returned plain.
    const r = await setOne(args.field, args.option);
    return (r && !r.error) ? withSnap(r) : r;
  }

  if (action === 'fast_hover') {
    const snap = await serializeSnapshot(false);
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
    return withSnap({ hovered: { tag: item.tag, text: item.text, x: Math.round(x), y: Math.round(y), scrolledIntoView: offViewport, totalMatches: matches.length, index: idx } }, snap);
  }

  if (action === 'fast_drag') {
    const snap = await serializeSnapshot(false);
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
    return withSnap({ dragged: { from: fromItem.text, to: toLabel, fromXY: [Math.round(fx), Math.round(fy)], toXY: [Math.round(tx), Math.round(ty)] } }, snap);
  }

  if (action === 'fast_click') {
    const snap = await serializeSnapshot(false);
    // Filter by role/tag BEFORE ranking. Previously the wrong-TYPE top text match
    // won the slot and the post-rank filter then emptied the list (e.g. a plain
    // <a> "External" beating the radio, then role="radio" dropping the <a> →
    // 0 results). When neither is given, matchScore's control-preference biases
    // toward real controls over generic links/text.
    let pool = snap.items;
    if (args.role) {
      const wantRole = String(args.role).toLowerCase();
      pool = pool.filter(m => {
        const explicit = (m.role || '').toLowerCase();
        if (explicit === wantRole) return true;
        return implicitRoleOf(m.tag, m.type) === wantRole;
      });
    }
    if (args.tag) {
      const wantTag = String(args.tag).toLowerCase();
      pool = pool.filter(m => m.tag === wantTag);
    }
    let matches = matchItems(pool, args.text);
    // Prefer an ancestor control over a matched descendant / label-wrapped link
    // competing for the same text (radio named by its <label>; checkbox beside
    // "I agree to the <a>Policy</a>").
    matches = dropRedundantDescendantLinks(matches);
    if (matches.length === 0) {
      const preFilter = matchItems(snap.items, args.text);
      if (preFilter.length > 0 && (args.role || args.tag)) {
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
    // index disambiguation: when an explicit index is given, address matches in
    // STABLE DOM order (document position), not rank order — rank order reshuffles
    // when sibling sections re-render, so index:1 would otherwise point at a
    // different element across calls. Default (no index) still takes the best-
    // RANKED match. role/tag narrowing already applied to the pool above.
    const idxGiven = typeof args.index === 'number';
    const ordered = idxGiven ? matches.slice().sort(docOrderCmp) : matches;
    const idx = idxGiven ? args.index : 0;
    if (idx >= ordered.length) {
      return { error: `Only ${ordered.length} matches for "${args.text}", index ${idx} out of range`, matches: ordered.map(m => ({ tag: m.tag, role: m.role, text: m.text, label: m.label })) };
    }
    const item = ordered[idx];
    const el = elAt(item);
    if (!el) return { error: 'Element not at expected coords' };
    // willNavigate is a best-effort HINT (the batch re-bind keys off ACTUAL
    // navigation, not this) — but predict the common navigating clicks so callers
    // get a useful signal: (a) a real same-window link, and (b) a form-submit
    // control. A <button>/<input> of type submit|image — or a typeless <button>,
    // which defaults to submit — associated with a <form> submits it, which
    // navigates unless the page calls preventDefault (which we can't see here).
    const linkNav = el.tagName === 'A' && el.href && el.target !== '_blank' &&
      !el.href.startsWith('javascript:') && el.href !== location.href + '#';
    const formSubmitNav = (() => {
      const tag = el.tagName;
      if (tag !== 'BUTTON' && tag !== 'INPUT') return false;
      const type = (el.getAttribute('type') || '').toLowerCase();
      const isSubmit = type === 'submit' || type === 'image' ||
        (tag === 'BUTTON' && (type === '' || type === 'submit'));
      if (!isSubmit) return false;
      const form = el.form || el.closest('form');
      return !!form && form.target !== '_blank';
    })();
    const willNavigate = linkNav || formSubmitNav;
    flashEl(el, 'click');
    el.click();
    return withSnap({ clicked: item, willNavigate, totalMatches: ordered.length, index: idx }, snap);
  }

  if (action === 'fast_scroll') {
    const isScrollableBox = (el) => {
      if (!el?.getBoundingClientRect) return false;
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      return /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY);
    };
    const docFallback = () => ({ el: document.scrollingElement || document.documentElement, kind: 'document' });
    const findScroller = () => {
      if (args.selector) {
        const el = document.querySelector(args.selector);
        if (!el) return { error: `selector "${args.selector}" not found` };
        return { el, kind: 'selector' };
      }
      // Container auto-detection forces synchronous layout (getComputedStyle +
      // getBoundingClientRect) per candidate. On ad/tracker-heavy pages with a
      // huge DOM (e.g. Micro Center's PC builder) this once ran 30s+ and hung
      // the action. We can't interrupt synchronous JS with a Promise timeout,
      // so instead we hard-bound the work with an in-loop time budget and bail
      // to a plain document/window scroll the moment we exceed it. fast_scroll
      // must ALWAYS return within a couple seconds; a slightly-less-precise
      // container is better than a hang (and callers can still pass `selector`
      // or use fast_wheel for canvas/virtualized cases).
      const deadline = Date.now() + 400;
      try {
        // 1) Cheapest + most reliable: walk UP from the viewport-center element.
        // Handles virtualized scrollers and the common "one big scroll pane" case
        // with a bounded ancestor chain (no full-DOM scan at all).
        let el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
        let depth = 0;
        while (el && el !== document.body && el !== document.documentElement && depth++ < 60) {
          if (isScrollableBox(el)) return { el, kind: 'ancestor' };
          el = el.parentElement;
        }
        // 2) Bounded scan of LIKELY scroller candidates only. The old selector
        // included `body > * *` (≈every node) and once ran 30s+ on heavy SPAs,
        // blowing the budget before the first time-check. Restrict to main regions
        // + elements that ADVERTISE scrolling (class/style hints), hard-cap the
        // count, and check the clock every 64. Always falls back to window scroll.
        let best = null, bestArea = 0, scanned = 0;
        let candidates;
        try {
          candidates = document.querySelectorAll(
            'main, [role="main"], [class*="scroll" i], [class*="overflow" i], [style*="overflow" i]'
          );
        } catch { candidates = []; }
        for (const e of candidates) {
          if ((++scanned & 63) === 0 && Date.now() > deadline) break;
          if (scanned > 4000) break;
          if (!isScrollableBox(e)) continue;
          const r = e.getBoundingClientRect();
          if (r.width < 100 || r.height < 100) continue;
          const area = r.width * r.height;
          if (area > bestArea) { best = e; bestArea = area; }
        }
        if (best) return { el: best, kind: 'largest' };
      } catch {}
      return docFallback();
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
    const snap = await serializeSnapshot(false);
    let pool = snap.items.filter(it => isFillable(it));
    // Optional section scoping: restrict to fields under the nearest heading /
    // legend matching args.near (alias args.section). Lets callers disambiguate
    // repeated fields ("URIs 1" in two cards) deterministically by section.
    const near = String(args.near || args.section || '').toLowerCase();
    if (near) {
      const scoped = scopeItemsToSection(pool, near);
      if (scoped.length) pool = scoped;
    }
    // Prefer an EXACT field-label/name match over a loose substring, so "URIs 1"
    // doesn't grab "URIs 10" / a sibling section's "URIs". Substring is the
    // fallback when nothing matches exactly.
    const exact = pool.filter(it => fieldMatchesExact(it, m));
    const ranked = exact.length ? exact : pool.filter(it => fieldMatchesText(it, m));
    if (!ranked.length) return { error: `No fillable element matching "${args.match}"` };
    // Optional occurrence index among the matches in STABLE DOM order.
    const ordered = ranked.slice().sort(docOrderCmp);
    const idx = (typeof args.index === 'number' && args.index >= 0) ? args.index : 0;
    if (idx >= ordered.length) return { error: `Only ${ordered.length} fillable match(es) for "${args.match}", index ${idx} out of range` };
    const found = ordered[idx];
    // Lenient key handling: callers/models routinely confuse `text` (fast_type)
    // with `value` (fast_fill). Accept `text` as an alias. Use `??` (not `||`) so
    // an explicit empty string value:"" is treated as PRESENT (→ clears) and is
    // not discarded in favor of `text`.
    const value = args.value ?? args.text;
    // Genuinely missing value (undefined/null, not "") → clear error, never write
    // the literal "undefined".
    if (value == null) return { error: "fast_fill: no value provided — pass value (use value:'' to clear the field)" };
    // clear-before-fill is preserved (fillItem replaces unless args.append).
    return withSnap(fillItem(found, value, args.append), snap);
  }

  if (action === 'fast_fill_form') {
    const fields = (args.fields && typeof args.fields === 'object') ? args.fields : null;
    if (!fields) return { error: 'fields object required, e.g. { email: "...", phone: "...", country: "US" }' };
    const append = !!args.append;
    const stopOnError = !!args.stopOnError;
    const verify = !!args.verify;
    const snap = await serializeSnapshot(false);
    const items = snap.items;
    const usedI = new Set();
    const results = {};
    // Verify targets are COLLECTED here and re-read in a SEPARATE bounded pass
    // AFTER all fills — the fill itself is the load-bearing result and must not
    // wait on (or be hung by) the advisory re-read. (BUG-4)
    const toVerify = [];
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
      // Same lenient key + empty-string-is-real rules as fast_fill: accept `text`
      // as an alias for `value`, and use `??` so value:"" is kept (→ clears the
      // field) rather than discarded.
      const value = spec.value ?? spec.text;
      // Missing value (undefined/null, not "") → skip this field with a clear
      // note; NEVER write the literal "undefined". An explicit "" falls through
      // and clears the field.
      if (value == null) { results[match] = { error: "no value provided — use '' to clear", skipped: true }; missed++; if (stopOnError) break; continue; }
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
      const r = fillItem(found, value, append); // fillItem coerces; value is present (may be "")
      results[match] = r;
      const el = elAt(found);
      if (!r.error && isHidden(el)) r.filledButNotVisible = true;
      // DEFER verification — don't re-read inline. Collect the target; the
      // re-read runs in a bounded pass below so a slow/stalled read can never
      // hang the fill loop. (BUG-4)
      if (verify && !r.error) toVerify.push({ match, el, expected: String(value), append });
      if (r.error) { missed++; if (stopOnError) break; }
      else filled++;
    }

    const out = { filled, missed, total: Object.keys(fields).length, results };

    // VERIFY: decoupled + time-bounded (BUG-4). The fills above are DONE and are
    // the load-bearing result. Verification is ADVISORY — it re-reads each filled
    // field to catch an async re-render (e.g. a Drupal AJAX widget) that wiped
    // what we wrote, which would otherwise masquerade as a clean fill. It runs as
    // a SEPARATE pass under its own wall-clock budget and can NEVER hang the call:
    // on overrun or a throwing read it degrades to "filled, not verified"
    // (verifyError set) instead of stalling the action to the 30s tool timeout.
    if (verify) {
      const VERIFY_BUDGET_MS = 2500;
      const vStart = nowMs();
      let verifyTimedOut = false;
      for (const vf of toVerify) {
        if (nowMs() - vStart > VERIFY_BUDGET_MS) { verifyTimedOut = true; break; }
        const r = results[vf.match];
        if (!r) continue;
        try {
          // Native <select>: the fill matched the requested value against option
          // TEXT *or* VALUE (see fillItem), so the .value we store can legitimately
          // differ from the requested text (Country="Australia" → value "AU").
          // Verify against the SELECTED option's text OR value, mirroring that
          // match — comparing raw .value to the requested text falsely flagged a
          // correctly-selected option as reverted. Only a select whose selected
          // option matches NEITHER (genuine reset to placeholder) is reverted.
          const isSelect = (r.kind === 'native-select') || (vf.el && vf.el.tagName === 'SELECT');
          if (isSelect) {
            const opt = vf.el.selectedOptions ? vf.el.selectedOptions[0] : vf.el.options[vf.el.selectedIndex];
            const want = vf.expected.toLowerCase();
            const stuck = !!opt && (
              (opt.text || '').trim().toLowerCase() === want ||
              (opt.value || '').toLowerCase() === want
            );
            r.currentValue = vf.el.value;
            if (!stuck) r.reverted = true;
            r.verified = true;
          } else {
            const current = readValue(vf.el);
            const stuck = vf.append ? (current != null && current.endsWith(vf.expected))
                                    : (current === vf.expected);
            if (!stuck) { r.reverted = true; r.currentValue = current; }
            r.verified = true;
          }
        } catch (e) {
          r.verified = false;
          r.verifyError = (e?.message || String(e)).slice(0, 200);
        }
      }
      if (verifyTimedOut) {
        out.verifyError = 'verify timed out';
        // Fields not yet re-read degrade cleanly to "filled, not verified".
        for (const vf of toVerify) {
          const r = results[vf.match];
          if (r && r.verified === undefined && !('verifyError' in r)) {
            r.verified = false;
            r.verifyError = 'verify timed out';
          }
        }
      }
      out.reverted = Object.entries(results).filter(([, r]) => r && r.reverted).map(([k]) => k);
    }

    // Defensive overall bound (BUG-4): the fill result MUST return well under the
    // 30s tool timeout regardless of how the snapshot tail behaves. withSnap is
    // already self-bounded, but race it against a hard cap so any future stall in
    // the snapshot path degrades to "filled, snapshot skipped" rather than a
    // blind 30s timeout. The fill is non-idempotent — a lost ack must never look
    // like "nothing happened" and provoke a retry.
    const HANDLER_CAP_MS = 8000;
    return await Promise.race([
      withSnap(out, snap),
      new Promise((resolve) => setTimeout(() => resolve({
        ...out,
        snapshotPartial: true,
        snapshotNote: 'snapshot skipped — bounded to keep fast_fill_form responsive',
      }), HANDLER_CAP_MS)),
    ]);
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
