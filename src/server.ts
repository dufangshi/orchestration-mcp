import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createDefaultManager } from './app/orchestrator-app.js';
import { RunManager } from './core/run-manager.js';
import { registerCancelRunTool } from './tools/cancel-run.js';
import { registerContinueRunTool } from './tools/continue-run.js';
import { registerFetchAgentMessagesTool } from './tools/fetch-agent-messages.js';
import { registerGetEventArtifactTool } from './tools/get-event-artifact.js';
import { registerGetRunTool } from './tools/get-run.js';
import { registerListAgentsTool } from './tools/list-agents.js';
import { registerListRunsTool } from './tools/list-runs.js';
import { registerPollEventsTool } from './tools/poll-events.js';
import { registerSendAgentMessageTool } from './tools/send-agent-message.js';
import { registerSpawnRunTool } from './tools/spawn-run.js';

export { createDefaultManager } from './app/orchestrator-app.js';

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
  registerContinueRunTool(server, manager);
  registerListRunsTool(server, manager);
  registerListAgentsTool(server, manager);
  registerSendAgentMessageTool(server, manager);
  registerFetchAgentMessagesTool(server, manager);
  registerGetEventArtifactTool(server, manager);

  return server;
}
