// MCP tool definitions. Edit descriptions/schemas here only.

export const TOOLS = [
  {
    name: 'fast_status',
    description: 'Report whether the Chrome extension is connected to this MCP server, and connection diagnostics. Call this first if other tools fail with "extension not connected".',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'fast_snapshot',
    description: 'Snapshot of clickable elements on the active Chrome tab (text, coords, href, tag, role, label, name). Walks open shadow roots AND same-origin iframes (Google OAuth/billing flows), with coords reported in outer-page space. Resolves aria-labelledby / aria-describedby (multi-id refs supported), so Angular Material / cfc-select and other web-component design systems show up with their visible label rather than a blank "name". Items inside iframes have `inFrame: true`. Pass screenshot:true to also get a visual — much faster than re-parsing innerHTML to check if a dialog mounted / dropdown opened.',
    inputSchema: {
      type: 'object',
      properties: {
        viewport: { type: 'boolean', description: 'If true, only return elements currently visible in the viewport (excludes off-screen). Faster on long pages.' },
        screenshot: { type: 'boolean', description: 'If true, also capture a screenshot of the visible tab and return its /tmp path alongside the snapshot.' },
        screenshotFormat: { type: 'string', enum: ['png', 'jpeg'], description: 'Format for the inline screenshot (default png).' },
      },
    },
  },
  {
    name: 'fast_click',
    description: 'Click an element matching text/label/aria-label/placeholder. Matches are auto-ranked so visible-content matches beat aria-label matches, which beat tooltip-only (title) matches — the right button usually wins on its own. When that\'s not enough, narrow with role (e.g. "menuitem", "option", "button") or tag (e.g. "mat-option", "a"), or use index to pick the N-th match (0-based). On a miss, the response includes diagnostics explaining why (hidden, behind aria-hidden, non-interactive, off-screen, cross-origin iframe, etc.) — read them before retrying. Pass screenshot:true to also get a post-click visual.',
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
    description: 'Fill input/textarea/contenteditable by label/placeholder/name. Replaces existing value by default; pass append: true to keep and add to existing.',
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
    description: 'Navigate the active Chrome tab to a URL.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to navigate to' } }, required: ['url'] },
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
    description: 'Wait for the page to reach a state. Two modes: (1) pass `text` to wait for a substring to appear in the DOM (after a dialog/SPA view mounts). (2) pass `networkIdle: true` to wait until all in-flight network requests settle for `idleMs` (default 500ms) — useful in SPA flows where you don\'t know what element to look for, just that the page is done loading.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to wait for (case-insensitive substring match). Ignored if networkIdle is true.' },
        networkIdle: { type: 'boolean', description: 'If true, wait for the network to go quiet for idleMs instead of matching text.' },
        idleMs: { type: 'number', description: 'Required quiet duration in ms for networkIdle mode (default 500).' },
        timeoutMs: { type: 'number', description: 'Max total wait in ms (default 5000 for text, 10000 for networkIdle).' },
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
    description: 'Pick an option from a dropdown/combobox/select. Handles native <select>, react-select, Angular Material / cfc-select / mat-option, ARIA comboboxes, and generic dropdowns. Field lookup walks shadow DOM and resolves aria-labelledby across shadow boundaries — so "Industry" finds a cfc-select labelled by a separate <div id="industry-label">. Match priority for options: exact text > startsWith > substring.',
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
    name: 'fast_key_press',
    description: 'Press a single key on the active tab. Common keys: Enter, Escape, Tab, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Backspace, Delete. Useful for submitting forms, dismissing modals, or navigating dropdowns.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Key name (e.g. "Enter", "Escape", "ArrowDown")' } },
      required: ['key'],
    },
  },
  {
    name: 'fast_scroll',
    description: 'Scroll the active tab. Auto-detects the right scroll container (handles nested scrollers like claude.ai chat, not just window). Pass "to" (top|bottom|"50%") or "pixels" (delta, positive=down). Optional selector to target a specific scroller.',
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
    description: 'Hover over an element matching text/label/aria-label/placeholder. Fires mouseenter/mouseover/mousemove. Useful for triggering tooltips, hover-only menus, lazy hover-loaded content.',
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
    description: 'Drag from one element to another (or to coordinates). Synthesizes mousedown→mousemove(s)→mouseup, which works for sliders, sortable lists, canvas drawing, and most JS-handled drag UIs. May NOT trigger native HTML5 drag-and-drop handlers (those listen to DragEvent — different protocol).',
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
    description: 'Fill multiple fields in one call (saves N round-trips for large forms). Pass a { fields } object where keys are label/placeholder/name/aria-label substrings and values are the strings to fill. Returns a per-field results map showing which were filled and which were not found.',
    inputSchema: {
      type: 'object',
      properties: {
        fields: { type: 'object', description: 'Map of match-string → value, e.g. { "email": "...", "phone number": "...", "country": "US" }. Each key is matched case-insensitively against label/placeholder/name/aria-label.' },
        append: { type: 'boolean', description: 'If true, append to existing field values instead of replacing.' },
        stopOnError: { type: 'boolean', description: 'If true, stop on the first missing/failed field. Default: keep going so you see all misses at once.' },
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
];
