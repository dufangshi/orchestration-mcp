import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { RunManager } from '../core/run-manager.js';
import {
  asToolError,
  asToolResult,
  sendAgentMessageResultSchema,
  sendAgentMessageSchema,
} from '../core/schemas.js';

export function registerSendAgentMessageTool(server: McpServer, manager: RunManager): void {
  server.registerTool(
    'send_agent_message',
    {
      description: 'Send a point-to-point message to another agent by agent_name.',
      inputSchema: sendAgentMessageSchema,
      outputSchema: sendAgentMessageResultSchema,
    },
    async (args) => {
      try {
        const result = await manager.sendAgentMessage(args);
        return asToolResult(result);
      } catch (error) {
        return asToolError(String(error));
      }
    },
  );
}
