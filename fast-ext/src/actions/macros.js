// Persistent macros: a saved sequence of fast_* actions you can replay by name.
// Stored in chrome.storage.local under keys like "fb_macro_<name>".

const PREFIX = 'fb_macro_';
const KEY = (name) => PREFIX + name;

// Tools that are pure diagnostics (run server-side, never injected) and so
// can't function as a macro step. Listing them explicitly gives a clearer
// error than the generic "Unknown action" the dispatcher would return.
const DIAGNOSTIC_ONLY = new Set(['fast_status', 'fast_batch']);

export async function saveMacro({ name, actions, description } = {}) {
  if (!name || typeof name !== 'string') return { error: 'name (string) required' };
  if (!Array.isArray(actions) || actions.length === 0) return { error: 'actions (non-empty array of {name, args}) required' };
  for (const s of actions) {
    if (!s || typeof s.name !== 'string') return { error: 'each step needs a {name, args} object with string name' };
    if (s.name.startsWith('fast_macro_')) return { error: `macro steps cannot invoke macro management tool "${s.name}"` };
    if (DIAGNOSTIC_ONLY.has(s.name)) return { error: `"${s.name}" is a diagnostic-only tool (not allowed as a macro step). Build workflow steps from fast_nav/click/fill/etc. instead.` };
  }
  const record = { name, actions, description: description || null, savedAt: Date.now() };
  await chrome.storage.local.set({ [KEY(name)]: record });
  return { saved: name, steps: actions.length };
}

export async function listMacros() {
  const all = await chrome.storage.local.get(null);
  const macros = [];
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(PREFIX)) continue;
    macros.push({ name: v.name, steps: v.actions?.length || 0, description: v.description || null, savedAt: v.savedAt });
  }
  macros.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  return { count: macros.length, macros };
}

export async function deleteMacro({ name } = {}) {
  if (!name) return { error: 'name required' };
  const exists = (await chrome.storage.local.get(KEY(name)))[KEY(name)];
  if (!exists) return { error: `macro "${name}" not found` };
  await chrome.storage.local.remove(KEY(name));
  return { deleted: name };
}

export async function runMacro({ name, continueOnError } = {}, dispatch) {
  if (!name) return { error: 'name required' };
  const stored = await chrome.storage.local.get(KEY(name));
  const macro = stored[KEY(name)];
  if (!macro) return { error: `macro "${name}" not found` };
  const cont = !!continueOnError;
  const results = [];
  for (let i = 0; i < macro.actions.length; i++) {
    const step = macro.actions[i];
    // Catch legacy macros saved before the diagnostic-only check existed.
    if (DIAGNOSTIC_ONLY.has(step.name)) {
      results.push({ step: i, name: step.name, error: `"${step.name}" is a diagnostic-only tool (not allowed as a macro step)` });
      if (!cont) break;
      continue;
    }
    const r = await dispatch(step.name, step.args || {});
    results.push({ step: i, name: step.name, ...(r.error ? { error: r.error } : { result: r.result }) });
    if (r.error && !cont) break;
  }
  return { macro: name, ran: results.length, total: macro.actions.length, results };
}
