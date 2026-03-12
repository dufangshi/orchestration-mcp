import * as z from 'zod/v4';

export const backendKindSchema = z.enum(['codex', 'claude_code', 'remote_a2a']);
export const runRoleSchema = z.enum(['planner', 'worker', 'reviewer']);
export const runStatusSchema = z.enum([
  'queued',
  'running',
  'input_required',
  'auth_required',
  'completed',
  'failed',
  'cancelled',
  'rejected',
]);
export const sessionModeSchema = z.enum(['new', 'resume']);

const unknownObjectSchema = z.record(z.string(), z.unknown());

const textMessagePartSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(1),
});

const dataMessagePartSchema = z.object({
  type: z.literal('data'),
  data: unknownObjectSchema,
});

const fileMessagePartSchema = z.object({
  type: z.literal('file'),
  uri: z.string().min(1).optional(),
  bytes_base64: z.string().min(1).optional(),
  mime_type: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});

export const messagePartSchema = z.discriminatedUnion('type', [
  textMessagePartSchema,
  dataMessagePartSchema,
  fileMessagePartSchema,
]);

export const agentMessageSchema = z.object({
  role: z.enum(['user', 'agent', 'system']),
  parts: z.array(messagePartSchema).min(1),
  metadata: unknownObjectSchema.optional(),
});

export const remoteRefSchema = z.object({
  provider: backendKindSchema,
  conversation_id: z.string().nullable().optional(),
  task_id: z.string().nullable().optional(),
  context_id: z.string().nullable().optional(),
  agent_url: z.string().nullable().optional(),
  agent_name: z.string().nullable().optional(),
  metadata: unknownObjectSchema.optional(),
});

export const taskArtifactSchema = z.object({
  artifactId: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  parts: z.array(messagePartSchema).min(1),
  metadata: unknownObjectSchema.optional(),
});

export const spawnRunSchema = z
  .object({
    backend: backendKindSchema.describe(
      'Backend to execute the run. Supported values are "codex", "claude_code", and "remote_a2a".',
    ),
    role: runRoleSchema.describe('Supervisor role for this run: planner, worker, or reviewer.'),
    prompt: z.string().min(1).optional().describe('Primary instruction for the coding agent run.'),
    input_message: agentMessageSchema
      .optional()
      .describe('Structured input message for multi-part or A2A-compatible runs.'),
    cwd: z
      .string()
      .min(1)
      .describe('Absolute working directory where the agent should run and where artifacts are stored.'),
    session_mode: sessionModeSchema.describe('Use "new" to create a fresh session or "resume" to continue an existing one.'),
    session_id: z.string().min(1).optional(),
    profile: z
      .string()
      .min(1)
      .describe(
        'Optional path to a profile/persona/job-description file. Leave blank unless explicitly instructed to use a profile.',
      )
      .optional(),
    output_schema: unknownObjectSchema
      .describe('Optional JSON Schema for structured final output from the run.')
      .optional(),
    metadata: unknownObjectSchema
      .describe('Optional orchestration metadata for task/step correlation. It is stored but not interpreted by the MCP server.')
      .optional(),
    backend_config: unknownObjectSchema
      .describe('Optional backend-specific configuration, such as remote_a2a agent_url and auth headers.')
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.session_mode === 'resume' && !value.session_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['session_id'],
        message: 'session_id is required when session_mode is resume',
      });
    }
    if (!value.prompt && !value.input_message) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prompt'],
        message: 'Either prompt or input_message is required',
      });
    }
    if (value.backend === 'remote_a2a' && !value.backend_config?.agent_url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['backend_config', 'agent_url'],
        message: 'backend_config.agent_url is required when backend is remote_a2a',
      });
    }
  });

export const continueRunSchema = z.object({
  run_id: z.string().min(1),
  input_message: agentMessageSchema,
});

export const getRunSchema = z.object({
  run_id: z.string().min(1),
});

export const pollEventsSchema = z.object({
  run_id: z.string().min(1),
  after_seq: z.number().int().min(0),
  limit: z.number().int().min(1).max(1000).default(100),
  wait_ms: z.number().int().min(0).max(30000).default(20000),
});

export const cancelRunSchema = z.object({
  run_id: z.string().min(1),
});

export const getEventArtifactSchema = z.object({
  run_id: z.string().min(1),
  seq: z.number().int().min(1),
  field_path: z.string().min(1),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(262144).default(65536),
});

export const listRunsSchema = z.object({
  status: runStatusSchema.optional(),
  backend: backendKindSchema.optional(),
  cwd: z.string().min(1).optional(),
});

export const artifactRefSchema = z.object({
  field_path: z.string(),
  relpath: z.string(),
  mime: z.string(),
  encoding: z.string(),
  total_bytes: z.number().int().min(0),
  total_chars: z.number().int().min(0).optional(),
  chunk_count: z.number().int().min(1),
  truncated: z.boolean(),
});

export const normalizedEventSchema = z.object({
  seq: z.number().int().min(1),
  ts: z.string(),
  run_id: z.string(),
  session_id: z.string(),
  backend: backendKindSchema,
  type: z.enum([
    'run_started',
    'status_changed',
    'agent_message',
    'message_added',
    'reasoning',
    'command_started',
    'command_updated',
    'command_finished',
    'file_changed',
    'tool_started',
    'tool_finished',
    'artifact_added',
    'todo_updated',
    'input_required',
    'auth_required',
    'rejected',
    'run_completed',
    'run_failed',
  ]),
  data: unknownObjectSchema,
});

export const runSummarySchema = z.object({
  run_id: z.string(),
  backend: backendKindSchema,
  role: runRoleSchema,
  session_id: z.string(),
  status: runStatusSchema,
  started_at: z.string(),
  updated_at: z.string(),
  summary: z.string(),
  last_seq: z.number().int().min(0),
  cwd: z.string(),
  metadata: unknownObjectSchema,
  remote_ref: remoteRefSchema.nullable(),
});

export const spawnRunResultSchema = z.object({
  run_id: z.string(),
  backend: backendKindSchema,
  role: runRoleSchema,
  session_id: z.string(),
  status: runStatusSchema,
});

export const continueRunResultSchema = z.object({
  run_id: z.string(),
  status: runStatusSchema,
});

export const pollEventsResultSchema = z.object({
  run_id: z.string(),
  status: runStatusSchema,
  events: z.array(normalizedEventSchema),
  next_after_seq: z.number().int().min(0),
});

export const cancelRunResultSchema = z.object({
  run_id: z.string(),
  status: runStatusSchema,
  cancelled_at: z.string(),
});

export const listRunsResultSchema = z.object({
  runs: z.array(runSummarySchema),
});

export const getEventArtifactResultSchema = z.object({
  run_id: z.string(),
  seq: z.number().int().min(1),
  field_path: z.string(),
  mime: z.string(),
  encoding: z.string(),
  relpath: z.string(),
  total_bytes: z.number().int().min(0),
  offset: z.number().int().min(0),
  returned_bytes: z.number().int().min(0),
  has_more: z.boolean(),
  content: z.string(),
});

export function asToolResult<T extends object>(payload: T): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}

export function asToolError(message: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}
