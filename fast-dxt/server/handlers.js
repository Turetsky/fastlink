import { writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Buffer } from 'buffer';
import { callExtension, getStatus, getBrokerLinkInfo } from './brokerClient.js';
import { HTTP_ENABLED, HTTP_PORT, TOKEN } from './config.js';

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

export async function handleCall(name, args) {
  try {
    if (name === 'fast_status') return text(await statusReport());
    if (name === 'fast_batch')  return text(await runBatch(args));
    const payload = await callExtension(name, args || {});
    // Tool-level errors come back as resolved payloads with `error` set, plus
    // any extras (diagnostics, available, etc.). Surface them as text so the
    // LLM sees everything, not just the message.
    if (payload && typeof payload === 'object' && 'error' in payload) return text(payload);
    let result = payload?.result ?? null;
    if (name === 'fast_screenshot' && result?.dataUrl) return text(saveScreenshot(result));
    // Inline screenshot opt-in (fast_snapshot / fast_click / etc. with screenshot:true).
    if (result && typeof result === 'object' && result.screenshot?.dataUrl) {
      result.screenshot = saveScreenshot(result.screenshot);
    }
    return text(result);
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
}

async function statusReport() {
  const broker = await getStatus().catch(e => ({ error: e.message }));
  const link = getBrokerLinkInfo();
  const justReconnected = link.lastDisconnectAgoMs != null && link.lastDisconnectAgoMs < 10_000;

  const hints = [];
  if (broker?.connected) {
    hints.push('Extension connected. fast_snapshot/fast_click/fast_fill should work.');
    hints.push('If a DOM tool hangs or returns null on a specific tab, that tab likely loaded before the current extension version — reload it.');
  } else {
    hints.push('Extension NOT connected. Open chrome://extensions, find "FastLink", click its "service worker" link to see if it errored.');
  }
  if (justReconnected) {
    hints.push(`Broker link reconnected ${Math.round(link.lastDisconnectAgoMs / 1000)}s ago — if the last call failed with "Connection closed", retry it once.`);
  }
  return {
    ...broker,
    brokerLink: link,
    httpEnabled: HTTP_ENABLED,
    httpPort: HTTP_ENABLED ? HTTP_PORT : null,
    httpAuthRequired: HTTP_ENABLED && !!TOKEN,
    hint: hints.join(' '),
  };
}

// Same diagnostic-only set the extension enforces for macros — keep in sync.
const DIAGNOSTIC_ONLY_STEPS = new Set(['fast_status', 'fast_batch']);

async function runBatch(args) {
  const actions = Array.isArray(args?.actions) ? args.actions : [];
  const continueOnError = !!args?.continueOnError;
  const results = [];
  for (let i = 0; i < actions.length; i++) {
    const step = actions[i] || {};
    if (!step.name || DIAGNOSTIC_ONLY_STEPS.has(step.name)) {
      results.push({ step: i, name: step.name || null, error: step.name ? `"${step.name}" is a diagnostic-only tool (not allowed as a batch step)` : 'Invalid step (missing name)' });
      if (!continueOnError) break;
      continue;
    }
    try {
      const r = await callExtension(step.name, step.args || {});
      if (r && r.error) {
        results.push({ step: i, name: step.name, ok: false, ...r });
        if (!continueOnError) break;
      } else {
        results.push({ step: i, name: step.name, ok: true, result: r.result });
      }
    } catch (e) {
      results.push({ step: i, name: step.name, ok: false, error: e.message });
      if (!continueOnError) break;
    }
  }
  return { ran: results.length, total: actions.length, results };
}

function saveScreenshot(result) {
  const ext = (result.format || 'png').toLowerCase();
  const path = join(tmpdir(), `fast-browser-screenshot-${Date.now()}.${ext}`);
  const base64 = result.dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const bytes = Buffer.from(base64, 'base64');
  writeFileSync(path, bytes);
  sweepOldScreenshots();
  return { path, format: ext, bytes: bytes.length };
}

// Delete fast-browser-screenshot-* files older than 24h. Cheap readdir on
// /tmp; runs once at startup and again after each save.
const SCREENSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SCREENSHOT_PREFIX = 'fast-browser-screenshot-';
export function sweepOldScreenshots() {
  const dir = tmpdir();
  const cutoff = Date.now() - SCREENSHOT_MAX_AGE_MS;
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (!name.startsWith(SCREENSHOT_PREFIX)) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.mtimeMs < cutoff) unlinkSync(full);
    } catch {}
  }
}
