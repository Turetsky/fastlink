import { getInjectableTab, injectInTab } from '../util.js';

const CDP_VERSION = '1.3';

// Persistent CDP attachment. PREVIOUSLY every trusted action attached the
// debugger and detached in finally — which made the yellow "FastLink is
// debugging this browser" banner APPEAR during a click and DISAPPEAR after.
// That banner shifts the page viewport down ~35px, so a coordinate computed
// from a screenshot (banner absent) lands ~35px too high when the click attaches
// (banner present). Keeping the debugger attached across calls means the banner
// state never changes between screenshot and click → coordinates stay accurate.
// We attach once per tab and leave it; it auto-cleans on tab close / detach.
const attached = new Set(); // tabIds we currently hold a debugger session on

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, CDP_VERSION);
  attached.add(tabId);
}

// Drop our bookkeeping if Chrome detaches us (tab closed, devtools opened, etc.)
try {
  chrome.debugger.onDetach.addListener((source) => {
    if (source && source.tabId != null) attached.delete(source.tabId);
  });
} catch {}

// `debugger` MUST stay a REQUIRED manifest permission (MV3 rejects it as
// optional), so "Advanced control" is now a SOFT runtime toggle: the
// chrome.storage.local `advancedControl` flag (default ON when unset — the
// permission is granted, so the capability is available unless the user
// explicitly turns it off in the popup/options). Every CDP path — coordinate
// input (click_xy/type/key/wheel/drag_xy), fast_evaluate, and background-tab /
// GPU-fallback capture — funnels through cdp(), so this single guard makes the
// whole debugger surface degrade gracefully when the flag is OFF: a clear,
// actionable error instead of acting. DOM actions (snapshot, selector
// click/fill) use chrome.scripting and never reach here, and the capture tools'
// chrome.tabs.captureVisibleTab fallback is NOT gated (it's not CDP).
const ADVANCED_CONTROL_KEY = 'advancedControl';
async function ensureAdvancedControl() {
  let on = true; // default ON when the flag is unset
  try {
    const o = await chrome.storage.local.get(ADVANCED_CONTROL_KEY);
    if (o && o[ADVANCED_CONTROL_KEY] === false) on = false;
  } catch {}
  if (!on) {
    const e = new Error(
      'Advanced control is OFF — enable it in the FastLink popup/options to use coordinate ' +
      'clicks/typing, scripts, and background-tab capture. DOM-based clicking and form-filling work without it.'
    );
    e.code = 'advanced_control_off';
    throw e;
  }
}

// Send a CDP command on the persistent session (attach lazily, do NOT detach).
// Exported so other actions (e.g. fast_evaluate) share ONE debugger session —
// critical: a separate attach/detach per call toggles the "debugging Chrome"
// banner, which shifts the viewport ~35-50px and makes coordinate clicks miss.
export async function cdp(tabId, method, params) {
  await ensureAdvancedControl();
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

// Trusted click at a TOP-LEVEL viewport pixel via the CDP Input domain.
// Unlike injected JS .click() (isTrusted:false), this lands a real mouse event
// that LWC/React honor and that can focus an iframe input without DOM reach-in.
export async function clickXY({ x, y, button, clickCount }) {
  // Guard the coords: missing/NaN x|y would dispatch a mouse event at
  // (undefined, undefined) — CDP coerces it to (0,0) and "clicks" the top-left
  // corner, a SILENT no-op for the intended target (and it would never focus the
  // input the read-coords→click→fast_type playbook depends on). Fail loudly.
  if (typeof x !== 'number' || typeof y !== 'number' || Number.isNaN(x) || Number.isNaN(y)) {
    return { error: 'fast_click_xy: x and y must be numbers (viewport CSS pixels)' };
  }
  const got = await getInjectableTab();
  if (got.error) return got;
  const tabId = got.tab.id;
  const btn = button || 'left';
  // CDP `buttons` is a bitmask (left=1, right=2, middle=4) and must agree with
  // the named button, or right/middle clicks misfire.
  const mask = btn === 'right' ? 2 : btn === 'middle' ? 4 : 1;
  const count = Math.max(1, clickCount || 1);
  // Escalating clickCount (1,2,…) is how CDP signals double/triple-click.
  for (let i = 1; i <= count; i++) {
    const base = { x, y, button: btn, clickCount: i, buttons: mask };
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
  }
  return { clickedAt: { x, y }, button: btn, clickCount: count };
}

// Trusted mouse-wheel scroll at a point via CDP — real wheel events that
// canvas/virtualized lists (which ignore scrollTop) actually honor.
export async function wheelScroll({ x, y, deltaX, deltaY }) {
  const got = await getInjectableTab();
  if (got.error) return got;
  await cdp(got.tab.id, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: x || 0, y: y || 0, deltaX: deltaX || 0, deltaY: deltaY || 0,
  });
  return { wheeled: { deltaX: deltaX || 0, deltaY: deltaY || 0, at: { x: x || 0, y: y || 0 } } };
}

// Trusted drag via CDP — real press → moves → release, so HTML5 drag-and-drop,
// sliders, and sortable lists that ignore synthetic events work. Coords are
// top-level viewport CSS pixels (add iframe offset for in-frame targets).
export async function dragXY({ fromX, fromY, toX, toY, steps }) {
  if ([fromX, fromY, toX, toY].some((v) => typeof v !== 'number')) {
    return { error: 'fromX, fromY, toX, toY are all required numbers' };
  }
  const got = await getInjectableTab();
  if (got.error) return got;
  const tabId = got.tab.id;
  const n = Math.max(1, steps || 10);
  const send = (type, extra) => cdp(tabId, 'Input.dispatchMouseEvent', { type, ...extra });
  await send('mousePressed', { x: fromX, y: fromY, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= n; i++) {
    const x = fromX + (toX - fromX) * (i / n);
    const y = fromY + (toY - fromY) * (i / n);
    await send('mouseMoved', { x, y, button: 'left', buttons: 1 });
  }
  await send('mouseReleased', { x: toX, y: toY, button: 'left', buttons: 0, clickCount: 1 });
  return { dragged: { from: [fromX, fromY], to: [toX, toY] } };
}

// Runs in the page MAIN world: describe the focused element so we can (a) refuse
// to type when nothing editable is focused and (b) echo back what received the
// text. Self-contained (no closures) — chrome.scripting serializes it.
function inspectActiveElement() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const tag = (el.tagName || '').toLowerCase();
  const NON_TEXT = ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden'];
  const editable =
    (tag === 'input' && !NON_TEXT.includes((el.type || 'text').toLowerCase())) ||
    tag === 'textarea' ||
    el.isContentEditable === true;
  let label = '';
  try {
    label = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('name') ||
      el.getAttribute('placeholder') || el.id)) || '';
  } catch {}
  let value = '';
  if (tag === 'input' || tag === 'textarea') value = el.value || '';
  else if (el.isContentEditable) value = el.textContent || '';
  const trim = (s) => (typeof s === 'string' && s.length > 80 ? s.slice(0, 80) + '…' : (s || ''));
  return { tag, type: el.type || '', editable, label: trim(label), value: trim(value) };
}

// Detect macOS so keyboard chords use the platform-correct select-all modifier:
// Cmd/Meta on macOS, Ctrl elsewhere. userAgentData.platform is the modern
// signal; navigator.platform is the legacy fallback.
function isMacPlatform() {
  try {
    const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    return /mac/i.test(p);
  } catch { return false; }
}

// Select-all + Delete via the CDP Input domain — same trusted key path as
// fast_key (pressKeyChord). Uses Cmd/Meta+A on macOS and Ctrl+A elsewhere (the
// fast_key MOD_BITS map already carries meta/cmd=4), so the clear-before-type
// select-all fires the right chord on every platform. Clears the field so a
// follow-up insertText REPLACES instead of appending.
async function selectAllAndDelete(tabId) {
  const a = keyInfo('a');
  const selectAllMod = isMacPlatform() ? MOD_BITS.meta : MOD_BITS.ctrl;
  const aBase = { modifiers: selectAllMod, key: a.key, code: a.code, windowsVirtualKeyCode: a.keyCode, nativeVirtualKeyCode: a.keyCode };
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...aBase });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...aBase });
  const del = keyInfo('Delete');
  const dBase = { modifiers: 0, key: del.key, code: del.code, windowsVirtualKeyCode: del.keyCode, nativeVirtualKeyCode: del.keyCode };
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...dBase });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...dBase });
}

// Trusted typing into the currently-focused element via Input.insertText.
// React accepts it because it's a real input event (unlike setting .value).
//   args.text   : string to insert (required)
//   args.clear  : when true, select-all + Delete first so the value is REPLACED,
//                 not appended (default false → legacy append-to-focused).
//   args.force  : (alias allowIframe) SKIP the editable-focus guard. The guard's
//                 probe runs only in the TOP frame, so when focus is inside a
//                 CROSS-ORIGIN iframe (e.g. appleid.apple.com embedded in
//                 account.apple.com) the top doc's activeElement is the <iframe>
//                 element — not editable — and the guard refuses, even though a
//                 prior fast_click_xy DID focus the inner input. CDP
//                 Input.insertText is browser-level and DOES reach that focused
//                 cross-origin input, so force:true lets the read-coords →
//                 fast_click_xy → fast_type playbook fill cross-origin forms with
//                 NO vision/Gemini. Only use after a click that focused the field.
// Before inserting we verify an EDITABLE element is actually focused — a bare
// insertText goes to document.activeElement, so with nothing useful focused the
// text vanishes or lands in the wrong field (live: a URL appended into a Name
// field, "FastLink relayhttps://…"). Returns which element received the text.
export async function typeText({ text, clear, force, allowIframe } = {}) {
  if (typeof text !== 'string') return { error: 'fast_type: text is required (string)' };
  const got = await getInjectableTab();
  if (got.error) return got;
  const tabId = got.tab.id;
  const forced = force === true || allowIframe === true;

  const probe = await injectInTab({ world: 'MAIN', func: inspectActiveElement });
  if (probe.error) return probe;
  const el = probe.result;
  // Normal mode: refuse when nothing editable is focused (catches the "typed into
  // the wrong field" class of bug). Force mode: trust the caller's prior focusing
  // click — the editable element may be inside a cross-origin iframe the top-frame
  // probe can't see, so don't refuse on a non-editable/<iframe> activeElement.
  if (!forced && (!el || !el.editable)) {
    return { error: 'fast_type: no editable element focused — click/focus the field first (or pass force:true for a cross-origin iframe input you already clicked)', focused: el?.tag || null };
  }

  if (clear) await selectAllAndDelete(tabId);
  await cdp(tabId, 'Input.insertText', { text });

  // Echo the (post-insert) focused element so the caller can confirm the text
  // landed where intended. Best-effort — fall back to the pre-insert probe. In
  // force mode across a cross-origin iframe boundary this echoes the <iframe>
  // element (the inner input is unreadable from the top frame) — expected, not a
  // failure; flag forced so the caller knows the guard was bypassed intentionally.
  let into = el;
  try {
    const after = await injectInTab({ world: 'MAIN', func: inspectActiveElement });
    if (after.result) into = after.result;
  } catch {}
  return {
    typed: text.length,
    cleared: !!clear,
    forced: forced || undefined,
    into: into ? { tag: into.tag, type: into.type, label: into.label, value: into.value } : null,
  };
}

// CDP modifier bitmask: Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8.
const MOD_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

// Map a key name to the fields CDP's dispatchKeyEvent needs. Covers common
// named keys, letters, and digits — enough for shortcuts (Ctrl+A, Cmd+C) and
// navigation keys. Unknown multi-char names pass through as-is.
const NAMED_KEYS = {
  Enter: { keyCode: 13, code: 'Enter', key: 'Enter' },
  Tab: { keyCode: 9, code: 'Tab', key: 'Tab' },
  Escape: { keyCode: 27, code: 'Escape', key: 'Escape' },
  Backspace: { keyCode: 8, code: 'Backspace', key: 'Backspace' },
  Delete: { keyCode: 46, code: 'Delete', key: 'Delete' },
  ArrowUp: { keyCode: 38, code: 'ArrowUp', key: 'ArrowUp' },
  ArrowDown: { keyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
  ArrowLeft: { keyCode: 37, code: 'ArrowLeft', key: 'ArrowLeft' },
  ArrowRight: { keyCode: 39, code: 'ArrowRight', key: 'ArrowRight' },
  Home: { keyCode: 36, code: 'Home', key: 'Home' },
  End: { keyCode: 35, code: 'End', key: 'End' },
  PageUp: { keyCode: 33, code: 'PageUp', key: 'PageUp' },
  PageDown: { keyCode: 34, code: 'PageDown', key: 'PageDown' },
  Space: { keyCode: 32, code: 'Space', key: ' ' },
};
function keyInfo(k) {
  if (NAMED_KEYS[k]) return NAMED_KEYS[k];
  const s = String(k);
  if (s.length === 1) {
    const up = s.toUpperCase();
    const cc = up.charCodeAt(0);
    if (up >= 'A' && up <= 'Z') return { keyCode: cc, code: `Key${up}`, key: s };
    if (up >= '0' && up <= '9') return { keyCode: cc, code: `Digit${up}`, key: s };
    return { keyCode: cc, code: '', key: s };
  }
  return { keyCode: 0, code: s, key: s };
}

// Trusted key chord via the CDP Input domain — supports modifiers (Ctrl/Cmd/
// Shift/Alt), so Ctrl+A / Cmd+C / Shift+Tab actually fire as real key events.
export async function pressKeyChord({ key, modifiers = [] }) {
  if (!key) return { error: 'key required' };
  const got = await getInjectableTab();
  if (got.error) return got;
  const tabId = got.tab.id;
  const mask = (modifiers || []).reduce((m, x) => m | (MOD_BITS[String(x).toLowerCase()] || 0), 0);
  const info = keyInfo(key);
  const base = {
    modifiers: mask,
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.keyCode,
    nativeVirtualKeyCode: info.keyCode,
  };
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  return { pressed: { key: info.key, modifiers } };
}
