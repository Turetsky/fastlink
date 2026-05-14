import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS } from './tools.js';
import { handleCall } from './handlers.js';
import { HTTP_PORT, TOKEN } from './config.js';
import { log } from './log.js';

function createMcpServer() {
  const server = new Server({ name: 'fastlink', version: '1.0.0' }, { capabilities: { tools: {} } });
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
