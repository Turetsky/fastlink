import { injectInTab } from '../util.js';

export async function pressKey({ key }) {
  const r = await injectInTab({ world: 'MAIN', func: dispatchKey, args: [key] });
  return r.error ? r : r.result;
}

function dispatchKey(key) {
  const el = document.activeElement || document.body;
  const opts = { key, code: key, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keypress', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
  return { keyDispatched: key, target: el.tagName + (el.id ? '#' + el.id : '') };
}
