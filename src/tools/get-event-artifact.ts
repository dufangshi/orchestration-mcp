import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { RunManager } from '../core/run-manager.js';
import {
  asToolError,
  asToolResult,
  getEventArtifactResultSchema,
  getEventArtifactSchema,
} from '../core/schemas.js';

export function registerGetEventArtifactTool(server: McpServer, manager: RunManager): void {
  server.registerTool(
    'get_event_artifact',
    {
      description: 'Read a sanitized event artifact by run_id or agent_name, seq, and JSON Pointer field_path.',
      inputSchema: getEventArtifactSchema,
      outputSchema: getEventArtifactResultSchema,
    },
    async (args) => {
      try {
        const result = await manager.getEventArtifact(args);
        return asToolResult(result);
      } catch (error) {
        return asToolError(String(error));
      }
    },
  );
}
