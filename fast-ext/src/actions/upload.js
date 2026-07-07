import { injectInTab } from '../util.js';
import { cdp } from './input.js';

// FILE UPLOAD without the OS picker.
//
// A file <input> is driven by a NATIVE OS dialog that browser automation cannot
// touch — clicking it just opens a picker no script can fill. The trusted path is
// CDP `DOM.setFileInputFiles`, which sets the chosen files directly on the input
// (from the BROWSER process's own filesystem) and fires input/change events so the
// page reacts exactly as if the user picked them. Chrome here is a WINDOWS process,
// so the paths it opens must be WINDOWS paths — the WSL MCP server resolves those
// before calling us (see handlers.js handleUpload); winifyPath below is a
// belt-and-suspenders normalizer so the relay passthrough (which does no server-
// side translation) still handles the common /mnt/c and C:/ forms.

// Normalize incoming paths to a form the Windows Chrome process can open. The WSL
// server already sends proper `C:\…` paths (this is a no-op for those); the relay
// passes user paths straight through, so convert the two easy cases here too.
function winifyPath(p) {
  const s = String(p).trim().replace(/^["']|["']$/g, '');
  // /mnt/c/Users/you/pic.png  ->  C:\Users\you\pic.png
  const m = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(s);
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
  // C:/Users/... or C:\Users\...  ->  C:\Users\...
  if (/^[a-zA-Z]:[\\/]/.test(s)) return s.replace(/\//g, '\\');
  return s; // UNC (\\wsl.localhost\…) or already-backslashed — leave as-is
}

function normalizePaths(paths) {
  const list = Array.isArray(paths) ? paths : (paths != null ? [paths] : []);
  return list.map((p) => String(p).trim()).filter(Boolean).map(winifyPath);
}

// Runs in the page MAIN world: find the target file input and TAG it with a data
// attribute so CDP can resolve the exact node afterwards. Self-contained (no
// closures) — chrome.scripting serializes it. Match order: selector → text →
// index → the page's sole/first <input type=file>.
function locateFileInput({ selector, text, index }) {
  const all = Array.from(document.querySelectorAll('input[type=file]'));
  let el = null;

  if (selector) {
    try {
      const q = document.querySelector(selector);
      if (q) {
        if (q.matches && q.matches('input[type=file]')) el = q;
        else if (q.querySelector) el = q.querySelector('input[type=file]');
      }
    } catch {}
  }

  if (!el && text) {
    const needle = String(text).toLowerCase();
    const describe = (inp) => {
      let s = `${inp.name || ''} ${inp.id || ''} ${inp.getAttribute('aria-label') || ''} ${inp.title || ''} ${inp.accept || ''}`;
      try {
        if (inp.id) {
          const lab = document.querySelector(`label[for="${CSS.escape(inp.id)}"]`);
          if (lab) s += ' ' + (lab.textContent || '');
        }
      } catch {}
      const wrap = inp.closest && inp.closest('label');
      if (wrap) s += ' ' + (wrap.textContent || '');
      if (inp.parentElement) s += ' ' + (inp.parentElement.textContent || '').slice(0, 200);
      return s.toLowerCase();
    };
    el = all.find((inp) => describe(inp).includes(needle)) || null;
  }

  if (!el && typeof index === 'number' && index >= 0) el = all[index] || null;
  if (!el && all.length) el = all[0]; // sole/first file input — the common case

  if (!el) return { found: false, count: all.length };
  try { el.setAttribute('data-fastlink-upload', '1'); } catch {}
  return {
    found: true,
    count: all.length,
    name: el.name || '',
    id: el.id || '',
    accept: el.accept || '',
    multiple: !!el.multiple,
  };
}

// Runs in MAIN world after setFileInputFiles: read back what the input now holds
// (proof the files landed) and remove our marker.
function confirmUpload() {
  const el = document.querySelector('[data-fastlink-upload="1"]');
  if (!el) return null;
  const files = Array.from(el.files || []).map((f) => ({ name: f.name, size: f.size, type: f.type }));
  try { el.removeAttribute('data-fastlink-upload'); } catch {}
  return { count: files.length, files, name: el.name || '', id: el.id || '' };
}

function clearMarker() {
  const el = document.querySelector('[data-fastlink-upload="1"]');
  if (el) el.removeAttribute('data-fastlink-upload');
}

// args: { selector?, text?, index?, path?, paths } — paths are Windows-openable
// (resolved server-side for the WSL MCP; normalized here for the relay).
export async function uploadFile({ selector, text, index, path, paths } = {}) {
  const files = normalizePaths(paths != null ? paths : path);
  if (!files.length) return { error: 'fast_upload: no file paths provided (pass path or paths)' };

  // 1. Locate + tag the input in the page.
  const loc = await injectInTab({
    world: 'MAIN',
    func: locateFileInput,
    args: [{ selector: selector || null, text: text || null, index: (typeof index === 'number' ? index : null) }],
  });
  if (loc.error) return loc;
  const info = loc.result;
  if (!info || !info.found) {
    const how = selector ? ` for selector "${selector}"` : text ? ` matching text "${text}"` : '';
    return {
      error: `fast_upload: no <input type=file> found${how}. Note: only the TOP document is searched (not cross-origin iframes).`,
      fileInputsOnPage: info?.count || 0,
    };
  }
  const tabId = loc.tab.id;
  const warnMultiple = files.length > 1 && !info.multiple;

  // 2. Resolve a CDP handle (objectId) for the tagged input.
  let objectId;
  try {
    const ev = await cdp(tabId, 'Runtime.evaluate', {
      expression: `document.querySelector('[data-fastlink-upload="1"]')`,
      returnByValue: false,
    });
    objectId = ev?.result?.objectId;
  } catch (e) {
    await injectInTab({ world: 'MAIN', func: clearMarker }).catch(() => {});
    // advancedControl OFF surfaces here with e.code — pass it through unchanged.
    return { error: `fast_upload: ${e.message}`, code: e.code };
  }
  if (!objectId) {
    await injectInTab({ world: 'MAIN', func: clearMarker }).catch(() => {});
    return { error: 'fast_upload: could not get a CDP handle to the file input.' };
  }

  // 3. Set the files — trusted, and fires input/change so the page reacts.
  try {
    await cdp(tabId, 'DOM.setFileInputFiles', { files, objectId });
  } catch (e) {
    await injectInTab({ world: 'MAIN', func: clearMarker }).catch(() => {});
    return {
      error: `fast_upload: setFileInputFiles failed — ${e.message}. Verify each file exists on the Chrome (Windows) machine and the input's accept filter allows it.`,
      code: e.code,
      files,
    };
  }

  // 4. Read back what the input now holds + clean up the marker.
  const back = await injectInTab({ world: 'MAIN', func: confirmUpload }).catch(() => ({ result: null }));
  const r = back.result;
  const out = {
    uploaded: files.length,
    files,
    accepted: r ? r.files : undefined,
    input: { name: info.name, id: info.id, accept: info.accept, multiple: info.multiple, count: r ? r.count : undefined },
  };
  if (warnMultiple) out.note = 'Sent multiple files but the input is NOT `multiple` — the page likely kept only the first.';
  return out;
}
