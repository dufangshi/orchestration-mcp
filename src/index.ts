#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer } from './server.js';

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('nanobot orchestration MCP running on stdio');
}

main().catch((error) => {
  console.error('Failed to start orchestration MCP:', error);
  process.exit(1);
});
