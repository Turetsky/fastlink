// onboarding.js — first-run flow (SIGNUP-SPEC §2, §3 ext-auth).
// Step 1: one-click "Sign in & connect" via chrome.identity.launchWebAuthFlow
// (authorizeViaWebAuthFlow) → relay hands back a device token → we ask
// background.js to bring the relay transport up LIVE (no extension reload, so
// this page survives to show the connected state + step 2). If the auth window
// fails, authorizeViaTabPoll opens a regular sign-in tab automatically; manual
// pairing-code entry stays as the LAST-resort fallback behind a disclosure.
// Step 2: shows the claude.ai connector URL with a Copy button + instructions.

import { authorizeViaWebAuthFlow, authorizeViaTabPoll, claimPairingCode } from './src/relayClient.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_RELAY_BASE = 'https://relay.ytx.app';

function showMsg(text, kind) {
  const el = $('msg');
  el.textContent = text;
  el.className = `msg ${kind}`;
}

function relayBaseValue() {
  return ($('relayBase').value || '').trim() || DEFAULT_RELAY_BASE;
}

function connectorUrl(base) {
  return `${String(base || DEFAULT_RELAY_BASE).replace(/\/+$/, '')}/mcp`;
}

function pairNewUrl(base) {
  return `${String(base || DEFAULT_RELAY_BASE).replace(/\/+$/, '')}/pair/new`;
}

// Reflect the vision/scout key state into step 2 (mirrors step 1's live status):
// enabled → green pill + compact "saved ✓ / change" row; otherwise the input +
// get-a-key guide. The Gemini key lives on the relay (device-token-authed); this
// only reflects whether one is on file.
function paintVision(enabled) {
  const pill = $('vision-pill');
  const field = $('gemini-field');
  const saved = $('gemini-saved');
  if (enabled) {
    pill.textContent = 'Enabled';
    pill.className = 'pill ok';
    field.style.display = 'none';
    saved.style.display = 'flex';
    $('gemini-btn').textContent = 'Update key';
  } else {
    pill.textContent = 'Recommended';
    pill.className = 'pill rec';
    saved.style.display = 'none';
    field.style.display = '';
  }
}

// Reflect connection state into the step cards. Steps 2–4 (optional Gemini key,
// add-to-claude.ai, watch-Claude) unlock once the browser is paired.
function paintConnected(connected, relayBase) {
  const pill = $('conn-pill');
  const step1 = $('step1');
  $('connector-url').textContent = connectorUrl(relayBase);

  const later = ['step2', 'step3', 'step4'];
  if (connected) {
    pill.textContent = 'Connected';
    pill.className = 'pill ok';
    step1.classList.remove('locked'); step1.classList.add('done');
    $('num1').textContent = '✓';
    $('step1-detail').textContent = 'This browser is paired with the relay. Finish the steps below to start driving.';
    $('signin-btn').textContent = 'Re-pair this browser';
    $('signin-btn').classList.remove('primary'); $('signin-btn').classList.add('ghost', 'small');
    later.forEach((id) => $(id).classList.remove('locked'));
  } else {
    pill.textContent = 'Not connected';
    pill.className = 'pill off';
    step1.classList.remove('done'); step1.classList.add('locked');
    later.forEach((id) => $(id).classList.add('locked'));
  }
}

// Optional BYO vision key (SIGNUP-SPEC §5.3): device-token-authed, so the user
// never leaves the browser. FastLink is fully usable without it (DOM-only).
async function onSaveGeminiKey() {
  const key = ($('geminiKey').value || '').trim();
  const btn = $('gemini-btn');
  const msg = $('gemini-msg');
  if (!key) { msg.textContent = 'Paste a Gemini API key, or skip this step.'; msg.className = 'msg info'; return; }
  btn.disabled = true;
  msg.textContent = 'Saving key…'; msg.className = 'msg info';
  try {
    const c = await chrome.storage.local.get(['relayBase', 'deviceToken']);
    if (!c.deviceToken) throw new Error('Connect this browser first (step 1).');
    const base = String(c.relayBase || DEFAULT_RELAY_BASE).replace(/\/+$/, '');
    const res = await fetch(`${base}/settings/gemini-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceToken: c.deviceToken, key }),
    });
    if (!res.ok) {
      let b = {}; try { b = await res.json(); } catch {}
      const FRIENDLY = {
        invalid_device_token: 'This browser is no longer paired — re-pair it in step 1.',
        invalid_json: 'The relay rejected the request.',
      };
      throw new Error(FRIENDLY[b?.error] || b?.error || `Could not save the key (HTTP ${res.status}).`);
    }
    let body = {}; try { body = await res.json(); } catch {}
    $('geminiKey').value = '';
    const removed = body.hasKey === false;
    paintVision(!removed);   // flip step 2 to green/enabled (or back) without a reload
    msg.textContent = removed
      ? 'Vision key removed — FastLink continues to work DOM-only.'
      : 'Vision enabled — the scout / vision speed tier is now active for this account.';
    msg.className = 'msg ok';
  } catch (e) {
    msg.textContent = e?.message || String(e);
    msg.className = 'msg err';
  } finally {
    btn.disabled = false;
  }
}

// After a fresh pairing: ask background to start the relay transport live.
// If background reports the relay was ALREADY running (a re-pair), it still
// holds the old token, so fall back to a reload to pick up the new one.
async function bringRelayUp() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'fastlink:relay-paired' });
    if (resp?.needsReload) {
      showMsg('Re-paired. Reloading FastLink to apply…', 'info');
      setTimeout(() => chrome.runtime.reload(), 600);
      return false;
    }
  } catch {
    // Background may have been asleep / message dropped; a reload is the safe
    // fallback to pick up the new config.
    setTimeout(() => chrome.runtime.reload(), 600);
    return false;
  }
  return true;
}

async function onSignIn() {
  const btn = $('signin-btn');
  btn.disabled = true;
  $('signin-hint').textContent = 'Opening sign-in…';
  showMsg('Opening the sign-in window…', 'info');
  try {
    const base = relayBaseValue();
    // launchWebAuthFlow first; on failure (popup blocked, flow error, 2nd-profile
    // quirks) fall back to the automatic tab-poll flow — same as options.js. The
    // pairing-code disclosure stays as the last resort.
    let userId;
    try {
      ({ userId } = await authorizeViaWebAuthFlow(base));
    } catch {
      $('signin-hint').textContent = 'Opening a sign-in tab instead…';
      showMsg('Opening a sign-in tab instead…', 'info');
      ({ userId } = await authorizeViaTabPoll(base));
    }
    const live = await bringRelayUp();
    if (live) {
      paintConnected(true, base);
      showMsg(`Connected${userId ? ` as ${userId}` : ''}. Now add FastLink to claude.ai below.`, 'ok');
    }
  } catch (e) {
    showMsg(e?.message || String(e), 'err');
  } finally {
    btn.disabled = false;
    $('signin-hint').textContent = '';
  }
}

async function onManualPair() {
  const btn = $('pair-btn');
  btn.disabled = true;
  showMsg('Pairing…', 'info');
  try {
    const base = relayBaseValue();
    const { userId } = await claimPairingCode($('code').value, base);
    const live = await bringRelayUp();
    if (live) {
      paintConnected(true, base);
      showMsg(`Paired${userId ? ` as ${userId}` : ''}. Now add FastLink to claude.ai below.`, 'ok');
    }
  } catch (e) {
    showMsg(e?.message || String(e), 'err');
  } finally {
    btn.disabled = false;
  }
}

async function onCopy() {
  const url = $('connector-url').textContent;
  try {
    await navigator.clipboard.writeText(url);
    const b = $('copy-btn');
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  } catch {
    showMsg(`Copy failed — select and copy manually: ${url}`, 'err');
  }
}

// Keep the "Generate a code →" link pointed at the (possibly customized) relay.
function syncGenCodeLink() {
  const a = $('gen-code');
  if (a) a.href = pairNewUrl(relayBaseValue());
}

$('signin-btn').addEventListener('click', onSignIn);
$('pair-btn').addEventListener('click', onManualPair);
$('copy-btn').addEventListener('click', onCopy);
$('gemini-btn').addEventListener('click', onSaveGeminiKey);
$('gemini-change').addEventListener('click', () => {
  // Reveal the input to replace the key; keep the green "Enabled" pill.
  $('gemini-saved').style.display = 'none';
  $('gemini-field').style.display = '';
  $('geminiKey').focus();
});
$('relayBase').addEventListener('input', syncGenCodeLink);
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') onManualPair(); });
$('geminiKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') onSaveGeminiKey(); });

// Live-refresh if the relay connects/drops while this page is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.fastlinkConn || changes.deviceToken || changes.relayAuthError) refresh();
});

// Reflect whether a vision key is already on file (returning users), using the
// read-only GET (never returns the key). Silent if the endpoint isn't live yet.
async function reflectVisionStatus(base, deviceToken) {
  if (!deviceToken) return;
  try {
    const res = await fetch(
      `${String(base).replace(/\/+$/, '')}/settings/gemini-key?deviceToken=${encodeURIComponent(deviceToken)}`,
    );
    if (!res.ok) return;
    const b = await res.json();
    if (b?.hasKey) paintVision(true);
  } catch {}
}

async function refresh() {
  const c = await chrome.storage.local.get(['deviceToken', 'relayBase', 'fastlinkConn', 'relayEnabled', 'fastlinkMode']);
  const base = c.relayBase || DEFAULT_RELAY_BASE;
  if (c.relayBase) $('relayBase').value = c.relayBase;
  const relayDisabled = c.relayEnabled === false || c.fastlinkMode === 'local';
  const connected = !!c.deviceToken && !relayDisabled;
  paintConnected(connected, base);
  syncGenCodeLink();
  if (connected) reflectVisionStatus(base, c.deviceToken);
}

refresh();
