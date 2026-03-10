export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type RunRole = 'planner' | 'worker' | 'reviewer';

export type BackendKind = 'codex' | 'claude_code';

export type SessionMode = 'new' | 'resume';

export type NormalizedEventType =
  | 'run_started'
  | 'status_changed'
  | 'agent_message'
  | 'reasoning'
  | 'command_started'
  | 'command_updated'
  | 'command_finished'
  | 'file_changed'
  | 'tool_started'
  | 'tool_finished'
  | 'todo_updated'
  | 'run_completed'
  | 'run_failed';

export interface RunResult {
  finalResponse: string | null;
  structuredOutput?: unknown;
  usage?: unknown;
}

export interface RunRecord {
  runId: string;
  backend: BackendKind;
  role: RunRole;
  sessionId: string;
  status: RunStatus;
  cwd: string;
  prompt: string;
  profile?: string;
  metadata: Record<string, unknown>;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastSeq: number;
  summary: string;
  result: RunResult | null;
  error: string | null;
}

export interface SessionRecord {
  sessionId: string;
  backend: BackendKind;
  cwd: string;
  backendSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface NormalizedEvent {
  seq: number;
  ts: string;
  run_id: string;
  session_id: string;
  backend: BackendKind;
  type: NormalizedEventType;
  data: Record<string, unknown>;
}

export interface SpawnRunInput {
  backend: BackendKind;
  role: RunRole;
  prompt: string;
  cwd: string;
  session_mode: SessionMode;
  session_id?: string;
  profile?: string;
  output_schema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface SpawnRunResult {
  run_id: string;
  backend: BackendKind;
  role: RunRole;
  session_id: string;
  status: RunStatus;
}

export interface GetRunInput {
  run_id: string;
}

export interface GetRunResult {
  run_id: string;
  backend: BackendKind;
  role: RunRole;
  session_id: string;
  status: RunStatus;
  started_at: string;
  updated_at: string;
  summary: string;
  last_seq: number;
  cwd: string;
  metadata: Record<string, unknown>;
}

export interface PollEventsInput {
  run_id: string;
  after_seq: number;
  limit?: number;
  wait_ms?: number;
}

export interface PollEventsResult {
  run_id: string;
  status: RunStatus;
  events: NormalizedEvent[];
  next_after_seq: number;
}

export interface CancelRunInput {
  run_id: string;
}

export interface CancelRunResult {
  run_id: string;
  status: RunStatus;
  cancelled_at: string;
}

export interface ListRunsInput {
  status?: RunStatus;
  backend?: BackendKind;
  cwd?: string;
}

export interface ListRunsResult {
  runs: GetRunResult[];
}

export interface AdapterSpawnParams {
  runId: string;
  role: RunRole;
  prompt: string;
  cwd: string;
  sessionMode: SessionMode;
  session: SessionRecord;
  profile?: string;
  outputSchema?: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface AdapterRunHandle {
  sessionId: string;
  eventStream: AsyncIterable<NormalizedEvent | AdapterRawEvent>;
  run(): Promise<void>;
  getSummary(): string;
  getResult(): RunResult | null;
}

export interface AdapterRawEvent {
  kind: 'raw';
  type: string;
  payload: unknown;
}

export interface RunAdapter {
  readonly backend: BackendKind;
  spawn(params: AdapterSpawnParams): Promise<AdapterRunHandle>;
  cancel(handle: AdapterRunHandle): Promise<void>;
}
