// Edge neural Text-to-Speech engine (service-worker side).
//
// Microsoft Edge's "Read Aloud" streams natural neural voices (Aria, Guy,
// Jenny, … ~320 voices) from a FREE Microsoft endpoint that needs no API key —
// only a signed `Sec-MS-GEC` token (a SHA-256 of a 5-minute-rounded Windows
// filetime + a public client token). This module speaks to that exact endpoint
// so FastLink's "Read aloud" widget can use those voices instead of the OS
// robotic ones.
//
// WHY THIS LIVES IN THE SERVICE WORKER (not the content script):
//   The endpoint 403s unless the request's User-Agent contains "Edg". A page /
//   content-script WebSocket cannot set its User-Agent, and neither can a SW
//   WebSocket via JS. The ONLY way to force it is a declarativeNetRequest rule
//   that rewrites the User-Agent header on requests to speech.platform.bing.com.
//   DNR rules only apply to the extension's own network layer, so the WebSocket
//   must be opened here, in the SW, where the rule covers it. (Verified: with an
//   Edge UA the handshake returns 101; with Chrome/empty/bogus UA → 403. No
//   other header — Origin, Cookie, muid — is required.)
//
// The content script (src/readAloud.js) talks to this module over
// chrome.runtime messaging:
//   {type:'fastlink:tts-voices'}            -> { ok, voices:[{id,name,locale,gender}] }
//   {type:'fastlink:tts-synth', text, voice}-> { ok, b64 }   (mono 24kHz 48kbps mp3)
// Speed is applied client-side via HTMLAudioElement.playbackRate, so synthesis
// is always at neutral rate and a speed change never re-hits the network.

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WIN_EPOCH = 11644473600;
const CHROMIUM_VER = '143.0.3650.75';
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_VER}`;
const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const HOST = 'speech.platform.bing.com';
const WSS_URL = `wss://${HOST}/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TOKEN}`;
const VOICES_URL = `https://${HOST}/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TOKEN}`;
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const DNR_RULE_ID = 9911;        // a fixed, unlikely-to-collide session-rule id
const SYNTH_TIMEOUT_MS = 20000;

// Server-clock offset (seconds). The token is rounded to 5-minute buckets, so a
// clock off by minutes mints a rejected token. We learn the true server time
// from the Date header of the voices fetch and fold it into the token. On a
// healthy machine this is ~0; it's pure insurance (WSL clocks drift).
let serverOffsetSec = 0;
let voicesCache = null;          // [{id,name,locale,gender}]

// Install the User-Agent rewrite rule. Session rules live for the browser
// session and don't survive a SW restart cleanly, so we (re)install on import.
async function ensureUaRule() {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [DNR_RULE_ID],
      addRules: [{
        id: DNR_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'user-agent', operation: 'set', value: EDGE_UA }],
        },
        condition: {
          urlFilter: `||${HOST}/`,
          resourceTypes: ['websocket', 'xmlhttprequest', 'other'],
        },
      }],
    });
  } catch (e) {
    console.warn('[fastlink tts] DNR rule install failed:', e);
  }
}

// SHA-256 hex (uppercase) of the time-bucketed token. NOTE: the *1e7 product
// overflows Number's safe-integer range, but that float imprecision is part of
// the spec — Microsoft's server and edge-tts both compute it as an IEEE-754
// double, so reproducing it bit-for-bit is exactly what's required (verified to
// match the reference implementation's token byte-for-byte).
async function secMsGec() {
  let t = Date.now() / 1000 + serverOffsetSec;
  t += WIN_EPOCH;
  t -= t % 300;
  t *= 1e7;
  const str = `${Math.floor(t)}${TOKEN}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

const connectId = () => (crypto.randomUUID?.() || '').replace(/-/g, '') ||
  [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

async function fetchVoices() {
  if (voicesCache) return voicesCache;
  await ensureUaRule();
  const r = await fetch(`${VOICES_URL}&Sec-MS-GEC=${await secMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`);
  // Learn the clock offset from the server's Date header (cheap, every fetch).
  const d = r.headers.get('date');
  if (d) { const ms = Date.parse(d); if (!Number.isNaN(ms)) serverOffsetSec = ms / 1000 - Date.now() / 1000; }
  if (!r.ok) throw new Error('voices HTTP ' + r.status);
  const raw = await r.json();
  voicesCache = raw.map((v) => ({
    id: v.ShortName, name: v.FriendlyName || v.ShortName, locale: v.Locale, gender: v.Gender,
  }));
  return voicesCache;
}

// Synthesize one chunk of text → mp3 ArrayBuffer. One WebSocket per chunk; the
// connection closes itself on turn.end. Rate/pitch are left neutral (client
// owns speed via playbackRate).
function synthesize(text, voice) {
  return new Promise((resolve, reject) => {
    let ws, settled = false;
    const chunksOut = [];
    const cleanup = () => { try { ws && ws.close(); } catch {} };
    const fail = (e) => { if (settled) return; settled = true; cleanup(); reject(e instanceof Error ? e : new Error(String(e))); };
    const done = () => {
      if (settled) return; settled = true; cleanup();
      let total = 0; for (const c of chunksOut) total += c.byteLength;
      const out = new Uint8Array(total); let off = 0;
      for (const c of chunksOut) { out.set(new Uint8Array(c), off); off += c.byteLength; }
      resolve(out.buffer);
    };
    const timer = setTimeout(() => fail(new Error('synth timeout')), SYNTH_TIMEOUT_MS);

    (async () => {
      try {
        await ensureUaRule();
        const url = `${WSS_URL}&ConnectionId=${connectId()}&Sec-MS-GEC=${await secMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
        ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        const ts = new Date().toString();
        ws.onopen = () => {
          ws.send(
            `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
            `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${OUTPUT_FORMAT}"}}}}`,
          );
          const ssml =
            `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
            `<voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${xmlEscape(text)}</prosody></voice></speak>`;
          ws.send(`X-RequestId:${connectId()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n${ssml}`);
        };
        ws.onmessage = (ev) => {
          if (typeof ev.data === 'string') {
            if (ev.data.includes('Path:turn.end')) { clearTimeout(timer); done(); }
            return;
          }
          // Binary frame: [2-byte BE header length][header ascii][audio bytes].
          const buf = ev.data;
          const dv = new DataView(buf);
          const headerLen = dv.getUint16(0, false);
          const header = new TextDecoder('ascii').decode(new Uint8Array(buf, 2, headerLen));
          if (header.includes('Path:audio')) chunksOut.push(buf.slice(2 + headerLen));
        };
        ws.onerror = () => { clearTimeout(timer); fail(new Error('ws error (handshake/UA?)')); };
        ws.onclose = () => { if (!settled) { clearTimeout(timer); fail(new Error('ws closed early')); } };
      } catch (e) { clearTimeout(timer); fail(e); }
    })();
  });
}

const abToB64 = (buf) => {
  let bin = ''; const bytes = new Uint8Array(buf); const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('fastlink:tts-')) return;
  if (msg.type === 'fastlink:tts-voices') {
    fetchVoices().then((voices) => sendResponse({ ok: true, voices }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;   // async
  }
  if (msg.type === 'fastlink:tts-synth') {
    const text = String(msg.text || '').trim();
    const voice = String(msg.voice || 'en-US-AriaNeural');
    if (!text) { sendResponse({ ok: false, error: 'empty text' }); return; }
    synthesize(text, voice).then((buf) => sendResponse({ ok: true, b64: abToB64(buf) }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;   // async
  }
});

ensureUaRule();
