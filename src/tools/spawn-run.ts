import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { RunManager } from '../core/run-manager.js';
import {
  asToolError,
  asToolResult,
  spawnRunResultSchema,
  spawnRunSchema,
} from '../core/schemas.js';

export function registerSpawnRunTool(server: McpServer, manager: RunManager): void {
  server.registerTool(
    'spawn_run',
    {
      description: 'Start a new external coding-agent run and return immediately.',
      inputSchema: spawnRunSchema,
      outputSchema: spawnRunResultSchema,
    },
    async (args) => {
      try {
        const result = await manager.spawnRun(args);
        return asToolResult(result);
      } catch (error) {
        return asToolError(String(error));
      }
    },
  );
}
