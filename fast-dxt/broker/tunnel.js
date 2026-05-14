// Spawns a cloudflared tunnel as a child process so Claude Cloud (claude.ai)
// can reach the HTTP MCP transport at fastlink.ytx.app → localhost:9879.
// Skipped silently if ~/.cloudflared/config.yml doesn't exist (e.g. fresh
// install that hasn't set up a tunnel yet).

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { log } from './lifecycle.js';

const TUNNEL_CONFIG = join(homedir(), '.cloudflared', 'config.yml');
let proc = null;

export function startTunnel() {
  if (proc) return;
  if (!existsSync(TUNNEL_CONFIG)) {
    log('no ~/.cloudflared/config.yml — skipping tunnel');
    return;
  }
  log('starting cloudflared tunnel');
  try {
    proc = spawn('cloudflared', ['tunnel', '--config', TUNNEL_CONFIG, 'run'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    log(`cloudflared spawn failed: ${e.message}`);
    proc = null;
    return;
  }
  const onData = (tag) => (d) => {
    for (const line of d.toString().split('\n')) {
      const t = line.trim();
      if (t) log(`[cloudflared/${tag}] ${t}`);
    }
  };
  proc.stdout?.on('data', onData('out'));
  proc.stderr?.on('data', onData('err'));
  proc.on('exit', (code) => {
    log(`cloudflared exited (code ${code})`);
    proc = null;
  });
  proc.on('error', (e) => log(`cloudflared error: ${e.message}`));
}

export function stopTunnel() {
  if (!proc) return;
  try { proc.kill('SIGTERM'); } catch {}
  proc = null;
}
