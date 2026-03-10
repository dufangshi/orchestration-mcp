#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createDefaultManager, createServer } from './server.js';

async function main(): Promise<void> {
  const manager = createDefaultManager();
  const server = createServer({ manager });
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.error(`Received ${signal}, shutting down orchestration MCP`);
    try {
      await manager.shutdown();
      await server.close();
    } catch (error) {
      console.error('Failed during orchestration MCP shutdown:', error);
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await server.connect(transport);
  console.error('nanobot orchestration MCP running on stdio');
}

main().catch((error) => {
  console.error('Failed to start orchestration MCP:', error);
  process.exit(1);
});
