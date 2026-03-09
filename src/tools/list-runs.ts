import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { RunManager } from '../core/run-manager.js';
import { asToolError, asToolResult, listRunsResultSchema, listRunsSchema } from '../core/schemas.js';

export function registerListRunsTool(server: McpServer, manager: RunManager): void {
  server.registerTool(
    'list_runs',
    {
      description: 'List runs known to the current orchestration MCP process.',
      inputSchema: listRunsSchema,
      outputSchema: listRunsResultSchema,
    },
    async (args) => {
      try {
        const result = await manager.listRuns(args);
        return asToolResult(result);
      } catch (error) {
        return asToolError(String(error));
      }
    },
  );
}
