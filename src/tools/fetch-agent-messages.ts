import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { RunManager } from '../core/run-manager.js';
import {
  asToolError,
  asToolResult,
  fetchAgentMessagesResultSchema,
  fetchAgentMessagesSchema,
} from '../core/schemas.js';

export function registerFetchAgentMessagesTool(server: McpServer, manager: RunManager): void {
  server.registerTool(
    'fetch_agent_messages',
    {
      description: 'Fetch session inbox messages for an agent by agent_name.',
      inputSchema: fetchAgentMessagesSchema,
      outputSchema: fetchAgentMessagesResultSchema,
    },
    async (args) => {
      try {
        const result = await manager.fetchAgentMessages(args);
        return asToolResult(result);
      } catch (error) {
        return asToolError(String(error));
      }
    },
  );
}
