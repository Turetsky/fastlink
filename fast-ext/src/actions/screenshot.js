import { captureViewport } from '../util.js';

export async function takeScreenshot(args = {}) {
  // captureViewport retries the fast GPU path, then falls back to a software
  // CDP capture — so a wedged GPU process ("image readback failed") no longer
  // takes down every screenshot for the rest of the session. On total failure
  // it throws an error carrying an actionable .hint; surface that to the caller.
  try {
    return await captureViewport(args);
  } catch (e) {
    return { error: e?.message || String(e), hint: e?.hint };
  }
}
