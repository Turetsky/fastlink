import { readBuffer, networkBuffers, networkBodyBuffers } from '../buffers.js';
import { getActiveTab } from '../util.js';

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
const TS_MATCH_WINDOW_MS = 5000;

export async function readNetwork(args = {}) {
  const f = args.filter ? String(args.filter).toLowerCase() : null;
  const filter = (e) => {
    if (f && !(e.url || '').toLowerCase().includes(f)) return false;
    if (args.status === 'failed' && e.ok) return false;
    if (args.status === 'ok' && !e.ok) return false;
    return true;
  };
  const result = await readBuffer(networkBuffers, args, filter);
  if (!args.responseBody || result.error) return result;

  const tab = await getActiveTab();
  if (!tab) return result;
  const bodies = networkBodyBuffers.get(tab.id) || [];
  const maxBytes = typeof args.maxBodyBytes === 'number' && args.maxBodyBytes > 0
    ? args.maxBodyBytes
    : DEFAULT_MAX_BODY_BYTES;
  // Pair body captures (from fetch/XHR hook) to webRequest entries by URL + closest timestamp.
  // Index-by-URL keeps lookup O(items + bodies); we then prefer the body closest in time.
  const byUrl = new Map();
  for (const b of bodies) {
    if (!byUrl.has(b.url)) byUrl.set(b.url, []);
    byUrl.get(b.url).push(b);
  }
  const used = new Set();
  result.items = result.items.map((item) => {
    const candidates = byUrl.get(item.url) || [];
    let best = null, bestDelta = Infinity;
    for (let i = 0; i < candidates.length; i++) {
      if (used.has(`${item.url}#${i}`)) continue;
      const c = candidates[i];
      const delta = Math.abs((c.endedAt || 0) - (item.ts || 0));
      if (delta < bestDelta) { best = { c, i }; bestDelta = delta; }
    }
    if (!best || bestDelta > TS_MATCH_WINDOW_MS) return item;
    used.add(`${item.url}#${best.i}`);
    const c = best.c;
    const base = { ...item, bodyKind: c.kind };
    // Surface why the body is missing so callers can decide whether to fall
    // back to fast_network_replay (worth trying for streamed/binary) vs.
    // skip (read-failed) vs. leave alone (too-large will replay too).
    if (c.body == null) return {
      ...base,
      body: null,
      bodyAvailable: false,
      bodyMissingReason: c.skipReason || 'unknown',
      ...(c.bodyReadError ? { bodyReadError: c.bodyReadError } : {}),
    };
    const overflow = c.body.length > maxBytes;
    return {
      ...base,
      body: overflow ? c.body.slice(0, maxBytes) : c.body,
      bodyTruncated: overflow || !!c.truncated,
      bodyFullLength: c.fullLength || c.body.length,
      bodyAvailable: true,
    };
  });
  return result;
}
