#!/usr/bin/env node
import { startStdio, startHttp } from './transports.js';
import { startHotReload } from './hotReload.js';
import { getStatus, onBrokerEvent } from './brokerClient.js';
import { sweepOldScreenshots, prewarmScout, prewarmVision } from './handlers.js';
import { HTTP_ENABLED } from './config.js';

sweepOldScreenshots();
startHotReload();

// Pre-warm on every page load so the Gemini comprehension is ready before
// Claude acts: the DOM scout page map (prewarmScout) AND a vision visual map +
// reusable screenshot (prewarmVision, debounced & best-effort).
onBrokerEvent((evt) => {
  if (evt?.event !== 'navigated') return;
  prewarmScout();
  prewarmVision(evt.url);
});
await startStdio();
if (HTTP_ENABLED) await startHttp();

// Pre-warm the broker so the extension can auto-connect as soon as Chrome
// opens — without this, the broker spawns lazily on the first tool call,
// leaving the extension with nothing to attach to in the meantime.
getStatus().catch(() => {});
