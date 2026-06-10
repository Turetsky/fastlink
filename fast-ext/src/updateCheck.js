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

// --- NO-CLICK self-apply (chrome.runtime.reload re-reads the unpacked folder) ---
// A background process keeps the unpacked extension folder current (pulled from
// GitHub). chrome.runtime.reload() re-reads those on-disk files, so when GitHub's
// latest > the RUNNING version AND the user hasn't opted out, we can apply the
// update with zero user action by reloading ourselves.
const AUTO_KEY          = 'fastlinkAutoUpdate';              // chrome.storage.local — default TRUE
const SELF_RELOADED_KEY = 'fastlinkSelfReloaded';           // { toVersion, at } — handshake read on the next startup
const LAST_ATTEMPT_KEY  = 'fastlinkLastSelfReloadAttempt';  // { version, at } — the loop-prevention guard
// LOOP PREVENTION: after chrome.runtime.reload() the RUNNING version reflects what
// is on DISK. If the background pull hasn't landed yet, disk (and therefore the
// reloaded running version) still lags GitHub-latest, so the "latest > running"
// condition is STILL true and a naive implementation would reload forever. Guard:
// never attempt a self-reload for the SAME target version more than once per this
// window. A lagging disk then retries at most this often; once disk catches up the
// reload sticks (running == latest) and the condition goes false on its own.
const SELF_RELOAD_RETRY_MS = 30 * 60 * 1000;   // 30 min

// CIRCUIT BREAKER (the backstop on top of the 30-min per-version delay guard).
// Real-world testing showed chrome.runtime.reload() CAN end up in a tight reload
// loop. A self-updater that can loop is worse than none, so make a runaway loop
// impossible BY DESIGN: keep a log of recent self-reload timestamps; if too many
// land inside a short window, HALT auto-update entirely (no reload), surface it,
// and require the user to re-enable. Survives reloads because it lives in storage.
const SELF_RELOAD_LOG_KEY = 'fastlinkSelfReloadLog';      // chrome.storage.local — [timestamps]
const HALTED_KEY          = 'fastlinkAutoUpdateHalted';   // chrome.storage.local — breaker tripped
const BREAKER_WINDOW_MS   = 10 * 60 * 1000;   // look back 10 min
const BREAKER_MAX         = 3;                 // ≥3 self-reloads in the window → trip

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

// Fire a desktop notification when the circuit breaker trips. High priority — a
// loop-detected halt is exactly the case the user needs to know about.
async function notifyHalted() {
  try {
    if (!chrome.notifications) return;
    chrome.notifications.create('fastlink-autoupdate-halted', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: 'FastLink — auto-update paused',
      message: 'A reload loop was detected. Update manually and re-enable auto-update in Settings.',
      priority: 2,
    }, () => void chrome.runtime.lastError);
  } catch {}
}

// Attempt a NO-CLICK self-update. Returns true iff it triggered chrome.runtime.
// reload() (in which case the worker is about to be torn down and the caller
// should do nothing further). Returns false when auto-update is off/halted, the
// circuit breaker trips, OR the 30-min per-version guard blocks a repeat attempt.
//
// ONLY ever called from the periodic check path (selfApply:true), never from a
// fresh SW wake — so a bare service-worker startup alone can never reload; the
// trigger is strictly "a periodic check found a genuinely newer version AND every
// guard passes."
async function maybeSelfApply(latest) {
  try {
    const o = await chrome.storage.local.get([AUTO_KEY, HALTED_KEY, LAST_ATTEMPT_KEY, SELF_RELOAD_LOG_KEY]);
    if (o?.[AUTO_KEY] === false) return false;          // opted out → banner/notify only (default ON)
    if (o?.[HALTED_KEY]) return false;                  // breaker already tripped → manual re-enable required

    const now = Date.now();

    // CIRCUIT BREAKER (checked first, before any decision to reload). Prune the
    // self-reload log to the last BREAKER_WINDOW_MS; if it's already at the limit,
    // a runaway loop is underway → HALT: turn auto-update off, set the halt flag,
    // do NOT reload, notify, and persist the pruned log. By design this caps the
    // total number of self-reloads, so a loop is impossible no matter what.
    const log = (Array.isArray(o?.[SELF_RELOAD_LOG_KEY]) ? o[SELF_RELOAD_LOG_KEY] : [])
      .filter((t) => typeof t === 'number' && now - t < BREAKER_WINDOW_MS);
    if (log.length >= BREAKER_MAX) {
      await chrome.storage.local.set({
        [SELF_RELOAD_LOG_KEY]: log,   // store the pruned log
        [HALTED_KEY]: true,
        [AUTO_KEY]: false,
      });
      notifyHalted();
      return false;
    }

    // 30-min guard, keyed by TARGET VERSION. If we already tried to reach `latest`
    // recently and we're still being asked to (i.e. disk hasn't caught up), back
    // off instead of looping. A NEW (different) target version is never blocked.
    const last = o?.[LAST_ATTEMPT_KEY];
    if (last && last.version === latest && typeof last.at === 'number'
        && now - last.at < SELF_RELOAD_RETRY_MS) {
      return false;
    }

    // Record the attempt + append this timestamp to the breaker log BEFORE
    // reloading so BOTH survive the reload (the count is what makes a runaway loop
    // impossible), and leave a handshake the next startup reads to confirm success.
    log.push(now);
    await chrome.storage.local.set({
      [LAST_ATTEMPT_KEY]:    { version: latest, at: now },
      [SELF_RELOADED_KEY]:   { toVersion: latest, at: now },
      [SELF_RELOAD_LOG_KEY]: log,
    });
    chrome.runtime.reload();   // re-reads the (pulled) on-disk files; tears down this worker
    return true;
  } catch {
    return false;   // never throw into the SW — fall back to banner/notify
  }
}

// Public entry point. Safe to call on every SW wake — it self-debounces.
// Pass { force:true } to bypass the debounce (e.g. an explicit "check now").
// Pass { selfApply:true } to PERMIT a no-click self-reload when a newer version
// is found — supplied ONLY by the periodic alarm tick, never by the top-level /
// onStartup / onInstalled calls, so a bare SW wake can never trigger a reload.
export async function checkForUpdate({ force = false, selfApply = false } = {}) {
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
    if (available) {
      // Try the no-click self-apply first — but ONLY on the periodic path
      // (selfApply). If it reloads, this worker is going away — skip the
      // notification (the next startup fires an "Updated to vX" one instead). If
      // it DIDN'T self-apply (not the periodic path, opted out/halted, breaker
      // tripped, or the 30-min guard held because disk is lagging), fall back to
      // the existing banner notification.
      const reloaded = selfApply ? await maybeSelfApply(latest) : false;
      if (!reloaded) await maybeNotify(latest);
    }
  } catch {
    // Never throw into the service worker — a failed check just means "skip".
  }
}
