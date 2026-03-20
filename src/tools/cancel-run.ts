import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { RunManager } from '../core/run-manager.js';
import {
  asToolError,
  asToolResult,
  cancelRunResultSchema,
  cancelRunSchema,
} from '../core/schemas.js';

export function registerCancelRunTool(server: McpServer, manager: RunManager): void {
  server.registerTool(
    'cancel_run',
    {
      description: 'Cancel a running external coding-agent run by run_id or agent_name.',
      inputSchema: cancelRunSchema,
      outputSchema: cancelRunResultSchema,
    },
    async (args) => {
      try {
        const result = await manager.cancelRun(args);
        return asToolResult(result);
      } catch (error) {
        return asToolError(String(error));
      }
    },
  );
}
