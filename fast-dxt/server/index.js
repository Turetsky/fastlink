#!/usr/bin/env node
import { startStdio, startHttp } from './transports.js';
import { startHotReload } from './hotReload.js';
import { getStatus } from './brokerClient.js';
import { sweepOldScreenshots } from './handlers.js';
import { HTTP_ENABLED } from './config.js';

sweepOldScreenshots();
startHotReload();
await startStdio();
if (HTTP_ENABLED) await startHttp();

// Pre-warm the broker so the extension can auto-connect as soon as Chrome
// opens — without this, the broker spawns lazily on the first tool call,
// leaving the extension with nothing to attach to in the meantime.
getStatus().catch(() => {});
