import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { RunManager } from '../core/run-manager.js';
import {
  asToolError,
  asToolResult,
  pollEventsResultSchema,
  pollEventsSchema,
} from '../core/schemas.js';

export function registerPollEventsTool(server: McpServer, manager: RunManager): void {
  server.registerTool(
    'poll_events',
    {
      description: 'Long-poll incremental events for a run after a known sequence number.',
      inputSchema: pollEventsSchema,
      outputSchema: pollEventsResultSchema,
    },
    async (args) => {
      try {
        const result = await manager.pollEvents(args);
        return asToolResult(result);
      } catch (error) {
        return asToolError(String(error));
      }
    },
  );
}
