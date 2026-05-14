// MAIN-world content script. Patches window.fetch and XMLHttpRequest so
// response bodies can be captured for later inspection. Emits a custom
// event; the ISOLATED-world listener forwards it to the service worker.

(() => {
  if (window.__fb_network_hooked) return;
  window.__fb_network_hooked = true;

  // Capture up to 64KB per body in-page; the server-side response is further
  // trimmed by fast_network's maxBodyBytes (default 16KB).
  const CAPTURE_MAX = 64 * 1024;
  // Skip bodies advertised larger than this — saves materializing huge buffers
  // we'd just slice and discard. 256KB picks "small enough to be useful text".
  const MAX_CONTENT_LENGTH = 256 * 1024;

  const trunc = (s) => {
    if (typeof s !== 'string') return { body: null, truncated: false };
    if (s.length <= CAPTURE_MAX) return { body: s, truncated: false, fullLength: s.length };
    return { body: s.slice(0, CAPTURE_MAX), truncated: true, fullLength: s.length };
  };

  // Categorize why a body would or wouldn't be captured. Returning a reason
  // (rather than a bool) lets fast_network surface "body unavailable because
  // it was streamed" instead of a silent null, so callers know whether to
  // fall back to fast_network_replay.
  const RE_STREAM = /event-stream/i;
  const RE_MEDIA  = /^(video|audio|image)\//i;
  const RE_OCTET  = /octet-stream/i;
  const skipReason = (resp) => {
    const ct = resp.headers.get('content-type') || '';
    if (RE_STREAM.test(ct)) return 'streamed';
    if (RE_MEDIA.test(ct))  return 'binary';
    if (RE_OCTET.test(ct))  return 'binary';
    const cl = parseInt(resp.headers.get('content-length') || '0', 10);
    if (cl > MAX_CONTENT_LENGTH) return 'too-large';
    return null;
  };

  // webRequest sees fully-resolved URLs; page code can call fetch('/relative').
  // Normalize so both sides agree when fast_network joins by url.
  const absUrl = (u) => {
    try { return new URL(u, location.href).href; } catch { return String(u || ''); }
  };

  const emit = (entry) => {
    try {
      window.dispatchEvent(new CustomEvent('__fb_network_body', { detail: entry }));
    } catch {}
  };

  // --- fetch ---
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function(input, init) {
      const rawUrl = typeof input === 'string' ? input : (input?.url || '');
      const url = absUrl(rawUrl);
      const method = ((init?.method) || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();
      const startedAt = Date.now();
      let resp;
      try {
        resp = await origFetch.apply(this, arguments);
      } catch (err) {
        emit({ url, method, status: 0, kind: 'fetch', startedAt, endedAt: Date.now(), error: String(err?.message || err) });
        throw err;
      }
      const base = { url, method, status: resp.status, kind: 'fetch', startedAt };
      const skip = skipReason(resp);
      if (skip) {
        emit({ ...base, endedAt: Date.now(), bodyAvailable: false, skipReason: skip });
        return resp;
      }
      try {
        resp.clone().text().then(
          (text) => emit({ ...base, endedAt: Date.now(), ...trunc(text) }),
          (err)  => emit({ ...base, endedAt: Date.now(), bodyAvailable: false, skipReason: 'read-failed', bodyReadError: String(err?.message || err) }),
        );
      } catch (err) {
        emit({ ...base, endedAt: Date.now(), bodyAvailable: false, skipReason: 'read-failed', bodyReadError: String(err?.message || err) });
      }
      return resp;
    };
  }

  // --- XMLHttpRequest ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__fb_method = method;
    this.__fb_url = absUrl(url);
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    const startedAt = Date.now();
    this.addEventListener('loadend', () => {
      let text = null, skip = null;
      try {
        // responseText only valid for type '' or 'text'; reading otherwise throws.
        const rt = this.responseType;
        if (!rt || rt === '' || rt === 'text') {
          text = this.responseText;
          // Streaming XHR (e.g. Firestore Listen) keeps responseText growing
          // across events; on loadend we still have it. But arraybuffer/blob
          // responses have no readable text — flag as binary.
        } else {
          skip = 'binary';
        }
      } catch (e) {
        skip = 'read-failed';
      }
      const base = {
        url: this.__fb_url || '',
        method: (this.__fb_method || 'GET').toUpperCase(),
        status: this.status,
        kind: 'xhr',
        startedAt,
        endedAt: Date.now(),
      };
      if (skip) emit({ ...base, bodyAvailable: false, skipReason: skip });
      else      emit({ ...base, ...trunc(text) });
    });
    return origSend.apply(this, arguments);
  };
})();
