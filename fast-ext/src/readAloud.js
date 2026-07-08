// FastLink "Read aloud" — a one-tap floating button that reads the current page
// out loud, with a live speed slider and a voice picker. Two engines:
//
//   • NEURAL (default): Microsoft Edge's free online neural voices (~320 of
//     them — Aria, Guy, Jenny, …) via the service worker (src/edgeTts.js). High
//     quality, needs network. Speed is applied with HTMLAudioElement.playbackRate
//     (pitch preserved), so dragging the slider is instant and never re-fetches.
//   • SYSTEM (fallback): the browser's built-in speechSynthesis (robotic, OS
//     voices). Used when offline, when the neural endpoint fails, or when the
//     user explicitly picks "System voice".
//
// Both engines drive one shared chunk list + index, so pause/resume/stop/speed
// behave identically. Text is split into short (~220 char) chunks: that dodges
// Chrome's ~15s speechSynthesis cutoff AND lets neural prefetch the next chunk
// while the current one plays, so playback is gapless.
//
// ISOLATED-world content script on <all_urls>, all in a closed shadow root.
// The widget is HIDDEN by default — it mounts only when toggled on from the
// toolbar popup ('fastlink:read-aloud-toggle'), so it never covers page UI
// uninvited. The ✕ button and the popup both hide it again.

(() => {
  if (window.top !== window) return;            // top frame only

  // Re-injection (extension reload) must cleanly replace any orphan instance.
  try { document.getElementById('__fastlink_read_host__')?.remove(); } catch {}
  try { window.__fastlinkReadTeardown?.(); } catch {}

  const synth = window.speechSynthesis;
  const HOST_ID = '__fastlink_read_host__';
  const RATE_KEY = 'readAloudRate';
  const VOICE_KEY = 'readAloudVoice';           // 'n:<edgeId>' | 's:<sysURI>' | 's'
  const MIN_RATE = 0.5, MAX_RATE = 3.0;

  // Edge neural TTS endpoint constants. The WebSocket is opened HERE in the
  // content script (page context), NOT in the service worker: Chrome's
  // declarativeNetRequest UA-rewrite rule (installed by src/edgeTts.js) only
  // applies to page-context requests, not the extension's own SW requests — and
  // the endpoint 403s without an "Edg" User-Agent. See [reference-edge-neural-tts].
  const TTS_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  const TTS_WIN_EPOCH = 11644473600;
  const TTS_GEC_VERSION = '1-143.0.3650.75';
  const TTS_WSS = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TTS_TOKEN}`;
  const TTS_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

  let rate = 1.0;
  let chunks = [];
  let idx = 0;
  let playing = false;
  let paused = false;
  let gen = 0;                                   // bumps on every cancel; stale callbacks bail
  let drawerOpen = false;
  let voiceFilter = '';                          // text filter for the voice dropdown

  let engine = 's';                             // 'n' neural | 's' system
  let neuralId = 'en-US-AriaNeural';            // chosen edge voice id
  let sysVoiceURI = '';                         // chosen system voice URI ('' = default)
  let neuralVoices = null;                       // [{id,name,locale,gender}] or null if unavailable
  let neuralBroken = false;                      // a synth error → stop trying neural this session

  const audio = new Audio();                     // single element reused for neural playback
  audio.preload = 'auto';
  try { audio.preservesPitch = true; audio.mozPreservesPitch = true; } catch {}
  const neuralCache = new Map();                 // chunk index -> Promise<dataURL|null>

  // ---- text extraction ------------------------------------------------------
  const getReadableText = () => {
    const sel = (window.getSelection?.().toString() || '').trim();
    if (sel.length > 20) return sel;
    const root =
      document.querySelector('main, article, [role="main"]') ||
      document.querySelector('.lesson-main-content, .course-content, .content-body') ||
      document.body;
    return (root?.innerText || '').trim();
  };

  const chunkText = (text) => {
    const clean = text.replace(/[ \t  ]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
    if (!clean) return [];
    const sentences = clean.match(/[^.!?\n]+[.!?]+|\S[^.!?\n]*(?=\n|$)/g) || [clean];
    const out = [];
    let buf = '';
    for (const s of sentences) {
      const piece = s.trim();
      if (!piece) continue;
      if ((buf + ' ' + piece).trim().length > 220) {
        if (buf) out.push(buf.trim());
        buf = piece;
      } else {
        buf = (buf + ' ' + piece).trim();
      }
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  };

  // ---- messaging to the SW neural engine ------------------------------------
  const sw = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime?.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
        resolve(resp || { ok: false, error: 'no response' });
      });
    } catch (e) { resolve({ ok: false, error: String(e) }); }
  });

  const loadNeuralVoices = async () => {
    const r = await sw({ type: 'fastlink:tts-voices' });
    if (r.ok && Array.isArray(r.voices) && r.voices.length) { neuralVoices = r.voices; console.log('[fastlink-read] neural voices loaded:', r.voices.length); }
    else { neuralVoices = null; console.warn('[fastlink-read] neural voices unavailable →', r.error); }
  };

  // ---- neural synthesis (direct WebSocket, page context) --------------------
  const ttsToken = async () => {
    let t = Date.now() / 1000 + TTS_WIN_EPOCH;
    t -= t % 300; t *= 1e7;
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${Math.floor(t)}${TTS_TOKEN}`));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  };
  const uuid = () => (crypto.randomUUID?.() || '').replace(/-/g, '') ||
    [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const abToDataUrl = (buf) => {
    let bin = ''; const b = new Uint8Array(buf); const CH = 0x8000;
    for (let i = 0; i < b.length; i += CH) bin += String.fromCharCode.apply(null, b.subarray(i, i + CH));
    return 'data:audio/mpeg;base64,' + btoa(bin);
  };

  // Synthesize one chunk over a fresh WebSocket → mp3 data URL (or null).
  const neuralSynth = (text, voice) => new Promise((resolve) => {
    let ws, settled = false; const out = [];
    const finish = (val) => { if (settled) return; settled = true; try { ws && ws.close(); } catch {} resolve(val); };
    const timer = setTimeout(() => { console.warn('[fastlink-read] neural synth timeout'); finish(null); }, 20000);
    (async () => {
      try {
        const url = `${TTS_WSS}&ConnectionId=${uuid()}&Sec-MS-GEC=${await ttsToken()}&Sec-MS-GEC-Version=${TTS_GEC_VERSION}`;
        ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        const ts = new Date().toString();
        ws.onopen = () => {
          ws.send(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
            `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${TTS_FORMAT}"}}}}`);
          const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
            `<voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${xmlEsc(text)}</prosody></voice></speak>`;
          ws.send(`X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n${ssml}`);
        };
        ws.onmessage = (ev) => {
          if (typeof ev.data === 'string') {
            if (ev.data.includes('Path:turn.end')) {
              clearTimeout(timer);
              let tot = 0; for (const c of out) tot += c.byteLength;
              const u = new Uint8Array(tot); let o = 0; for (const c of out) { u.set(new Uint8Array(c), o); o += c.byteLength; }
              finish(tot ? abToDataUrl(u.buffer) : null);
            }
            return;
          }
          const dv = new DataView(ev.data);
          const hl = dv.getUint16(0, false);
          const hdr = new TextDecoder('ascii').decode(new Uint8Array(ev.data, 2, hl));
          if (hdr.includes('Path:audio')) out.push(ev.data.slice(2 + hl));
        };
        ws.onerror = () => { clearTimeout(timer); console.warn('[fastlink-read] neural WS error (UA/handshake?)'); finish(null); };
        ws.onclose = () => { if (!settled) { clearTimeout(timer); finish(null); } };
      } catch (e) { clearTimeout(timer); console.warn('[fastlink-read] neural synth threw', e); finish(null); }
    })();
  });

  // Fetch (or reuse cached) mp3 data URL for a chunk. Returns null on failure.
  const neuralChunk = (i) => {
    if (neuralCache.has(i)) return neuralCache.get(i);
    const p = neuralSynth(chunks[i], neuralId);
    neuralCache.set(i, p);
    return p;
  };

  // ---- system (speechSynthesis) engine --------------------------------------
  const sysVoice = () => {
    const list = synth?.getVoices?.() || [];
    if (sysVoiceURI) { const v = list.find((x) => x.voiceURI === sysVoiceURI); if (v) return v; }
    return list.find((v) => v.default && /^en/i.test(v.lang)) || list.find((v) => /^en/i.test(v.lang)) || list[0] || null;
  };
  const sysSpeak = () => {
    if (idx >= chunks.length) { stop(); return; }
    const myGen = gen;
    const u = new SpeechSynthesisUtterance(chunks[idx]);
    u.rate = rate;
    const v = sysVoice(); if (v) u.voice = v;
    const advance = () => { if (myGen !== gen || paused || !playing) return; idx++; sysSpeak(); };
    u.onend = advance; u.onerror = advance;
    try { synth.speak(u); } catch {}
    render();
  };

  // ---- neural engine --------------------------------------------------------
  const neuralPlay = async () => {
    if (idx >= chunks.length) { stop(); return; }
    const myGen = gen;
    const url = await neuralChunk(idx);
    if (myGen !== gen) return;                   // superseded while awaiting
    if (url === null) { fallbackToSystem(); return; }
    audio.src = url;
    try { audio.playbackRate = rate; } catch {}
    audio.onended = () => { if (myGen !== gen || paused || !playing) return; idx++; neuralPlay(); };
    audio.onerror = () => { if (myGen !== gen) return; fallbackToSystem(); };
    try { await audio.play(); } catch { if (myGen === gen) fallbackToSystem(); return; }
    neuralChunk(idx + 1);                        // prefetch next while this plays
    render();
  };

  // Neural failed mid-read → switch to the robotic engine and keep going from
  // the current chunk so the user isn't left in silence.
  const fallbackToSystem = () => {
    if (!playing) return;
    neuralBroken = true;
    engine = 's';
    flash('Neural voice unavailable — using system voice');
    gen++; try { audio.pause(); } catch {}
    if (!paused) sysSpeak();
    render();
  };

  // ---- shared transport controls --------------------------------------------
  const startEngine = () => { (engine === 'n' && !neuralBroken) ? neuralPlay() : sysSpeak(); };

  const start = () => {
    const text = getReadableText();
    chunks = chunkText(text);
    if (!chunks.length) { flash('Nothing to read on this page'); return; }
    cancelAll();
    neuralCache.clear();
    idx = 0; playing = true; paused = false; drawerOpen = false;
    startEngine();
    render();
  };

  const cancelAll = () => {
    gen++;
    try { synth?.cancel(); } catch {}
    try { audio.pause(); } catch {}
  };

  const togglePause = () => {
    if (!playing) { start(); return; }
    if (paused) {                                // resume
      paused = false;
      if (engine === 'n' && !neuralBroken) { try { audio.play(); } catch {} } else { sysSpeak(); }
    } else {                                     // pause
      paused = true;
      if (engine === 'n' && !neuralBroken) { try { audio.pause(); } catch {} } else { cancelAll(); }
    }
    render();
  };

  const stop = () => {
    cancelAll();
    playing = false; paused = false; idx = 0; chunks = []; neuralCache.clear();
    render();
  };

  const setRate = (r) => {
    rate = Math.min(MAX_RATE, Math.max(MIN_RATE, r));
    try { chrome.storage?.local?.set({ [RATE_KEY]: rate }); } catch {}
    if (playing && !paused) {
      if (engine === 'n' && !neuralBroken) { try { audio.playbackRate = rate; } catch {} }  // instant
      else { cancelAll(); sysSpeak(); }          // system: re-speak current chunk at new rate
    }
    render();
  };

  const setVoice = (val) => {
    if (val.startsWith('n:')) { engine = 'n'; neuralId = val.slice(2); neuralBroken = false; }
    else { engine = 's'; sysVoiceURI = val.length > 2 ? val.slice(2) : ''; }
    try { chrome.storage?.local?.set({ [VOICE_KEY]: val }); } catch {}
    neuralCache.clear();
    if (playing) {                               // re-read current chunk with the new voice
      cancelAll();
      paused = false;
      startEngine();
    }
    render();
  };

  // ---- UI -------------------------------------------------------------------
  let host = null, shadow = null, root = null;

  const SPK = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.06a7 7 0 0 1 0 13.48v2.06a9 9 0 0 0 0-17.6z"/></svg>`;
  const PLAY = `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
  const PAUSE = `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>`;
  const STOP = `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>`;
  const GEAR = `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 8a4 4 0 100 8 4 4 0 000-8zm0 6a2 2 0 110-4 2 2 0 010 4zm9-2-2.1-.6a6.9 6.9 0 00-.5-1.2l1-1.9-1.4-1.4-1.9 1a6.9 6.9 0 00-1.2-.5L13.3 3h-2.6l-.6 2.1a6.9 6.9 0 00-1.2.5l-1.9-1L5.6 6l1 1.9a6.9 6.9 0 00-.5 1.2L4 11.7v2.6l2.1.6c.1.4.3.8.5 1.2l-1 1.9 1.4 1.4 1.9-1c.4.2.8.4 1.2.5l.6 2.1h2.6l.6-2.1c.4-.1.8-.3 1.2-.5l1.9 1 1.4-1.4-1-1.9c.2-.4.4-.8.5-1.2L21 13.3z"/></svg>`;
  const CLOSE = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"/></svg>`;

  const mount = () => {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;bottom:18px;right:18px;z-index:2147483646;';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host, * { box-sizing:border-box; }
      .wrap {
        font:13px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
        color:#E9ECF2; display:flex; align-items:center; gap:8px; position:relative;
        background:rgba(22,28,39,0.88); backdrop-filter:blur(10px);
        -webkit-backdrop-filter:blur(10px);
        border:1px solid rgba(255,255,255,0.10); border-radius:999px;
        box-shadow:0 8px 24px rgba(0,0,0,0.45); padding:6px 8px;
      }
      button { all:unset; cursor:pointer; display:flex; align-items:center; justify-content:center; }
      .main {
        gap:6px; color:#0c1018; font-weight:700; font-size:13px;
        background:linear-gradient(135deg,#F5AE3C,#F0863A);
        border-radius:999px; padding:7px 13px; white-space:nowrap;
        box-shadow:inset 0 1px 0 rgba(255,255,255,0.3);
      }
      .main:hover { filter:brightness(1.06); }
      .ctl { width:30px; height:30px; border-radius:50%; color:#E9ECF2; background:rgba(255,255,255,0.08); }
      .ctl:hover { background:rgba(255,255,255,0.16); }
      .ctl.stop:hover { color:#F26A6A; }
      .ctl.on { color:#FAC56B; background:rgba(245,174,60,0.18); }
      .speed { display:flex; align-items:center; gap:7px; padding:0 4px; }
      input[type=range] {
        -webkit-appearance:none; appearance:none; width:84px; height:4px;
        border-radius:3px; background:rgba(255,255,255,0.20); outline:none;
      }
      input[type=range]::-webkit-slider-thumb {
        -webkit-appearance:none; appearance:none; width:14px; height:14px;
        border-radius:50%; background:#F5AE3C; cursor:pointer; box-shadow:0 1px 3px rgba(0,0,0,0.4);
      }
      .lbl { color:#FAC56B; font-weight:700; font-variant-numeric:tabular-nums; min-width:30px; text-align:right; }
      .prog { color:#9BA5B5; font-size:11px; font-variant-numeric:tabular-nums; min-width:38px; text-align:center; }
      .x { width:22px; height:22px; border-radius:50%; color:#9BA5B5; }
      .x:hover { color:#E9ECF2; background:rgba(255,255,255,0.10); }
      .drawer {
        position:absolute; bottom:46px; right:0; width:260px;
        background:rgba(22,28,39,0.96); border:1px solid rgba(255,255,255,0.10);
        border-radius:12px; box-shadow:0 10px 28px rgba(0,0,0,0.5); padding:11px 12px;
        display:flex; flex-direction:column; gap:10px;
      }
      .drawer .field { display:flex; flex-direction:column; gap:5px; }
      .drawer label { color:#9BA5B5; font-size:11px; font-weight:600; }
      .drawer select {
        width:100%; font:inherit; font-size:12px; color:#E9ECF2;
        background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12);
        border-radius:7px; padding:6px 8px;
      }
      .drawer select option, .drawer select optgroup { background:#161c27; color:#E9ECF2; }
      .drawer .vfilter {
        width:100%; font:inherit; font-size:12px; color:#E9ECF2; margin-bottom:6px;
        background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12);
        border-radius:7px; padding:6px 8px;
      }
      .drawer .vfilter::placeholder { color:#6b7588; }
      .drawer select { max-height:240px; }
      .drawer .row { display:flex; align-items:center; gap:8px; }
      .hidden { display:none !important; }
      .toast {
        position:absolute; bottom:46px; right:0; white-space:nowrap; max-width:280px;
        background:rgba(22,28,39,0.96); color:#E9ECF2; font-size:12px;
        border:1px solid rgba(255,255,255,0.10); border-radius:8px; padding:6px 10px;
        box-shadow:0 6px 18px rgba(0,0,0,0.4);
      }
    `;
    root = document.createElement('div');
    root.className = 'wrap';
    shadow.appendChild(style);
    shadow.appendChild(root);
    shadow.addEventListener('click', onClick);
    shadow.addEventListener('input', onInput);
    shadow.addEventListener('change', onChange);
    document.documentElement.appendChild(host);
    _sig = null;                                 // fresh root → force a full paint
    render();
  };

  let toastTimer = null;
  const flash = (text) => {
    mount();
    let t = shadow.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; root.appendChild(t); }
    t.textContent = text;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { try { t.remove(); } catch {} }, 2600);
  };

  // Human "Language (Country)" for a BCP-47 locale, e.g. fr-CA → "French (Canada)".
  let _dnLang, _dnReg;
  const localeName = (loc) => {
    try {
      _dnLang = _dnLang || new Intl.DisplayNames(['en'], { type: 'language' });
      _dnReg = _dnReg || new Intl.DisplayNames(['en'], { type: 'region' });
      const [l, r] = String(loc).split('-');
      const lang = _dnLang.of(l) || l;
      const reg = r ? (_dnReg.of(r.toUpperCase()) || r) : '';
      return reg ? `${lang} (${reg})` : lang;
    } catch { return String(loc); }
  };
  // Short voice name: "fr-FR-DeniseNeural" → "Denise"; keep a (multilingual) tag.
  const shortName = (id) => id.replace(/^[a-z]{2}-[A-Z]{2,3}-/, '').replace(/Neural$/, '').replace(/Multilingual$/, ' (multilingual)').trim();

  const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  // Group voices by locale and sort: English first, then alphabetical by language.
  const byLocale = (list, locOf) => {
    const m = new Map();
    for (const v of list) { const k = locOf(v); if (!m.has(k)) m.set(k, []); m.get(k).push(v); }
    return [...m.entries()].sort((a, b) => {
      const oa = (/^en/i.test(a[0]) ? '0' : '1') + localeName(a[0]).toLowerCase();
      const ob = (/^en/i.test(b[0]) ? '0' : '1') + localeName(b[0]).toLowerCase();
      return oa < ob ? -1 : oa > ob ? 1 : 0;
    });
  };

  // Just the <optgroup>…</optgroup> markup, filtered by `voiceFilter`. Built
  // separately so typing in the filter rebuilds ONLY the options, never the
  // whole widget (keeps the filter box focused).
  const voiceOptionsHtml = () => {
    const cur = engine === 'n' ? `n:${neuralId}` : `s:${sysVoiceURI}`;
    const f = voiceFilter.trim().toLowerCase();
    const opt = (val, label) =>
      `<option value="${escAttr(val)}"${val === cur ? ' selected' : ''}>${escAttr(label)}</option>`;
    let html = '';
    if (neuralVoices && neuralVoices.length) {
      const hit = (v) => !f || v.id.toLowerCase().includes(f) || v.locale.toLowerCase().includes(f) ||
        localeName(v.locale).toLowerCase().includes(f) || (v.name || '').toLowerCase().includes(f);
      const groups = byLocale(neuralVoices.filter(hit), (v) => v.locale);
      for (const [loc, vs] of groups) {
        vs.sort((a, b) => shortName(a.id) < shortName(b.id) ? -1 : 1);
        html += `<optgroup label="${escAttr(localeName(loc))}">` +
          vs.map((v) => opt(`n:${v.id}`, `${shortName(v.id)}${v.gender ? ' · ' + v.gender[0] : ''}`)).join('') + '</optgroup>';
      }
    }
    const sys = (synth?.getVoices?.() || []);
    const shit = (v) => !f || (v.name || '').toLowerCase().includes(f) || (v.lang || '').toLowerCase().includes(f) ||
      localeName(v.lang).toLowerCase().includes(f) || 'offline system robotic'.includes(f);
    const sysF = sys.filter(shit);
    if (!f || 'offline system default'.includes(f) || sysF.length) {
      const sgroups = byLocale(sysF, (v) => v.lang || 'und');
      html += `<optgroup label="⌁ Offline / robotic (on-device)">` + opt('s:', 'System default') + '</optgroup>';
      for (const [loc, vs] of sgroups) {
        html += `<optgroup label="⌁ ${escAttr(localeName(loc))}">` +
          vs.map((v) => opt(`s:${v.voiceURI}`, v.name)).join('') + '</optgroup>';
      }
    }
    return html || '<option disabled>No voices match</option>';
  };

  const voiceSelectHtml = () =>
    `<input class="vfilter" data-act="vfilter" type="text" placeholder="Filter… e.g. french, Denise" value="${escAttr(voiceFilter)}">` +
    `<select data-act="voice" size="1">${voiceOptionsHtml()}</select>`;

  const rateStr = () => (Math.round(rate * 10) / 10).toFixed(1) + '×';

  // Lightweight in-place update: refresh only the dynamic text (progress counter,
  // speed label) WITHOUT rebuilding the DOM. Critical for not nuking an open
  // voice dropdown or a slider mid-drag while playback advances chunks.
  const tick = () => {
    if (!root) return;
    const p = root.querySelector('.prog');
    if (p && playing && chunks.length) p.textContent = `${Math.min(idx + 1, chunks.length)}/${chunks.length}`;
    const l = root.querySelector('.lbl');
    if (l) l.textContent = rateStr();
  };

  // Full structural rebuild — only when the layout actually changes (idle⇄playing,
  // pause⇄resume, drawer open⇄closed). Everything else routes through tick().
  let _sig = null;
  const render = () => {
    const sig = `${playing ? 1 : 0}${paused ? 1 : 0}${drawerOpen ? 1 : 0}`;
    if (sig !== _sig) { _sig = sig; paintFull(); } else { tick(); }
  };

  const paintFull = () => {
    if (!root) return;
    const speedHtml =
      `<div class="speed">${SPK}` +
      `<input type="range" min="${MIN_RATE}" max="${MAX_RATE}" step="0.1" value="${rate}" data-act="rate" title="Speed">` +
      `<span class="lbl">${rateStr()}</span></div>`;
    const drawerHtml = drawerOpen
      ? `<div class="drawer">` +
          `<div class="field"><label>Voice</label>${voiceSelectHtml()}</div>` +
          `<div class="field"><label>Speed</label><div class="row">${speedHtml}</div></div>` +
        `</div>`
      : '';
    if (!playing) {
      root.innerHTML =
        `<button class="main" data-act="start">${SPK}<span>Read aloud</span></button>` +
        `<button class="ctl${drawerOpen ? ' on' : ''}" data-act="drawer" title="Voice & speed">${GEAR}</button>` +
        drawerHtml;
    } else {
      const prog = chunks.length ? `${Math.min(idx + 1, chunks.length)}/${chunks.length}` : '';
      root.innerHTML =
        `<button class="ctl" data-act="toggle" title="${paused ? 'Resume' : 'Pause'}">${paused ? PLAY : PAUSE}</button>` +
        `<button class="ctl stop" data-act="stop" title="Stop">${STOP}</button>` +
        `<span class="prog">${prog}</span>` +
        speedHtml +
        `<button class="ctl${drawerOpen ? ' on' : ''}" data-act="drawer" title="Voice">${GEAR}</button>` +
        `<button class="x" data-act="hide" title="Hide">${CLOSE}</button>` +
        drawerHtml;
    }
  };

  const onClick = (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'start') start();
    else if (act === 'toggle') togglePause();
    else if (act === 'stop') stop();
    else if (act === 'drawer') { drawerOpen = !drawerOpen; render(); }
    else if (act === 'hide') hide();
  };
  const onInput = (e) => {
    const r = e.target.closest('[data-act="rate"]');
    if (r) { setRate(parseFloat(r.value)); return; }
    const f = e.target.closest('[data-act="vfilter"]');
    if (f) {                                    // rebuild ONLY the options — keep the filter box focused
      voiceFilter = f.value;
      const sel = root.querySelector('[data-act="voice"]');
      if (sel) sel.innerHTML = voiceOptionsHtml();
      return;
    }
  };
  const onChange = (e) => {
    const v = e.target.closest('[data-act="voice"]');
    if (v) setVoice(v.value);
  };

  // ---- lifecycle ------------------------------------------------------------
  // Hidden until toggled on from the toolbar popup. show() mounts the widget
  // (idle "Read aloud" pill); hide() stops playback and removes it entirely.
  const onPageHide = () => { cancelAll(); };

  let shown = false;
  let voicesRequested = false;

  const show = () => {
    if (shown && host && document.documentElement.contains(host)) return;
    shown = true;
    mount();
    if (!voicesRequested) {
      voicesRequested = true;
      loadNeuralVoices().then(() => {
        // Wanted neural but the endpoint is down → fall back to system.
        if (engine === 'n' && !neuralVoices) engine = 's';
        render();
      });
    }
  };

  const hide = () => {
    shown = false;
    stop();
    try { host?.remove(); } catch {}
    host = shadow = root = null;
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'fastlink:read-aloud-toggle') {
      shown ? hide() : show();
      sendResponse({ ok: true, shown });
    } else if (msg?.type === 'fastlink:read-aloud-state') {
      sendResponse({ ok: true, shown });
    }
  });

  window.addEventListener('pagehide', onPageHide);
  try { synth?.addEventListener?.('voiceschanged', () => { if (drawerOpen) { const sel = root?.querySelector('[data-act="voice"]'); if (sel) sel.innerHTML = voiceOptionsHtml(); } }); } catch {}

  window.__fastlinkReadTeardown = () => {
    try { cancelAll(); } catch {}
    try { window.removeEventListener('pagehide', onPageHide); } catch {}
    try { host?.remove(); } catch {}
    host = shadow = root = null;
  };

  // Load saved prefs (rate, voice) up front so the first show() renders them.
  try {
    chrome.storage?.local?.get([RATE_KEY, VOICE_KEY], (o) => {
      if (chrome.runtime?.lastError) { engine = 'n'; return; }
      const r = parseFloat(o?.[RATE_KEY]);
      if (!Number.isNaN(r)) rate = Math.min(MAX_RATE, Math.max(MIN_RATE, r));
      const v = o?.[VOICE_KEY];
      if (typeof v === 'string' && v) {
        if (v.startsWith('n:')) { engine = 'n'; neuralId = v.slice(2); }
        else { engine = 's'; sysVoiceURI = v.length > 2 ? v.slice(2) : ''; }
      } else {
        engine = 'n';                            // first run: prefer neural (loadNeuralVoices confirms)
      }
    });
  } catch {
    engine = 'n';
  }
})();
