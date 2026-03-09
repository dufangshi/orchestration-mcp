import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { RunManager } from '../core/run-manager.js';
import { asToolError, asToolResult, getRunSchema, runSummarySchema } from '../core/schemas.js';

export function registerGetRunTool(server: McpServer, manager: RunManager): void {
  server.registerTool(
    'get_run',
    {
      description: 'Get the current summary status for a known run.',
      inputSchema: getRunSchema,
      outputSchema: runSummarySchema,
    },
    async (args) => {
      try {
        const result = await manager.getRun(args);
        return asToolResult(result);
      } catch (error) {
        return asToolError(String(error));
      }
    },
  );
}
