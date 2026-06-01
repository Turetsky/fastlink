import { getInjectableTab, injectInTab } from '../util.js';
import { cdp } from './input.js';

export async function evaluate({ fn, args }) {
  const got = await getInjectableTab();
  if (got.error) return got;
  const userArgs = Array.isArray(args) ? args : [];

  const cdp = await evaluateViaCDP(got.tab.id, fn, userArgs);
  if (cdp.ok) return cdp.value;
  if (cdp.userError) return { error: cdp.userError };
  // CDP unavailable (e.g. devtools already attached on this tab) — fall back.
  return evaluateViaScripting(fn, userArgs);
}

async function evaluateViaCDP(tabId, fnStr, userArgs) {
  try {
    // Use the SHARED persistent CDP session (input.js cdp helper) — no per-call
    // attach/detach, so the "debugging Chrome" banner doesn't toggle and the
    // viewport doesn't shift between a screenshot and a subsequent click.
    const expr = `(async () => { const __fn = (${fnStr}); return await __fn(...${JSON.stringify(userArgs)}); })()`;
    const res = await cdp(tabId, 'Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res?.exceptionDetails) {
      const ex = res.exceptionDetails;
      const msg = ex.exception?.description || ex.text || 'Evaluation threw';
      return { ok: false, userError: msg };
    }
    return { ok: true, value: res?.result?.value ?? null };
  } catch {
    return { ok: false }; // CDP unavailable → caller falls back to scripting
  }
}

async function evaluateViaScripting(fnStr, userArgs) {
  const r = await injectInTab({ world: 'MAIN', func: runUserFn, args: [fnStr, userArgs] });
  if (r.error) return r;
  if (r.result?.err) return { error: r.result.err };
  return r.result ? r.result.ok : null;
}

async function runUserFn(fnStr, userArgs) {
  try {
    const fn = (0, eval)(`(${fnStr})`);
    const v = await fn(...userArgs);
    return { ok: v };
  } catch (e) {
    return { err: String(e?.message || e) };
  }
}
