import { getInjectableTab } from '../util.js';

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

// `debugger` is now an OPTIONAL permission (requested on demand from the popup/
// options "Advanced control" toggle). Every CDP path — coordinate input
// (click_xy/type/key/wheel/drag_xy), fast_evaluate, and background-tab / GPU-
// fallback capture — funnels through cdp(), so this single guard makes the whole
// debugger surface degrade gracefully: a clear, actionable error instead of a
// raw "Cannot access" throw when the user hasn't granted it. DOM actions
// (snapshot, selector click/fill) use chrome.scripting and never reach here.
async function ensureDebuggerPermission() {
  let has = false;
  try { has = await chrome.permissions.contains({ permissions: ['debugger'] }); } catch {}
  if (!has) {
    const e = new Error(
      'This needs FastLink’s optional "Advanced control" (debugger) permission — used for coordinate ' +
      'clicks/typing, running scripts, and capturing background tabs. Enable it in the FastLink popup or ' +
      'options → "Advanced control", then retry. DOM-based clicking and form-filling work without it.'
    );
    e.code = 'debugger_permission_required';
    throw e;
  }
}

// Send a CDP command on the persistent session (attach lazily, do NOT detach).
// Exported so other actions (e.g. fast_evaluate) share ONE debugger session —
// critical: a separate attach/detach per call toggles the "debugging Chrome"
// banner, which shifts the viewport ~35-50px and makes coordinate clicks miss.
export async function cdp(tabId, method, params) {
  await ensureDebuggerPermission();
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

// Trusted click at a TOP-LEVEL viewport pixel via the CDP Input domain.
// Unlike injected JS .click() (isTrusted:false), this lands a real mouse event
// that LWC/React honor and that can focus an iframe input without DOM reach-in.
export async function clickXY({ x, y, button, clickCount }) {
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

// Trusted typing into the currently-focused element via Input.insertText.
// React accepts it because it's a real input event (unlike setting .value).
export async function typeText({ text }) {
  const got = await getInjectableTab();
  if (got.error) return got;
  await cdp(got.tab.id, 'Input.insertText', { text });
  return { typed: text.length };
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
