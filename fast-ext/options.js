// options.js — config UI for FastLink's transports. FastLink now runs the local
// broker AND the cloud relay AT THE SAME TIME (both drive the same browser), so
// this page pairs/unpairs the relay and shows the live status of BOTH transports.
// Applying a change reloads the extension so background.js re-reads config.

import { claimPairingCode, authorizeViaWebAuthFlow } from './src/relayClient.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEYS = [
  'fastlinkMode', 'localEnabled', 'relayEnabled', 'deviceToken',
  'relayBase', 'relayWssUrl', 'relayUserId', 'relayAuthError', 'fastlinkConn',
];

// state -> [pill class, label]
const LABELS = {
  connected:    ['ok',   'Connected'],
  connecting:   ['warn', 'Connecting…'],
  disconnected: ['off',  'Disconnected'],
  auth:         ['warn', 'Needs re-pair'],
  disabled:     ['off',  'Disabled'],
  unpaired:     ['off',  'Not paired'],
};

function setPill(id, state) {
  const [cls, text] = LABELS[state] || LABELS.disconnected;
  const el = $(id);
  el.textContent = text;
  el.className = 'pill ' + cls;
}

function mask(token) {
  if (!token) return '—';
  return token.length <= 8 ? '••••' : `${token.slice(0, 4)}…${token.slice(-4)}`;
}

// Build a <code> element via textContent — never innerHTML. relayBase is user-
// typed and relayUserId comes off the wire, so they must not be parsed as HTML
// in this privileged (chrome.*-capable) options page.
function codeEl(text) {
  const el = document.createElement('code');
  el.textContent = String(text);
  return el;
}

function showMsg(text, kind) {
  const el = $('msg');
  el.textContent = text;
  el.className = `msg ${kind}`;
}

async function render() {
  const c = await chrome.storage.local.get(STORAGE_KEYS);
  const conn = c.fastlinkConn || {};

  const localDisabled   = c.localEnabled === false;
  const relayConfigured = !!c.deviceToken;
  // Relay is disabled either explicitly or via the legacy fastlinkMode==='local'.
  const relayDisabled   = c.relayEnabled === false || c.fastlinkMode === 'local';

  // Local transport pill.
  setPill('local-pill', localDisabled ? 'disabled' : (conn.local?.state || 'disconnected'));

  // Relay transport pill: auth error > not paired > disabled > live state.
  let relayState;
  if (c.relayAuthError)        relayState = 'auth';
  else if (!relayConfigured)   relayState = 'unpaired';
  else if (relayDisabled)      relayState = 'disabled';
  else                         relayState = conn.relay?.state || 'disconnected';
  setPill('relay-pill', relayState);

  // Detail line.
  const detail = $('status-detail');
  if (relayConfigured && !relayDisabled) {
    detail.replaceChildren('Paired to ', codeEl(c.relayBase || '?'));
    if (c.relayUserId) detail.append(' as user ', codeEl(c.relayUserId));
    detail.append('. Device token ', codeEl(mask(c.deviceToken)), '. ');
    detail.append(localDisabled
      ? 'Local broker is disabled.'
      : 'Local broker also active (Claude Code / Desktop).');
  } else if (c.relayAuthError) {
    detail.textContent = c.relayAuthError;
  } else if (relayConfigured && relayDisabled) {
    detail.textContent = 'Paired, but the cloud relay is disabled — only the local broker is active.';
  } else {
    detail.textContent = 'Using the localhost broker (Claude Code / Desktop). Not paired with a cloud relay.';
  }

  // Pre-fill the relay base from the last-used value so the user rarely re-types it.
  if (c.relayBase) $('relayBase').value = c.relayBase;

  // Toggle the local/relay control button label to match what it will do.
  const localBtn = $('local-btn');
  if (localBtn) {
    localBtn.textContent = relayConfigured && !relayDisabled
      ? 'Disable cloud relay (keep local broker)'
      : 'Use local broker only';
  }

  if (c.relayAuthError && relayDisabled) showMsg(c.relayAuthError, 'err');
}

// Ask background.js to bring the relay transport up LIVE after a fresh pairing
// (no extension reload). Returns true if it started live; false means a reload
// was triggered (re-pair carrying a new token, or background was unreachable).
async function bringRelayUp() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'fastlink:relay-paired' });
    if (resp?.needsReload) { setTimeout(() => chrome.runtime.reload(), 600); return false; }
    return true;
  } catch {
    setTimeout(() => chrome.runtime.reload(), 600);
    return false;
  }
}

// One-click: chrome.identity.launchWebAuthFlow → relay mints the device token →
// store + start the relay live. No code paste, no reload.
async function onSignIn() {
  const btn = $('signin-btn');
  btn.disabled = true;
  showMsg('Opening the sign-in window…', 'ok');
  try {
    const { userId } = await authorizeViaWebAuthFlow($('relayBase').value);
    const live = await bringRelayUp();
    showMsg(live
      ? `Connected${userId ? ` as ${userId}` : ''}. The cloud relay is now active.`
      : `Connected${userId ? ` as ${userId}` : ''}. Reloading FastLink to apply…`, 'ok');
    if (live) render();
  } catch (e) {
    showMsg(e?.message || String(e), 'err');
  } finally {
    btn.disabled = false;
  }
}

async function onPair() {
  const btn = $('pair-btn');
  const relayBase = $('relayBase').value;
  const code = $('code').value;
  btn.disabled = true;
  showMsg('Pairing…', 'ok');
  try {
    const { userId } = await claimPairingCode(code, relayBase);
    const live = await bringRelayUp();
    showMsg(live
      ? `Paired${userId ? ` as ${userId}` : ''}. The cloud relay is now active.`
      : `Paired${userId ? ` as ${userId}` : ''}. Reloading FastLink to connect…`, 'ok');
    if (live) render();
  } catch (e) {
    showMsg(e?.message || String(e), 'err');
  } finally {
    btn.disabled = false;
  }
}

// Advanced control = the optional `debugger` permission. chrome.permissions
// .request() MUST run in a user gesture (this button click). Reflect granted
// state; allow revoke. When OFF, FastLink runs DOM-only (coordinate input /
// fast_evaluate / background capture return a clear "enable advanced control".)
async function renderDebugger() {
  const pill = $('dbg-pill');
  const btn = $('dbg-btn');
  const detail = $('dbg-detail');
  if (!pill || !btn) return;
  let has = false;
  try { has = await chrome.permissions.contains({ permissions: ['debugger'] }); } catch {}
  if (has) {
    pill.textContent = 'On'; pill.className = 'pill ok';
    btn.textContent = 'Disable advanced control'; btn.dataset.act = 'remove';
    detail.textContent = 'Coordinate control + background-tab capture enabled.';
  } else {
    pill.textContent = 'Off'; pill.className = 'pill off';
    btn.textContent = 'Enable advanced control'; btn.dataset.act = 'request';
    detail.textContent = 'DOM-only mode — clicks/fills by selector still work.';
  }
}

async function onToggleDebugger() {
  const btn = $('dbg-btn');
  btn.disabled = true;
  try {
    if (btn.dataset.act === 'remove') {
      await chrome.permissions.remove({ permissions: ['debugger'] });
      showMsg('Advanced control disabled — FastLink is back to DOM-only.', 'ok');
    } else {
      const granted = await chrome.permissions.request({ permissions: ['debugger'] });
      showMsg(granted
        ? 'Advanced control enabled — coordinate control and background-tab capture are on.'
        : 'Advanced control was not granted. FastLink continues in DOM-only mode.', granted ? 'ok' : 'err');
    }
  } catch (e) {
    showMsg(e?.message || String(e), 'err');
  } finally {
    btn.disabled = false;
    renderDebugger();
  }
}

async function onUseLocal() {
  // Disable the cloud relay, keep the local broker. Writes the explicit flags
  // (and the legacy fastlinkMode for back-compat). Does not server-revoke the
  // device — the token simply stops being dialed.
  await chrome.storage.local.set({ fastlinkMode: 'local', localEnabled: true, relayEnabled: false });
  await chrome.storage.local.remove(['relayAuthError']);
  showMsg('Cloud relay disabled — using the local broker. Reloading FastLink…', 'ok');
  setTimeout(() => chrome.runtime.reload(), 600);
}

// Deep-link handoff: the relay's pairing page (or its copyable link) can open
// this page with ?relay=<url>&code=<code> to pre-fill both fields. Returns true
// when a code was supplied so the caller can focus the Pair button.
function applyDeepLinkParams() {
  let params;
  try { params = new URLSearchParams(location.search); } catch { return false; }
  const relay = params.get('relay');
  const code = params.get('code');
  if (relay) $('relayBase').value = relay;
  if (code) $('code').value = code;
  return !!code;
}

// Persist the relay base whenever the user edits it, so it's pre-filled next time.
$('relayBase').addEventListener('change', () => {
  const v = $('relayBase').value.trim();
  if (v) chrome.storage.local.set({ relayBase: v });
});

$('signin-btn').addEventListener('click', onSignIn);
$('pair-btn').addEventListener('click', onPair);
$('local-btn').addEventListener('click', onUseLocal);
$('dbg-btn').addEventListener('click', onToggleDebugger);
chrome.permissions.onAdded?.addListener(renderDebugger);
chrome.permissions.onRemoved?.addListener(renderDebugger);
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') onPair(); });

// Live-refresh the status card while the page is open as transports connect.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.fastlinkConn || changes.relayAuthError)) render();
});

async function init() {
  await render();
  renderDebugger();
  // Deep-link params win over stored/default values (they reflect a fresh code).
  if (applyDeepLinkParams()) {
    $('pair-btn').focus();
    showMsg('Pairing code loaded from the relay — click "Pair & use cloud relay".', 'ok');
  }
}
init();
