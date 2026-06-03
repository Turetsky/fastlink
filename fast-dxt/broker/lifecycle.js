import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PID_FILE = join(tmpdir(), 'fastlink-broker.pid');
const IDLE_MS = 60_000;
const IDLE_POLL_MS = 5_000;

export const log = (msg) => {
  process.stderr.write(`[broker] ${new Date().toISOString()} ${msg}\n`);
};

export function writePidFile() {
  writeFileSync(PID_FILE, String(process.pid));
  process.on('exit', () => { try { unlinkSync(PID_FILE); } catch {} });
}

export function startIdleWatchdog({ hasMcpClients, hasExtension }) {
  let idleSince = null;
  setInterval(() => {
    const idle = !hasMcpClients() && !hasExtension();
    if (!idle) { idleSince = null; return; }
    if (!idleSince) idleSince = Date.now();
    else if (Date.now() - idleSince > IDLE_MS) {
      log('idle 60s, exiting');
      process.exit(0);
    }
  }, IDLE_POLL_MS).unref?.();
}

export function onFatalListenError(label, port, e) {
  if (e.code === 'EADDRINUSE') {
    log(`${label} port ${port} already bound — another broker is running. Exiting.`);
    process.exit(0);
  }
  log(`${label} WSS error: ${e.message}`);
  process.exit(1);
}
