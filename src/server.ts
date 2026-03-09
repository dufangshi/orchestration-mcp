import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { CodexAdapter } from './adapters/codex.js';
import { RunManager } from './core/run-manager.js';
import { registerCancelRunTool } from './tools/cancel-run.js';
import { registerGetRunTool } from './tools/get-run.js';
import { registerListRunsTool } from './tools/list-runs.js';
import { registerPollEventsTool } from './tools/poll-events.js';
import { registerSpawnRunTool } from './tools/spawn-run.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'nanobot-orchestration-mcp',
    version: '0.1.0',
  });

  const manager = new RunManager([new CodexAdapter()]);

  registerSpawnRunTool(server, manager);
  registerGetRunTool(server, manager);
  registerPollEventsTool(server, manager);
  registerCancelRunTool(server, manager);
  registerListRunsTool(server, manager);

  return server;
}
