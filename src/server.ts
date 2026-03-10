import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ClaudeCodeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { RunManager } from './core/run-manager.js';
import { registerCancelRunTool } from './tools/cancel-run.js';
import { registerGetEventArtifactTool } from './tools/get-event-artifact.js';
import { registerGetRunTool } from './tools/get-run.js';
import { registerListRunsTool } from './tools/list-runs.js';
import { registerPollEventsTool } from './tools/poll-events.js';
import { registerSpawnRunTool } from './tools/spawn-run.js';

export function createDefaultManager(): RunManager {
  return new RunManager([new CodexAdapter(), new ClaudeCodeAdapter()]);
}

export function createServer(options?: { manager?: RunManager }): McpServer {
  const server = new McpServer({
    name: 'nanobot-orchestration-mcp',
    version: '0.1.0',
  });

  const manager = options?.manager ?? createDefaultManager();

  registerSpawnRunTool(server, manager);
  registerGetRunTool(server, manager);
  registerPollEventsTool(server, manager);
  registerCancelRunTool(server, manager);
  registerListRunsTool(server, manager);
  registerGetEventArtifactTool(server, manager);

  return server;
}
