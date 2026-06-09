// updateCheck.js — auto-update CHECK (notify-only) for the FastLink extension.
//
// Reads the latest PUBLISHED version from the PUBLIC GitHub repo and compares it
// to the running manifest version, then records the result in
// chrome.storage.local['fastlinkUpdate'] for the popup banner + an optional
// one-shot desktop notification.
//
// This is a CHECK-AND-NOTIFY only. True silent self-install needs the Chrome Web
// Store, or a hosted signed .crx + an `update_url` in the manifest — out of scope
// for the current unpacked / self-distributed model, where the user pulls the
// latest and reloads at chrome://extensions (or downloads the release).
//
// Sources (in order):
//   1. PRIMARY — GitHub Releases API `…/releases/latest` → tag_name (strip "v").
//   2. FALLBACK — raw manifest.json on `main` → .version  (used when there are no
//      releases yet / 404 / API rate-limit).
//
// Everything here is best-effort: any network/parse error just skips the cycle
// (never throws into the service worker), and the fetch is capped by a timeout.

const REPO          = 'Turetsky/fastlink';
const RELEASES_API  = `https://api.github.com/repos/${REPO}/releases/latest`;
const RAW_MANIFEST  = `https://raw.githubusercontent.com/${REPO}/main/fast-ext/manifest.json`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

const STORE_KEY    = 'fastlinkUpdate';          // chrome.storage.local — read by popup.js
const NOTIFIED_KEY = 'fastlinkUpdateNotified';  // last version we fired a desktop notification for
const FETCH_TIMEOUT_MS = 8000;

// Minimum gap between real network checks. background.js calls checkForUpdate()
// on startup/install, on the alarm tick, AND on every fresh SW evaluation; this
// debounce (against the stored checkedAt) keeps a flapping MV3 worker from
// hammering GitHub — only an overdue check actually hits the network.
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 6h

// "1.2.10" -> [1, 2, 10]. Tolerates a leading "v" and junk segments.
function parseVer(v) {
  return String(v || '')
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
}

// true iff version a is strictly NEWER than b (numeric, segment-by-segment).
function isNewer(a, b) {
  const pa = parseVer(a);
  const pb = parseVer(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;   // equal → not newer
}

// Fetch + parse JSON with a hard timeout. Returns null on any failure (offline,
// abort, non-2xx incl. 404 / 403 rate-limit, bad JSON) so the caller can fall
// through to the next source / skip the cycle.
async function fetchJson(url, accept) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: 'no-store',
      headers: accept ? { accept } : undefined,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Resolve the latest published version. Returns { latest, url } or null.
async function resolveLatest() {
  // PRIMARY: GitHub Releases.
  const rel = await fetchJson(RELEASES_API, 'application/vnd.github+json');
  if (rel && rel.tag_name) {
    return { latest: String(rel.tag_name).replace(/^v/i, ''), url: rel.html_url || RELEASES_PAGE };
  }
  // FALLBACK: raw manifest on main (no releases yet / rate-limited).
  const mani = await fetchJson(RAW_MANIFEST, 'application/json');
  if (mani && mani.version) {
    return { latest: String(mani.version).replace(/^v/i, ''), url: RELEASES_PAGE };
  }
  return null;
}

// Fire ONE desktop notification per newly-detected version (debounced via the
// stored NOTIFIED_KEY). Best-effort; the `notifications` permission already
// exists in the manifest.
async function maybeNotify(latest) {
  try {
    if (!chrome.notifications) return;
    const o = await chrome.storage.local.get(NOTIFIED_KEY);
    if (o?.[NOTIFIED_KEY] === latest) return;                 // already pinged for this version
    await chrome.storage.local.set({ [NOTIFIED_KEY]: latest });
    chrome.notifications.create(`fastlink-update-${latest}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: 'FastLink — update available',
      message: `Version ${latest} is available. Open the toolbar popup to update.`,
      priority: 1,
    }, () => void chrome.runtime.lastError);
  } catch {}
}

// Public entry point. Safe to call on every SW wake — it self-debounces.
// Pass { force:true } to bypass the debounce (e.g. an explicit "check now").
export async function checkForUpdate({ force = false } = {}) {
  try {
    const current = chrome.runtime.getManifest().version;

    // Debounce against the last stored check.
    if (!force) {
      try {
        const o = await chrome.storage.local.get(STORE_KEY);
        const last = o?.[STORE_KEY]?.checkedAt;
        if (typeof last === 'number' && Date.now() - last < UPDATE_CHECK_INTERVAL_MS) return;
      } catch {}
    }

    const resolved = await resolveLatest();
    if (!resolved) return;   // all sources failed this cycle → leave the prior record intact

    const { latest, url } = resolved;
    const available = isNewer(latest, current);
    const record = available
      ? { available: true,  current, latest, url, checkedAt: Date.now() }
      : { available: false, current, latest,      checkedAt: Date.now() };

    await chrome.storage.local.set({ [STORE_KEY]: record });
    if (available) await maybeNotify(latest);
  } catch {
    // Never throw into the service worker — a failed check just means "skip".
  }
}
