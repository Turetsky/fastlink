import { handleTabAction } from './tab.js';
import { takeScreenshot }  from './screenshot.js';
import { pressKey }        from './key.js';
import { getText }         from './text.js';
import { evaluate }        from './evaluate.js';
import { clickXY, typeText, pressKeyChord, wheelScroll, dragXY } from './input.js';
import { readConsole }     from './console.js';
import { readNetwork }     from './network.js';
import { waitForNetworkIdle } from './waitIdle.js';
import { saveMacro, listMacros, runMacro, deleteMacro } from './macros.js';
import { captureMarks }    from './marks.js';
import { visionCapture, annotateBoxes } from './vision.js';
import { injectInTab }     from '../util.js';

const TAB_ACTIONS  = new Set(['fast_tab', 'fast_nav', 'fast_reload', 'fast_list', 'fast_close', 'fast_switch']);
const PAGE_ACTIONS = new Set([
  'fast_snapshot', 'fast_click', 'fast_fill', 'fast_fill_form', 'fast_wait',
  'fast_select_option', 'fast_hover', 'fast_drag', 'fast_scroll',
  'fast_network_replay',
]);

let __evtSeq = 0;
// Fire-and-forget overlay notification. Never blocks the action path:
// chrome.tabs.query runs async with a callback, sendMessage is invoked
// without await, errors are swallowed (overlay missing on chrome:// pages, etc.).
function notifyOverlay(payload) {
  try {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const id = tabs && tabs[0] && tabs[0].id;
      if (!id) return;
      try { chrome.tabs.sendMessage(id, { fastlink: 'event', ...payload }, () => void chrome.runtime.lastError); } catch {}
    });
  } catch {}
}

export async function dispatchAction(action, args) {
  const evtId = ++__evtSeq;
  notifyOverlay({ phase: 'start', id: evtId, action, args });
  try {
    const r = await runOne(action, args);
    // Pass error payloads through whole — diagnostics/available/etc. must survive to the LLM.
    if (r && typeof r === 'object' && 'error' in r && r.error !== undefined) {
      notifyOverlay({ phase: 'end', id: evtId, ok: false, error: r.error });
      return r;
    }
    let result = r;
    if (args?.screenshot && typeof result === 'object' && result !== null) {
      try {
        const shot = await takeScreenshot({ format: args.screenshotFormat });
        if (shot?.dataUrl) result.screenshot = shot;
      } catch (e) {
        result.screenshotError = e?.message || String(e);
      }
    }
    notifyOverlay({ phase: 'end', id: evtId, ok: true });
    return { result };
  } catch (e) {
    const msg = e?.message || String(e);
    notifyOverlay({ phase: 'end', id: evtId, ok: false, error: msg });
    return { error: msg };
  }
}

async function runOne(action, args) {
  if (TAB_ACTIONS.has(action))      return handleTabAction(action, args);
  if (action === 'fast_screenshot') return takeScreenshot(args);
  if (action === 'fast_marks')      return captureMarks(args);
  if (action === 'fast_vision_capture') return visionCapture(args);
  if (action === 'fast_annotate_boxes') return annotateBoxes(args);
  if (action === 'fast_key_press')  return pressKey(args);
  if (action === 'fast_text')       return getText(args);
  if (action === 'fast_evaluate')   return evaluate(args);
  if (action === 'fast_click_xy')   return clickXY(args);
  if (action === 'fast_type')       return typeText(args);
  if (action === 'fast_key')        return pressKeyChord(args);
  if (action === 'fast_wheel')      return wheelScroll(args);
  if (action === 'fast_drag_xy')    return dragXY(args);
  if (action === 'fast_console')    return readConsole(args);
  if (action === 'fast_network')    return readNetwork(args);
  if (action === 'fast_wait' && args?.networkIdle) return waitForNetworkIdle(args);
  if (action === 'fast_macro_save')   return saveMacro(args);
  if (action === 'fast_macro_list')   return listMacros();
  if (action === 'fast_macro_run')    return runMacro(args, dispatchAction);
  if (action === 'fast_macro_delete') return deleteMacro(args);
  if (PAGE_ACTIONS.has(action))     return injectPageAction(action, args);
  return { error: `Unknown action: ${action}` };
}

// Tiny bridge: page.js is pre-injected as a MAIN-world content script and
// self-attaches window.__fastlink.run. This 1-line ship replaces the old
// ~640-line runPageAction serialization on every call.
function pageBridge(action, args) {
  if (!window.__fastlink || !window.__fastlink.run) {
    return { error: 'FastLink content script not loaded in this tab — reload the tab. (The extension was reloaded after this tab opened, so the pre-injected page.js is missing.)' };
  }
  return window.__fastlink.run(action, args);
}

async function injectPageAction(action, args) {
  const r = await injectInTab({ world: 'MAIN', func: pageBridge, args: [action, args || {}] });
  if (r.error) return r;
  // null/undefined from the injected script means it threw before returning.
  // Surface that as an error rather than guessing what happened (the old
  // "click probably fired, navigatedAway: true" hack masked real bugs).
  if (r.result == null) {
    return { error: `${action}: injected script returned no value — likely an exception in the page context. Try fast_evaluate or check chrome://extensions service worker logs.` };
  }
  return r.result;
}
