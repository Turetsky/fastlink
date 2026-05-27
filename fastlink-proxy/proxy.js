#!/usr/bin/env node
// Stdio MCP proxy → remote HTTP MCP at FASTLINK URL with Bearer auth.
// Lets cloud Claude Code (which spawns stdio MCPs but can't supply auth headers
// to remote HTTP MCPs) reach our authenticated tunnel.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const REMOTE_URL = process.env.FASTLINK_URL || 'https://fastlink.ytx.app/mcp';
const TOKEN = process.env.FASTLINK_TOKEN;
if (!TOKEN) {
  process.stderr.write('[fastlink-proxy] FASTLINK_TOKEN env var is required\n');
  process.exit(1);
}

const log = (m) => process.stderr.write(`[fastlink-proxy] ${m}\n`);

const client = new Client(
  { name: 'fastlink-proxy', version: '0.1.0' },
  { capabilities: {} }
);

const transport = new StreamableHTTPClientTransport(new URL(REMOTE_URL), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
});

await client.connect(transport);
log(`connected to remote ${REMOTE_URL}`);

const server = new Server(
  { name: 'fastlink', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return await client.listTools();
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return await client.callTool(request.params);
});

await server.connect(new StdioServerTransport());
log('stdio transport connected');
