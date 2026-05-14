#!/usr/bin/env node
import { startExtBridge } from './extBridge.js';
import { startMcpBridge, hasMcpClients } from './mcpBridge.js';
import { state } from './state.js';
import { log, writePidFile, startIdleWatchdog } from './lifecycle.js';
import { startTunnel, stopTunnel } from './tunnel.js';

writePidFile();
startExtBridge();
startMcpBridge();
startTunnel();
startIdleWatchdog({ hasMcpClients, hasExtension: () => state.isExtensionConnected() });

// Make sure cloudflared dies when the broker dies — orphaning a tunnel would
// leave port 9879 reachable for a vanished server.
process.on('exit',    stopTunnel);
process.on('SIGINT',  () => { stopTunnel(); process.exit(0); });
process.on('SIGTERM', () => { stopTunnel(); process.exit(0); });

log(`broker ready (pid ${process.pid})`);
