import * as z from 'zod/v4';

export const backendKindSchema = z.enum(['codex', 'claude_code']);
export const runRoleSchema = z.enum(['planner', 'worker', 'reviewer']);
export const runStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export const sessionModeSchema = z.enum(['new', 'resume']);

const unknownObjectSchema = z.record(z.string(), z.unknown());

export const spawnRunSchema = z
  .object({
    backend: backendKindSchema.describe(
      'Backend to execute the run. Supported values are "codex" and "claude_code".',
    ),
    role: runRoleSchema.describe('Supervisor role for this run: planner, worker, or reviewer.'),
    prompt: z.string().min(1).describe('Primary instruction for the coding agent run.'),
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
  })
  .superRefine((value, ctx) => {
    if (value.session_mode === 'resume' && !value.session_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['session_id'],
        message: 'session_id is required when session_mode is resume',
      });
    }
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

export const listRunsSchema = z.object({
  status: runStatusSchema.optional(),
  backend: backendKindSchema.optional(),
  cwd: z.string().min(1).optional(),
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
    'reasoning',
    'command_started',
    'command_updated',
    'command_finished',
    'file_changed',
    'tool_started',
    'tool_finished',
    'todo_updated',
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
});

export const spawnRunResultSchema = z.object({
  run_id: z.string(),
  backend: backendKindSchema,
  role: runRoleSchema,
  session_id: z.string(),
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
