import { injectInTab } from '../util.js';

export async function getText(args = {}) {
  const r = await injectInTab({
    world: 'ISOLATED',
    func: extractText,
    args: [args.selector || null, args.maxLen || null, !!args.html],
  });
  return r.error ? r : r.result;
}

function extractText(selector, maxLen, html) {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) return { error: `selector "${selector}" not found` };
  const raw = html ? (root.outerHTML || '') : (root.innerText || root.textContent || '');
  const text = String(raw);
  const limit = typeof maxLen === 'number' && maxLen > 0 ? maxLen : 0;
  const truncated = limit && text.length > limit;
  return {
    text: truncated ? text.slice(0, limit) : text,
    length: text.length,
    truncated: !!truncated,
    kind: html ? 'outerHTML' : 'innerText',
    from: selector || 'body',
  };
}
