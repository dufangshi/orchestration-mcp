import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { RunManager } from '../core/run-manager.js';
import { asToolError, asToolResult, listAgentsResultSchema, listAgentsSchema } from '../core/schemas.js';

export function registerListAgentsTool(server: McpServer, manager: RunManager): void {
  server.registerTool(
    'list_agents',
    {
      description: 'List stable agent identities known to the current orchestration MCP process.',
      inputSchema: listAgentsSchema,
      outputSchema: listAgentsResultSchema,
    },
    async (args) => {
      try {
        const result = await manager.listAgents(args);
        return asToolResult(result);
      } catch (error) {
        return asToolError(String(error));
      }
    },
  );
}
