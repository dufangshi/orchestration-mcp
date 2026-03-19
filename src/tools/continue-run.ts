import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { RunManager } from '../core/run-manager.js';
import {
  asToolError,
  asToolResult,
  continueRunResultSchema,
  continueRunSchema,
} from '../core/schemas.js';

export function registerContinueRunTool(server: McpServer, manager: RunManager): void {
  server.registerTool(
    'continue_run',
    {
      description:
        'Send an additional input message to a waiting run, or resume a recoverable failed session with a new run.',
      inputSchema: continueRunSchema,
      outputSchema: continueRunResultSchema,
    },
    async (args) => {
      try {
        const result = await manager.continueRun(args);
        return asToolResult(result);
      } catch (error) {
        return asToolError(String(error));
      }
    },
  );
}
