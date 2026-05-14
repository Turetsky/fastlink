// Dev convenience: exit on source change so the parent respawns with fresh
// code. OFF by default — any process that touches mtime (editor autosave,
// file indexer, sync tools) would otherwise kill the MCP mid-session and
// surface as "Connection closed" with no other signal. Opt in with
// FASTLINK_HOTRELOAD=1 when actively developing.

import { watch } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from './log.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTED_AT = Date.now();
const GRACE_MS = 3_000;
let dying = false;

export function startHotReload() {
  if (process.env.FASTLINK_HOTRELOAD !== '1') return;
  log('hot-reload enabled (FASTLINK_HOTRELOAD=1)');
  watch(HERE, { persistent: false }, (_event, filename) => {
    if (dying || !filename || !filename.endsWith('.js')) return;
    if (Date.now() - STARTED_AT < GRACE_MS) return;
    dying = true;
    log(`source changed (${filename}), exiting for hot-reload`);
    setTimeout(() => process.exit(0), 100);
  });
}
