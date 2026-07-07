import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS } from './tools.js';
import { handleCall } from './handlers.js';
import { HTTP_PORT, TOKEN } from './config.js';
import { log } from './log.js';

// Guidance the client (Claude) sees in the initialize result — steers it toward
// the FAST tools instead of its default "screenshot + read it myself" instinct.
const INSTRUCTIONS = [
  'THIS IS THE LOCAL FastLink connector (named "fastlink") — Claude Code on the user\'s own machine drives the browser through the local broker. No pairing, no token, no OAuth. If a separate CLOUD connector is ALSO listed (server "fastlink-relay" / shown as "claude.ai Fastlink"), PREFER THIS LOCAL ONE for CLI sessions; that cloud connector is for claude.ai web and needs the browser paired to a relay account. FASTLINK_TOKEN is NOT used here — it is an unrelated, optional local-HTTP secret; never treat a missing FASTLINK_TOKEN as the cause of a connection problem.',
  '',
  'FastLink drives the user\'s real Chrome tab. Use it efficiently:',
  '- READ a page with fast_snapshot — a fast, structured index of the DOM (readable text + clickable elements with coords). Do NOT take a screenshot to read content. (fast_scout can pre-read a page so you plan in one pass.)',
  '- LOCATE/click something NOT in the DOM (canvas, opaque/cross-origin iframe, image, custom-rendered UI) with fast_point or fast_locate (fast_fill_vision to fill a visual form). Gemini reads the screenshot and returns the pixel coordinates FOR you — never screenshot-and-read-it-yourself; that is slow and token-heavy. fast_screenshot is for VISUAL CONFIRMATION only, never to read/parse page content.',
  '- CHAIN a known multi-step sequence in ONE call with fast_batch (e.g. navigate → fill → click → wait) to cut round-trips.',
  '- Fill multi-field forms with fast_fill_form in one call, not field-by-field.',
  '- Action results (fast_click / fast_fill / fast_wait) already include a snapshot — chain off THAT; do not issue a separate fast_snapshot right after.',
  '- Do NOT add artificial waits/sleeps — tabs load fast. Use fast_wait only when there is a real async signal (new view text, network idle), not as a reflex after every action.',
  '',
  'WHICH TOOL WHEN (rule of thumb: snapshot to read → DOM tools to act → vision only when the element is not in the DOM or the page is too heavy → batch when the path is known):',
  '- DEFAULT TO DOM TOOLS for normal HTML pages (the vast majority). Read with fast_snapshot; act with fast_click / fast_fill / fast_fill_form / fast_select_option. They are the fastest and most precise — TRY DOM FIRST.',
  '- USE VISION TOOLS (fast_point / fast_locate / fast_fill_vision) ONLY when DOM can\'t see or reach the target: canvas/WebGL, cross-origin iframes, image-only or custom-rendered UIs, or when DOM tools return nothing / freeze on a very heavy page. Gemini reads the screenshot and returns coordinates. Vision is a FALLBACK, not the default.',
  '- USE fast_batch when you already KNOW the full step sequence (navigate → fill → click → wait) to cut round-trips. DON\'T batch when you must SEE a step\'s result before deciding the next (exploratory/branching flows) — run those one at a time.',
  '- USE fast_scout to pre-read a complex/unfamiliar page so you can plan the whole interaction in one pass before acting.',
].join('\n');

function createMcpServer() {
  const server = new Server({ name: 'fastlink', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => handleCall(req.params.name, req.params.arguments));
  return server;
}

export async function startStdio() {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  log('stdio transport connected');
}

export function startHttp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/mcp', authMiddleware);

  app.post('/mcp', async (req, res) => {
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createMcpServer();
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log(`http /mcp error: ${e.message}`);
      if (!res.headersSent) res.status(500).json({ error: 'internal' });
    }
  });

  return new Promise((resolve) => {
    const httpServer = app.listen(HTTP_PORT, '127.0.0.1', () => {
      log(`http MCP listening on :${HTTP_PORT}/mcp ${TOKEN ? '(auth required)' : '(NO AUTH — localhost only)'}`);
      resolve();
    });
    httpServer.on('error', (e) => {
      if (e.code === 'EADDRINUSE') log(`http port ${HTTP_PORT} already bound — another server has it. Skipping HTTP.`);
      else log(`http server error: ${e.message}`);
      resolve();
    });
  });
}

function authMiddleware(req, res, next) {
  if (!TOKEN) return next();
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m || m[1] !== TOKEN) {
    log(`http auth rejected: ${req.ip}`);
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
