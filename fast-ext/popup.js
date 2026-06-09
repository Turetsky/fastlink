// popup.js — toolbar popup. FastLink runs up to TWO transports at once (local
// broker + cloud relay); this renders one status row per ENABLED transport from
// the combined `fastlinkConn` object that background.js writes:
//   { local: {enabled,state,clients}|null, relay: {enabled,state}|null }
// (null = that transport is disabled/not configured). Plus shortcuts to the
// pairing settings and an extension reload.

const $ = (id) => document.getElementById(id);

// state -> [pill class, label]
const LABELS = {
  connected:    ['ok',   'Connected'],
  connecting:   ['warn', 'Connecting…'],
  disconnected: ['off',  'Disconnected'],
  auth:         ['warn', 'Needs re-pair'],
};

function row(title, state, detailText) {
  const [cls, text] = LABELS[state] || LABELS.disconnected;
  const wrap = document.createElement('div');
  wrap.className = 'trow';

  const line = document.createElement('p');
  line.append(title + ' ');
  const pill = document.createElement('span');
  pill.className = 'pill ' + cls;
  pill.textContent = text;
  line.append(pill);
  wrap.append(line);

  if (detailText) {
    const d = document.createElement('p');
    d.className = 'muted';
    d.textContent = detailText;
    wrap.append(d);
  }
  return wrap;
}

async function render() {
  const c = await chrome.storage.local.get(['fastlinkConn', 'relayAuthError', 'relayBase']);
  const conn = c.fastlinkConn || {};
  const rows = $('rows');
  rows.replaceChildren();

  if (conn.local) {
    const n = typeof conn.local.clients === 'number' ? conn.local.clients : null;
    const detail = conn.local.state === 'connected' && n != null
      ? `Localhost broker — ${n} MCP client${n === 1 ? '' : 's'} connected.`
      : 'Localhost broker (Claude Code / Desktop).';
    rows.append(row('Local broker —', conn.local.state, detail));
  }

  if (conn.relay) {
    const state = c.relayAuthError ? 'auth' : conn.relay.state;
    const detail = c.relayAuthError
      ? c.relayAuthError
      : conn.relay.state === 'connected'
        ? `Paired to ${c.relayBase || 'the relay'}. claude.ai can drive this browser.`
        : `Cloud relay${c.relayBase ? ' (' + c.relayBase + ')' : ''}.`;
    rows.append(row('Cloud relay —', state, detail));
  }

  if (!conn.local && !conn.relay) {
    rows.append(row('No transport enabled —', 'disconnected',
      'Enable the local broker or pair a cloud relay in settings.'));
  }
}

// ---------------------------------------------------------------------------
// Per-origin consent (SIGNUP-SPEC §4.2). Grant happens IN the browser via the
// device token the extension already holds — POST {relayBase}/consent. We
// surface either a relay-pushed pending origin (fastlinkPendingConsent) or, when
// paired, the current active tab's origin so the user can pre-approve a site.
// ---------------------------------------------------------------------------
const DEFAULT_RELAY_BASE = 'https://relay.ytx.app';

async function activeOrigin() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.url && /^https?:/.test(tab.url)) return new URL(tab.url).origin;
  } catch {}
  return null;
}

async function postConsent(origin, mode) {
  const c = await chrome.storage.local.get(['relayBase', 'deviceToken']);
  if (!c.deviceToken) throw new Error('This browser is not paired with the relay yet.');
  const base = String(c.relayBase || DEFAULT_RELAY_BASE).replace(/\/+$/, '');
  const res = await fetch(`${base}/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceToken: c.deviceToken, origin, mode }),
  });
  if (!res.ok) {
    let b = {};
    try { b = await res.json(); } catch {}
    const FRIENDLY = {
      invalid_device_token: 'This browser is no longer paired — re-pair it in the extension options.',
      invalid_mode: 'Unsupported permission choice.',
      invalid_origin: 'Could not determine this site’s origin.',
      invalid_json: 'The relay rejected the request.',
    };
    throw new Error(FRIENDLY[b?.error] || b?.error || `Consent update failed (HTTP ${res.status}).`);
  }
}

async function renderConsent() {
  const box = $('consent');
  const c = await chrome.storage.local.get(['fastlinkPendingConsent', 'deviceToken', 'fastlinkConn']);
  // No relay pairing → nothing to consent to.
  if (!c.deviceToken) { box.style.display = 'none'; return; }

  const pending = c.fastlinkPendingConsent;
  const origin = pending?.origin || await activeOrigin();
  if (!origin) { box.style.display = 'none'; return; }

  const modes = pending?.modes || ['allow', 'readonly'];
  box.replaceChildren();
  const h = document.createElement('h2');
  h.textContent = pending ? 'Approval needed' : 'Site permission';
  box.append(h);

  if (pending?.message) {
    const m = document.createElement('p');
    m.className = 'cmsg muted';
    m.textContent = pending.message;
    box.append(m);
  }

  const o = document.createElement('p');
  o.className = 'origin';
  o.textContent = origin;
  box.append(o);

  const btns = document.createElement('div');
  btns.className = 'btns';
  const make = (label, mode, cls) => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', () => grant(origin, mode));
    return b;
  };
  if (modes.includes('allow'))    btns.append(make('Allow', 'allow', 'allow'));
  if (modes.includes('readonly')) btns.append(make('Read-only', 'readonly', 'read'));
  btns.append(make('Block', 'block', 'block'));
  box.append(btns);

  const msg = document.createElement('p');
  msg.className = 'cmsg';
  msg.id = 'consent-msg';
  box.append(msg);

  box.style.display = 'block';
}

async function grant(origin, mode) {
  const msg = $('consent-msg');
  if (msg) { msg.textContent = 'Saving…'; msg.style.color = '#777'; }
  try {
    await postConsent(origin, mode);
    // Clear any pending prompt for this origin now it's decided.
    const c = await chrome.storage.local.get(['fastlinkPendingConsent']);
    if (c.fastlinkPendingConsent?.origin === origin) {
      await chrome.storage.local.remove(['fastlinkPendingConsent']);
    }
    if (msg) {
      msg.textContent = `Saved: ${mode} for ${origin}.`;
      msg.style.color = '#1a7f37';
    }
  } catch (e) {
    if (msg) { msg.textContent = e?.message || String(e); msg.style.color = '#b42318'; }
  }
}

// ---------------------------------------------------------------------------
// "Who's driving" mirror (SIGNUP-SPEC §5.4 / SAFETY N2). The target-tab PIN
// (chrome.storage.session 'fastlink.targetTabId') is the tab Claude is driving
// even while unfocused; mirror it here so the user always knows what's being
// driven from the chat side. The target tab itself shows the activity overlay.
// ---------------------------------------------------------------------------
const TARGET_PIN_KEY = 'fastlink.targetTabId';
const PAUSE_KEY = 'fastlink.drivingPaused';

async function isPaused() {
  try { const s = await chrome.storage.session.get(PAUSE_KEY); return !!s?.[PAUSE_KEY]; } catch { return false; }
}

async function renderDriving() {
  const el = $('driving');
  // Paused state wins over the pin: make the global "Claude can't act" stop obvious.
  if (await isPaused()) {
    el.textContent = '⏸ Paused by you — Claude can’t act until you resume';
    el.className = 'driving paused';
    el.style.display = 'block';
    return;
  }
  el.className = 'driving';
  let id = null;
  try {
    const o = await chrome.storage.session.get(TARGET_PIN_KEY);
    id = o?.[TARGET_PIN_KEY];
  } catch {}
  if (typeof id !== 'number') { el.style.display = 'none'; return; }
  let label;
  try {
    const t = await chrome.tabs.get(id);
    label = t?.title || (t?.url ? new URL(t.url).origin : `tab ${id}`);
  } catch {
    el.style.display = 'none';   // pinned tab gone
    return;
  }
  el.textContent = `▶ Claude is driving: ${label}`;
  el.style.display = 'block';
}

// N2 kill-switch controls: Stop/Resume driving (pause gate) + Disconnect/
// Reconnect the cloud relay. Both go through background message handlers.
async function renderControls() {
  const c = await chrome.storage.local.get(['deviceToken', 'relayEnabled', 'fastlinkMode']);
  const paused = await isPaused();

  const pb = $('pause-btn');
  pb.textContent = paused ? '▶ Resume driving' : '⏸ Stop driving';
  pb.className = paused ? 'resume' : 'stop';

  const db = $('disconnect-btn');
  if (c.deviceToken) {
    const relayDisabled = c.relayEnabled === false || c.fastlinkMode === 'local';
    db.style.display = '';
    db.textContent = relayDisabled ? 'Reconnect relay' : 'Disconnect relay';
    db.dataset.act = relayDisabled ? 'reconnect' : 'disconnect';
  } else {
    db.style.display = 'none';
  }
  $('controls').style.display = '';
}

async function onPauseToggle() {
  const paused = await isPaused();
  try { await chrome.runtime.sendMessage({ type: 'fastlink:driving-pause', paused: !paused }); } catch {}
  renderControls();
  renderDriving();
}

async function onDisconnectToggle() {
  const act = $('disconnect-btn').dataset.act;
  const type = act === 'reconnect' ? 'fastlink:relay-reconnect' : 'fastlink:relay-stop';
  try { await chrome.runtime.sendMessage({ type }); } catch {}
  renderControls();
}

$('open').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
$('reload').addEventListener('click', () => chrome.runtime.reload());
$('pause-btn').addEventListener('click', onPauseToggle);
$('disconnect-btn').addEventListener('click', onDisconnectToggle);

// Live-update the popup while it's open if background rewrites the status.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.fastlinkConn || changes.relayAuthError) render();
    if (changes.fastlinkConn || changes.fastlinkPendingConsent || changes.deviceToken) renderConsent();
    if (changes.deviceToken || changes.relayEnabled || changes.fastlinkMode) renderControls();
  }
  if (area === 'session' && (changes[TARGET_PIN_KEY] || changes[PAUSE_KEY])) {
    renderDriving();
    if (changes[PAUSE_KEY]) renderControls();
  }
});

render();
renderConsent();
renderDriving();
renderControls();
