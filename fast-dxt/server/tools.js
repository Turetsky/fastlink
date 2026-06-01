// MCP tool definitions. Edit descriptions/schemas here only.

export const TOOLS = [
  {
    name: 'fast_scout',
    description: 'PREFERRED way to understand and act on the active tab — use this instead of fast_snapshot in most cases. A fast model (Gemini) reads the live page (stable ids, shadow DOM + same-origin iframes) and is pre-warmed on every page load, so the page comprehension is usually already cached when you call. Two modes: (1) NO intent → returns {summary, elements:[{i,purpose}], warmed} — a concise semantic read of the page (a smarter, smaller snapshot). (2) WITH intent → returns {brief, steps:[{name,args}], warmed, needsMoreInfo?} where each step is a runnable fast_* call (use directly or via fast_batch). Prefer passing an intent when you know your goal (e.g. "log in as alice@x.com"). Falls back to fast_snapshot for raw element coords or when you need detail the model omitted. Requires GEMINI_API_KEY on the server (returns {disabled:true} otherwise).',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'Optional. What you want to accomplish on this page, in plain language (e.g. "fill the signup form with name Bob and email bob@x.com and submit"). Omit to just get a semantic read of the page.' },
      },
    },
  },
  {
    name: 'fast_point',
    description: 'VISION coordinate-grounding: locate on-screen target(s) NOT in the DOM (opaque/cross-origin iframes, canvas, custom widgets) by having a fast multimodal model (Gemini) read a screenshot. Returns CSS-pixel centers ready for fast_click_xy → then fast_type to fill. **NEVER hallucinates: a target not clearly visible returns {found:false} (with confidence), never a guessed coordinate — so you can TRUST a returned point without screenshot-verifying it.** If found:false, the element is genuinely off-screen/absent: reopen the menu, or call again with scroll:true. Pass `target` (one) or `targets` (array, one model call — for multi-field forms). Small/dense targets auto crop-zoom refine. Returns {points:[{target,found,xCss,yCss,confidence,refined}]}. Requires GEMINI_API_KEY.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'A single element description, e.g. "the First Name input box".' },
        targets: { type: 'array', items: { type: 'string' }, description: 'Multiple element descriptions, located in one model call. Use for multi-field forms.' },
        refine: { type: 'boolean', description: 'Crop-zoom refine pass for small targets (default true). Set false to force a single coarse pass.' },
        scroll: { type: 'boolean', description: 'OPT-IN auto-scroll: if a target is not visible, wheel-scroll down and re-point (up to 4 passes) to surface it. Default FALSE. Do NOT use when a dropdown/menu/popover is open — scrolling dismisses it; reopen the menu instead. Use for long static forms with fields below the fold.' },
        freshCapture: { type: 'boolean', description: 'Force a new screenshot instead of reusing a recent pre-warmed capture (default false). Use if the page changed since the last navigation pre-warm.' },
      },
    },
  },
  {
    name: 'fast_vision_capture',
    description: 'Low-level: capture the visible tab for the vision tier — returns {dataUrl, imgW, imgH, dpr}, optionally cropped to a CSS-px region and upscaled (the crop-zoom primitive). Most callers want fast_point instead, which orchestrates capture + locate + coordinate conversion.',
    inputSchema: {
      type: 'object',
      properties: {
        crop: { type: 'object', description: 'Optional {x,y,w,h} region in CSS px to crop+zoom into.' },
        zoom: { type: 'number', description: 'Upscale factor for the crop (default 2).' },
      },
    },
  },
  {
    name: 'fast_point_som',
    description: 'VISION locate via SET-OF-MARK (classification, not coordinate regression — typically most reliable for dense/iframe forms). Gemini first DETECTS a bounding box per target, the extension draws a NUMBERED red box on each, then Gemini PICKS the number for each target. The click point is the detected box center, confirmed by the pick. Same output as fast_point: {points:[{target,found,xCss,yCss,n,via}]} → feed xCss/yCss to fast_click_xy then fast_type. Pass `target` or `targets`. Requires GEMINI_API_KEY. Costs ~2 model calls (detect + pick).',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'A single element description.' },
        targets: { type: 'array', items: { type: 'string' }, description: 'Multiple element descriptions in one flow (multi-field forms).' },
      },
    },
  },
  {
    name: 'fast_fill_vision',
    description: 'VISION form-fill in ONE call: fills an entire form server-side, collapsing the per-field point→click→type loop (~15 round-trips) into a single tool call. A fast multimodal model (Gemini) locates ALL fields (and the optional submit button) in ONE vision pass, then each field is focused with a trusted real-mouse click and filled with trusted typing — so React/LWC/canvas/iframe inputs that ignore fast_fill all work. Use for visible on-screen forms, especially non-DOM ones where fast_fill_form can\'t reach. Pass `fields` as { "<field description>": "<value>" } (keys are plain-language descriptions of each input, e.g. "First Name input box"). Optional `submit`: a description of the submit/continue button to click after filling. Returns { filled:[{field,found,value}], missed:[descriptions not located], submitted:bool }. A description in `missed` was not visible — scroll it into view or reopen the relevant section and call again for those. Requires GEMINI_API_KEY.',
    inputSchema: {
      type: 'object',
      properties: {
        fields: { type: 'object', description: 'Map of field description → value to type, e.g. { "First Name input": "Jacob", "Email input": "a@b.com" }. Each key is a plain-language description of the input the vision model should locate.' },
        submit: { type: 'string', description: 'Optional description of the submit/continue button to click after all fields are filled, e.g. "the blue Sign up button". Omit (or null) to fill without submitting.' },
        refine: { type: 'boolean', description: 'Crop-zoom refine pass for small/dense fields to sharpen coordinates (default true). Set false for a single coarse locate pass.' },
        freshCapture: { type: 'boolean', description: 'Force a new screenshot instead of reusing a recent pre-warmed capture (default false).' },
      },
      required: ['fields'],
    },
  },
  {
    name: 'fast_do',
    description: 'EXPERIMENTAL most-aggressive tier: give ONE plain-language INTENT and a whole form is filled/operated in a SINGLE call — a fast multimodal model (Gemini) does BOTH the task DECOMPOSITION and the element LOCATION, removing the per-field LLM loop entirely. Flow: capture one screenshot → ONE Gemini call decomposes the intent into ordered steps ({action,target,value}) AND describes each target → ONE Gemini vision call locates all targets → each step is executed server-side (trusted click, then trusted type for text; key presses for keys). Differs from fast_fill_vision: there YOU supply the field→value map and Gemini only locates; here Gemini infers the entire plan from the intent + what it sees. SAFETY: it will NOT click a final submit/create/save/delete/confirm button — it stops with the form filled — UNLESS your intent explicitly says to submit/create/save it. Steps whose target is not visible are skipped and reported. Returns { plan, executed:[...], skipped:[...], stoppedBefore:[...], note }. Use for visible on-screen forms; pass a specific intent naming the field values, e.g. "fill the API key form: name it \'My Key\', restrict it to the Geocoding API". Requires GEMINI_API_KEY.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'The plain-language goal for the form on screen, naming the concrete values, e.g. "set Name to Jacob, Email to a@b.com, Country to US". Do NOT include "and submit"/"create" unless you actually want it committed — by default fast_do fills and stops before any submit/create/delete button.' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'fast_locate',
    description: 'Locate an element by racing the DOM and vision tiers concurrently; returns the fastest usable hit. Best on mixed/unknown pages — DOM wins on simple pages, vision wins (and DOM can\'t stall it) on heavy SPAs like GCP. Fires fast_snapshot text-matching AND a Gemini vision point at the same time; whichever yields a usable coordinate first wins, the loser is ignored. A hung/crashing DOM snapshot can NEVER block the vision answer (DOM tier is wrapped + 3s timeout). Returns { via:"dom"|"vision"|null, xCss, yCss, found, target } — feed xCss/yCss to fast_click_xy (then fast_type to fill). Requires GEMINI_API_KEY.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Plain-language description of the element to locate, e.g. "the Create button" or "the Email input box".' },
        refine: { type: 'boolean', description: 'Crop-zoom refine pass for small targets on the vision tier (default true).' },
        freshCapture: { type: 'boolean', description: 'Force the vision tier to take a new screenshot instead of reusing a recent pre-warmed one (default false).' },
      },
      required: ['target'],
    },
  },
  {
    name: 'fast_annotate_boxes',
    description: 'Low-level: capture the viewport and draw numbered red boxes at the given CSS-px boxes [{n,x,y,w,h}], returning {dataUrl,dpr}. The Set-of-Mark primitive behind fast_point_som; most callers want fast_point_som.',
    inputSchema: {
      type: 'object',
      properties: {
        boxes: { type: 'array', description: 'Boxes to draw, each {n (label number), x, y, w, h} in CSS px.', items: { type: 'object' } },
      },
      required: ['boxes'],
    },
  },
  {
    name: 'fast_status',
    description: 'Report whether the Chrome extension is connected to this MCP server, and connection diagnostics. Call this first if other tools fail with "extension not connected".',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'fast_prewarm',
    description: 'Turn ON background pre-warming for the next ~60s. While active, each page navigation triggers a silent scout + vision pre-pass (cached snapshot/visual map) so the FIRST fast_scout / fast_point / fast_fill_vision on a freshly-loaded page is near-instant. Pre-warming NEVER starts on its own — call this once when you are about to do a burst of page-driving work. Any subsequent tool call extends the window; it shuts off automatically 60s after your last tool. No browser action is taken — this only arms the warmer.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'fast_snapshot',
    description: 'Snapshot of the active Chrome tab. Returns TWO arrays: `items` (clickable elements with text, coords, href, tag, role, label, name) AND `content` (block-level readable text — headings, paragraphs, list items, table cells, dashboard stats — with coords). Walks open shadow roots AND same-origin iframes (Google OAuth/billing flows), with coords reported in outer-page space. Resolves aria-labelledby / aria-describedby (multi-id refs supported), so Angular Material / cfc-select and other web-component design systems show up with their visible label rather than a blank "name". Items inside iframes have `inFrame: true`. Content excludes text already represented in items (exact-match dedup) and only emits deepest-level text containers to avoid parent/child duplication. Pass screenshot:true to also get a visual. **Pass overlay:true when a dropdown/menu/popover is open but its items are missing from a normal snapshot** — it additionally sweeps portaled overlay containers (Radix menus, react-select/Downshift/MUI menus, Angular cdk-overlay, any [role=menu]/[role=listbox]) and tags those items `inOverlay:true`. This is the escalation rung below a screenshot for transient popover UI.',
    inputSchema: {
      type: 'object',
      properties: {
        viewport: { type: 'boolean', description: 'If true, only return elements currently visible in the viewport (excludes off-screen). Faster on long pages.' },
        overlay: { type: 'boolean', description: 'If true, also scan known portal/popover containers (Radix, react-select, Downshift, MUI, cdk-overlay, [role=menu]/[role=listbox]) and include their interactive items tagged `inOverlay:true`. Use when a menu/dropdown is open but its options are missing from a normal snapshot (they portal to <body> and/or race the snapshot). Opt-in so the default snapshot stays fast.' },
        screenshot: { type: 'boolean', description: 'If true, also capture a screenshot of the visible tab and return its /tmp path alongside the snapshot.' },
        screenshotFormat: { type: 'string', enum: ['png', 'jpeg'], description: 'Format for the inline screenshot (default png).' },
      },
    },
  },
  {
    name: 'fast_click',
    description: 'Click an element matching text/label/aria-label/placeholder. Matches are auto-ranked so visible-content matches beat aria-label matches, which beat tooltip-only (title) matches — the right button usually wins on its own. When that\'s not enough, narrow with role (e.g. "menuitem", "option", "button") or tag (e.g. "mat-option", "a"), or use index to pick the N-th match (0-based). On a miss, the response includes diagnostics explaining why (hidden, behind aria-hidden, non-interactive, off-screen, cross-origin iframe, etc.) — read them before retrying. **Returns include a fresh `snapshot` of the post-click viewport (items + content) so you can chain decisions without a separate fast_snapshot call. Opt out with noSnapshot:true.** Pass screenshot:true to also get a post-click visual.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text content / label / aria-label / placeholder substring (case-insensitive)' },
        role: { type: 'string', description: 'Restrict to elements whose [role] attribute equals this (e.g. "menuitem", "option", "button", "tab"). Use when text alone matches the wrong element.' },
        tag: { type: 'string', description: 'Restrict to elements whose HTML tag equals this (lowercase, e.g. "a", "button", "mat-option"). Use for design-system custom elements.' },
        index: { type: 'number', description: 'Pick the N-th match (0-based) after ranking. Use when first match is still wrong.' },
        screenshot: { type: 'boolean', description: 'If true, capture a screenshot after clicking and return its /tmp path in the result.' },
        screenshotFormat: { type: 'string', enum: ['png', 'jpeg'], description: 'Format for the inline screenshot (default png).' },
      },
      required: ['text'],
    },
  },
  {
    name: 'fast_fill',
    description: 'Fill input/textarea/contenteditable by label/placeholder/name. Replaces existing value by default; pass append: true to keep and add to existing. Returns include a fresh `snapshot` of the post-fill viewport (opt out with noSnapshot:true).',
    inputSchema: {
      type: 'object',
      properties: {
        match: { type: 'string', description: 'Placeholder/label/name/aria-label/text substring to match the field' },
        value: { type: 'string', description: 'Value to fill in' },
        append: { type: 'boolean', description: 'If true, append to existing value instead of replacing' },
      },
      required: ['match', 'value'],
    },
  },
  {
    name: 'fast_tab',
    description: 'Open a new Chrome tab at the given URL. Returns the new tab id and URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open' },
        background: { type: 'boolean', description: 'If true, do not switch to the new tab. Defaults to false (focus the new tab).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'fast_nav',
    description: 'Navigate the active Chrome tab to a URL. Waits for the load to complete (up to waitMs, default 10000) before returning — override with waitMs to wait longer for slow pages or shorter to return early. Then returns `contentScript`: "fresh" (the page.js content script was already live), "reinjected" (it was stale/missing — common after the extension was reloaded — so FastLink re-injected it), or "stale" (still not live, e.g. a restricted chrome:// URL; subsequent snapshot/click may fail — try fast_reload).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        waitMs: { type: 'number', description: 'Max ms to wait for the load to complete (default 10000).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'fast_reload',
    description: 'Reload the active Chrome tab (bypassing cache) and wait for the load to finish. Use this to recover when snapshot returns empty, networkIdle falsely reports idle, or a screenshot readback fails — symptoms of a stale/missing content script after the extension was reloaded.',
    inputSchema: {
      type: 'object',
      properties: {
        waitMs: { type: 'number', description: 'Max ms to wait for the reload to complete (default 10000).' },
      },
    },
  },
  {
    name: 'fast_list',
    description: 'List all open tabs in the current Chrome window with id, url, title, and active state.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'fast_switch',
    description: 'Switch focus to a specific Chrome tab. Pass either a tabId (from fast_list) or a match (case-insensitive substring of URL or title). After switching, fast_snapshot/fast_click/fast_fill operate on this tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab id from fast_list' },
        match: { type: 'string', description: 'URL or title substring to match' },
      },
    },
  },
  {
    name: 'fast_wait',
    description: 'Wait for the page to reach a state. Two modes: (1) pass `text` to wait for a substring to appear in the DOM (after a dialog/SPA view mounts). (2) pass `networkIdle: true` to wait until all in-flight network requests settle for `idleMs` (default 500ms) — useful in SPA flows where you don\'t know what element to look for, just that the page is done loading. On a text-mode match it returns `{ found: { i, tag, text, x, y, w, h, ... }, snapshot: { items, content } }` — the matched element PLUS a fresh snapshot of the now-settled view, so you can chain off it without a separate fast_snapshot (opt out with noSnapshot:true; the snapshot is bounded and non-fatal). networkIdle mode returns `{ idle: true, ... }` with no snapshot. On text timeout the result also includes `headings: [...]` — the first several visible h1/h2/h3/[role=heading] texts on the current view, so you can tell if you landed on the wrong page without spending a separate snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to wait for (case-insensitive substring match). Ignored if networkIdle is true.' },
        networkIdle: { type: 'boolean', description: 'If true, wait for the network to go quiet for idleMs instead of matching text.' },
        idleMs: { type: 'number', description: 'Required quiet duration in ms for networkIdle mode (default 500).' },
        timeoutMs: { type: 'number', description: 'Max total wait in ms (default 5000 for text, 10000 for networkIdle).' },
        noSnapshot: { type: 'boolean', description: 'If true, skip the post-match snapshot in text mode (return just `found`).' },
      },
    },
  },
  {
    name: 'fast_evaluate',
    description: 'Escape hatch: run arbitrary JavaScript in the active Chrome tab (MAIN world, full DOM access). Pass a function declaration as a string. Function may be async. Optionally pass args array to be spread into the function. Return value is JSON-serialized. Runs via Chrome DevTools Protocol so strict CSP / Trusted Types pages (Google Cloud Console, claude.ai, GitHub Enterprise) work; a yellow "FastLink started debugging this browser" banner will appear while it runs. Falls back to in-page eval if the debugger can\'t attach.',
    inputSchema: {
      type: 'object',
      properties: {
        fn: { type: 'string', description: 'JS function declaration, e.g. (id) => document.getElementById(id)?.value' },
        args: { type: 'array', description: 'Arguments to pass to the function (avoid string interpolation pitfalls)', items: {} },
      },
      required: ['fn'],
    },
  },
  {
    name: 'fast_text',
    description: 'Read text (or HTML) from the active Chrome tab. CSP-safe: works on pages where fast_evaluate is blocked (claude.ai, strict CSP). Defaults to body innerText. Pass selector for a specific element.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector to extract from (default: document.body)' },
        html: { type: 'boolean', description: 'If true, return outerHTML instead of innerText (default false)' },
        maxLen: { type: 'number', description: 'Optional max characters to return; truncates with truncated:true flag' },
      },
    },
  },
  {
    name: 'fast_select_option',
    description: 'Pick an option from a dropdown/combobox/select. Handles native <select>, react-select, Angular Material / cfc-select / mat-option, ARIA comboboxes, and generic dropdowns. Field lookup walks shadow DOM and resolves aria-labelledby across shadow boundaries — so "Industry" finds a cfc-select labelled by a separate <div id="industry-label">. Match priority for options: exact text > startsWith > substring. Returns include a fresh `snapshot` of the post-selection viewport (opt out with noSnapshot:true).',
    inputSchema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Field identifier — label text, aria-label, name, or id (case-insensitive)' },
        option: { type: 'string', description: 'Option text to select (case-insensitive). Exact match preferred.' },
      },
      required: ['field', 'option'],
    },
  },
  {
    name: 'fast_screenshot',
    description: 'Capture a screenshot of the active Chrome tab. Saves as PNG to /tmp/ and returns the file path. Use Read on the path to view the image.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default png)' },
        quality: { type: 'number', description: 'JPEG quality 0-100 (default 90, ignored for PNG)' },
      },
    },
  },
  {
    name: 'fast_marks',
    description: 'Annotated screenshot: draws numbered boxes (the element\'s id) over visible interactive elements and returns the image + an id→center-coords map, for visually locating an element when DOM matching fails. Each box is labelled with the element\'s snapshot id, so the number the model picks maps straight back to that ref. Returns { dataUrl (annotated PNG), marks: [{ i, cx, cy }] (cx/cy = element center in viewport CSS px, ready for fast_click_xy), dpr, truncated }. Capped at ~40 boxes (truncated:true when there are more). Pass `only` (array of element ids) to mark just those.',
    inputSchema: {
      type: 'object',
      properties: {
        only: {
          type: 'array',
          description: 'Optional array of element ids (from a snapshot) to mark. Omit to mark all visible interactive elements (capped at ~40).',
          items: { type: 'number' },
        },
      },
    },
  },
  {
    name: 'fast_key_press',
    description: 'Press a single key on the active tab. Common keys: Enter, Escape, Tab, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Backspace, Delete. Useful for submitting forms, dismissing modals, or navigating dropdowns. For shortcuts WITH modifiers (Ctrl+A, Cmd+C, Shift+Tab), use fast_key instead.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Key name (e.g. "Enter", "Escape", "ArrowDown")' } },
      required: ['key'],
    },
  },
  {
    name: 'fast_key',
    description: 'Trusted keyboard chord via the CDP Input domain — fires REAL key events with modifiers, so shortcuts like Ctrl+A, Cmd+C, Cmd+V, Shift+Tab actually work (unlike injected key events the page may ignore). Goes to the currently-focused element; focus first (e.g. fast_click / fast_click_xy) if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key to press, e.g. "a", "c", "Enter", "ArrowDown". Single letters/digits or a named key.' },
        modifiers: {
          type: 'array',
          description: 'Modifier keys held during the press. Any of: "ctrl", "cmd"/"meta", "shift", "alt". E.g. ["ctrl"] for Ctrl+A, ["meta"] for Cmd+C.',
          items: { type: 'string' },
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'fast_scroll',
    description: 'Scroll the active tab. Auto-detects the right scroll container (handles nested scrollers like claude.ai chat, not just window). Pass "to" (top|bottom|"50%") or "pixels" (delta, positive=down). Optional selector to target a specific scroller. Returns include a fresh `snapshot` of the post-scroll viewport (opt out with noSnapshot:true).',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'top, bottom, or a percentage like "50%"' },
        pixels: { type: 'number', description: 'Pixels to scroll (positive=down, negative=up)' },
        selector: { type: 'string', description: 'Optional CSS selector for the scroll container. If omitted, auto-detects by walking up from viewport center, then falling back to the largest scrollable element.' },
      },
    },
  },
  {
    name: 'fast_close',
    description: 'Close a Chrome tab by id (from fast_list) or by URL/title substring match.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        match: { type: 'string', description: 'URL or title substring' },
      },
    },
  },
  {
    name: 'fast_batch',
    description: 'Run multiple FastLink actions in sequence with ONE tool call. Each action runs only if the previous succeeded (set continueOnError to override). Cuts LLM round-trips when you know the full sequence in advance (e.g. navigate → wait → fill → click).',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: 'Array of {name, args} objects. name is any fast_* tool name (except fast_batch).',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, args: { type: 'object' } },
            required: ['name'],
          },
        },
        continueOnError: { type: 'boolean', description: 'If true, keep running after a step errors (default false: stop on first error)' },
      },
      required: ['actions'],
    },
  },
  {
    name: 'fast_console',
    description: 'Read recent console messages (log/warn/error/info) from the active Chrome tab. Captures messages from the moment the page loaded. Useful for debugging errors after a click or to see app state.',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['log', 'warn', 'error', 'info', 'all'], description: 'Filter by level (default all)' },
        limit: { type: 'number', description: 'Max messages to return (default 50, newest first)' },
        clear: { type: 'boolean', description: 'If true, clear the buffer after returning' },
      },
    },
  },
  {
    name: 'fast_network',
    description: 'List recent network requests from the active Chrome tab (URL, method, status, type, duration). Useful for inspecting API calls a page makes, debugging failures, or seeing what data drives a UI. Pass responseBody:true to also include captured response bodies (text/JSON) from fetch/XHR — so e.g. a Google Maps "REQUEST_DENIED" error message comes back in one call, no need to re-fetch via fast_evaluate.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional URL substring to filter by' },
        status: { type: 'string', enum: ['all', 'failed', 'ok'], description: 'Filter by status (failed=4xx/5xx/error, ok=2xx/3xx, default all)' },
        limit: { type: 'number', description: 'Max requests to return (default 50, newest first)' },
        clear: { type: 'boolean', description: 'If true, clear the buffer after returning' },
        responseBody: { type: 'boolean', description: 'If true, include captured response bodies for fetch/XHR requests (binary/non-text response types return null body). Bodies are matched by URL + timestamp.' },
        maxBodyBytes: { type: 'number', description: 'Truncate each returned body to at most this many characters (default 16384). Item gets bodyTruncated:true when trimmed.' },
      },
    },
  },
  {
    name: 'fast_hover',
    description: 'Hover over an element matching text/label/aria-label/placeholder. Fires mouseenter/mouseover/mousemove. Useful for triggering tooltips, hover-only menus, lazy hover-loaded content. Returns include a fresh `snapshot` of the post-hover viewport — useful for capturing tooltips/menus that appeared (opt out with noSnapshot:true).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text/label/aria-label/placeholder substring (case-insensitive)' },
        index: { type: 'number', description: 'Pick the N-th match (0-based) when text is ambiguous' },
      },
      required: ['text'],
    },
  },
  {
    name: 'fast_drag',
    description: 'Drag from one element to another (or to coordinates). Synthesizes mousedown→mousemove(s)→mouseup, which works for sliders, sortable lists, canvas drawing, and most JS-handled drag UIs. May NOT trigger native HTML5 drag-and-drop handlers (those listen to DragEvent — different protocol). Returns include a fresh `snapshot` of the post-drag viewport (opt out with noSnapshot:true).',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Text/label substring matching the source element' },
        fromIndex: { type: 'number', description: 'Pick the N-th from-match (0-based)' },
        to: { type: 'string', description: 'Text/label substring matching the target element (use this OR toX+toY)' },
        toIndex: { type: 'number', description: 'Pick the N-th to-match (0-based)' },
        toX: { type: 'number', description: 'Target X coordinate (use with toY instead of "to")' },
        toY: { type: 'number', description: 'Target Y coordinate (use with toX instead of "to")' },
      },
      required: ['from'],
    },
  },
  {
    name: 'fast_fill_form',
    description: 'Fill multiple fields in one call (saves N round-trips for large forms). Pass a { fields } object where keys are label/placeholder/name/aria-label substrings and values are the strings to fill. A field value may instead be an object { value, name, index, exact } to disambiguate collisions: `name` (or `exact:true`) matches the input\'s exact `name` attribute instead of a substring, and `index` (0-based) picks the N-th matching field when labels/names repeat (e.g. two product slots). Returns a per-field results map showing which were filled and which were not found, plus a fresh `snapshot` of the post-fill viewport (opt out with noSnapshot:true). A field filled while not visible (display:none/no offsetParent) but still submittable is flagged `filledButNotVisible:true`. With verify:true, each field is re-read after filling and any whose value reverted (e.g. wiped by an async AJAX re-render) is flagged `reverted:true` with its `currentValue`, and a top-level `reverted` array lists their keys.',
    inputSchema: {
      type: 'object',
      properties: {
        fields: { type: 'object', description: 'Map of match-string → value, e.g. { "email": "...", "phone number": "...", "country": "US" }. Each key is matched case-insensitively against label/placeholder/name/aria-label. A value may also be an object { value, name, index, exact }: `name` matches the field\'s exact `name` attribute, `exact:true` matches the key as an exact name, and `index` (0-based) selects which of multiple matches to fill.' },
        append: { type: 'boolean', description: 'If true, append to existing field values instead of replacing.' },
        stopOnError: { type: 'boolean', description: 'If true, stop on the first missing/failed field. Default: keep going so you see all misses at once.' },
        verify: { type: 'boolean', description: 'If true, re-read each field after filling and flag any whose value did not stick (reverted by an async re-render) as reverted:true, plus a top-level `reverted` array of their keys.' },
      },
      required: ['fields'],
    },
  },
  {
    name: 'fast_network_replay',
    description: 'Re-fire a request from the active tab\'s page context, so the page\'s cookies/auth are sent automatically (no manual header copy). Useful for inspecting an API response you saw in fast_network but couldn\'t see the body of, or for poking at an endpoint with different params. Pass url + optional method/headers/body.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to fetch (typically copied from a fast_network result).' },
        method: { type: 'string', description: 'HTTP method (default GET).' },
        headers: { type: 'object', description: 'Optional headers map to add to the request.' },
        body: { description: 'Optional request body (string, or object — objects are JSON.stringified).' },
        maxBodyBytes: { type: 'number', description: 'Truncate the returned body to this many chars (default 16384).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'fast_macro_save',
    description: 'Save a named multi-step recipe (e.g. "login flow", "navigate to Credentials") so you can replay it with fast_macro_run later. Steps are arbitrary fast_* tool calls. Persisted in chrome.storage.local — survives across browser sessions on this machine.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Macro name (used as the key).' },
        description: { type: 'string', description: 'Optional human description shown in fast_macro_list.' },
        actions: {
          type: 'array',
          description: 'Ordered list of steps. Each is {name, args} where name is any fast_* tool except the macro tools themselves.',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, args: { type: 'object' } },
            required: ['name'],
          },
        },
      },
      required: ['name', 'actions'],
    },
  },
  {
    name: 'fast_macro_list',
    description: 'List all saved macros (name, step count, description, savedAt). Most-recently-saved first.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'fast_macro_run',
    description: 'Run a previously saved macro by name. Stops on the first failing step unless continueOnError is set. Returns per-step results.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Macro name (from fast_macro_save / fast_macro_list).' },
        continueOnError: { type: 'boolean', description: 'If true, keep running after a step errors. Default false.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'fast_macro_delete',
    description: 'Delete a saved macro by name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Macro name to delete.' } },
      required: ['name'],
    },
  },
  {
    name: 'fast_click_xy',
    description: 'Trusted click at a pixel via the CDP Input domain (a REAL mouse event, isTrusted:true) — unlike fast_click\'s injected JS, LWC/React widgets honor it and it can focus an iframe input with no DOM reach-in. Coordinates are TOP-LEVEL VIEWPORT CSS pixels: if the target lives inside an iframe, add the iframe\'s page offset to its in-iframe getBoundingClientRect before passing (a same-origin frame\'s offset is its own frameElement.getBoundingClientRect on the parent page). Playbook for stubborn React/iframe fields: read the field\'s rect via fast_evaluate (getBoundingClientRect, use its center x/y), fast_click_xy there to focus it (trusted), then fast_type to enter text.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Top-level viewport X in CSS pixels (left edge = 0).' },
        y: { type: 'number', description: 'Top-level viewport Y in CSS pixels (top edge = 0).' },
        button: { type: 'string', description: 'Mouse button: "left" (default), "right" (context menu), or "middle".' },
        clickCount: { type: 'number', description: 'Number of clicks: 1 (default), 2 for double-click (select word / open), 3 for triple.' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'fast_wheel',
    description: 'Trusted mouse-wheel scroll at a point via the CDP Input domain — a REAL wheel event, so canvas/WebGL views and virtualized lists that ignore programmatic scrollTop (which fast_scroll uses) actually scroll. Coordinates are top-level viewport CSS pixels (the point the wheel is over).',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Viewport X the wheel is over (CSS px).' },
        y: { type: 'number', description: 'Viewport Y the wheel is over (CSS px).' },
        deltaY: { type: 'number', description: 'Vertical scroll amount in px (positive = down).' },
        deltaX: { type: 'number', description: 'Horizontal scroll amount in px (positive = right).' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'fast_drag_xy',
    description: 'Trusted drag via the CDP Input domain — real mousePressed → mouseMoved(s) → mouseReleased, so native HTML5 drag-and-drop, sliders, and sortable lists that ignore synthetic events work (unlike fast_drag, which dispatches injected events). All coords are top-level viewport CSS pixels; for in-frame targets add the iframe page offset to the in-iframe getBoundingClientRect.',
    inputSchema: {
      type: 'object',
      properties: {
        fromX: { type: 'number', description: 'Start X (viewport CSS px).' },
        fromY: { type: 'number', description: 'Start Y (viewport CSS px).' },
        toX: { type: 'number', description: 'End X (viewport CSS px).' },
        toY: { type: 'number', description: 'End Y (viewport CSS px).' },
        steps: { type: 'number', description: 'Intermediate move events (default 10); more = smoother for sliders.' },
      },
      required: ['fromX', 'fromY', 'toX', 'toY'],
    },
  },
  {
    name: 'fast_type',
    description: 'Trusted typing into whatever element currently has focus, via CDP Input.insertText — React/LWC accept it because it\'s a real input event (unlike setting .value). Does NOT target a selector; it goes to the focused element, so focus first (e.g. fast_click_xy on the field\'s coordinates). Pairs with fast_click_xy: read field coords via fast_evaluate getBoundingClientRect, fast_click_xy to focus, then fast_type to enter the text.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to insert into the currently-focused element.' },
      },
      required: ['text'],
    },
  },
];
