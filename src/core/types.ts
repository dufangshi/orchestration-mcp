export type RunStatus =
  | 'queued'
  | 'running'
  | 'input_required'
  | 'auth_required'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export type RunRole = 'planner' | 'worker' | 'reviewer';

export type BackendKind = 'codex' | 'claude_code' | 'remote_a2a';

export type SessionMode = 'new' | 'resume';

export type AgentDirectoryStatus = RunStatus | 'idle';

export type NormalizedEventType =
  | 'run_started'
  | 'status_changed'
  | 'agent_message'
  | 'message_added'
  | 'reasoning'
  | 'command_started'
  | 'command_updated'
  | 'command_finished'
  | 'file_changed'
  | 'tool_started'
  | 'tool_finished'
  | 'artifact_added'
  | 'todo_updated'
  | 'input_required'
  | 'auth_required'
  | 'rejected'
  | 'run_completed'
  | 'run_failed';

export type MessageRole = 'user' | 'agent' | 'system';

export interface TextMessagePart {
  type: 'text';
  text: string;
}

export interface DataMessagePart {
  type: 'data';
  data: Record<string, unknown>;
}

export interface FileMessagePart {
  type: 'file';
  uri?: string;
  bytes_base64?: string;
  mime_type?: string;
  name?: string;
}

export type MessagePart = TextMessagePart | DataMessagePart | FileMessagePart;

export interface AgentMessage {
  role: MessageRole;
  parts: MessagePart[];
  metadata?: Record<string, unknown>;
}

export interface TaskArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: MessagePart[];
  metadata?: Record<string, unknown>;
}

export interface RemoteRef {
  provider: BackendKind;
  conversation_id?: string | null;
  task_id?: string | null;
  context_id?: string | null;
  agent_url?: string | null;
  agent_name?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RunResult {
  finalResponse: string | null;
  structuredOutput?: unknown;
  usage?: unknown;
  artifacts?: TaskArtifact[];
}

export interface RunRecord {
  runId: string;
  backend: BackendKind;
  role: RunRole;
  sessionId: string;
  agentName?: string;
  status: RunStatus;
  cwd: string;
  prompt: string;
  profile?: string;
  metadata: Record<string, unknown>;
  remoteRef: RemoteRef | null;
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
  agentName?: string;
  backendSessionId: string | null;
  remoteRef: RemoteRef | null;
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

export interface ArtifactRef {
  field_path: string;
  relpath: string;
  mime: string;
  encoding: string;
  total_bytes: number;
  total_chars?: number;
  chunk_count: number;
  truncated: boolean;
}

export interface ArtifactWriteInstruction {
  field_path: string;
  mime: string;
  encoding: string;
  content: string;
  total_chars?: number;
  truncated: boolean;
}

export interface SpawnRunInput {
  backend: BackendKind;
  role: RunRole;
  nickname?: string;
  prompt?: string;
  input_message?: AgentMessage;
  cwd: string;
  session_mode: SessionMode;
  session_id?: string;
  profile?: string;
  output_schema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  backend_config?: Record<string, unknown>;
}

export interface SpawnRunResult {
  run_id: string;
  backend: BackendKind;
  role: RunRole;
  session_id: string;
  agent_name: string;
  status: RunStatus;
}

export interface RunReferenceInput {
  run_id?: string;
  agent_name?: string;
  cwd?: string;
}

export interface GetRunInput extends RunReferenceInput {
}

export interface GetRunResult {
  run_id: string;
  backend: BackendKind;
  role: RunRole;
  session_id: string;
  agent_name: string;
  status: RunStatus;
  started_at: string;
  updated_at: string;
  summary: string;
  last_seq: number;
  cwd: string;
  metadata: Record<string, unknown>;
  remote_ref: RemoteRef | null;
}

export interface PollEventsInput extends RunReferenceInput {
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

export interface CancelRunInput extends RunReferenceInput {
}

export interface CancelRunResult {
  run_id: string;
  status: RunStatus;
  cancelled_at: string;
}

export interface ContinueRunInput extends RunReferenceInput {
  input_message: AgentMessage;
}

export interface ContinueRunResult {
  run_id: string;
  status: RunStatus;
  session_id?: string;
  agent_name?: string;
  mode?: 'live' | 'resume';
  resumed_from_run_id?: string | null;
}

export interface GetEventArtifactInput extends RunReferenceInput {
  seq: number;
  field_path: string;
  offset?: number;
  limit?: number;
}

export interface GetEventArtifactResult {
  run_id: string;
  seq: number;
  field_path: string;
  mime: string;
  encoding: string;
  relpath: string;
  total_bytes: number;
  offset: number;
  returned_bytes: number;
  has_more: boolean;
  content: string;
}

export interface ListRunsInput {
  status?: RunStatus;
  backend?: BackendKind;
  cwd?: string;
}

export interface ListRunsResult {
  runs: GetRunResult[];
}

export interface SendAgentMessageInput {
  to_agent_name: string;
  from_agent_name?: string;
  cwd?: string;
  message: AgentMessage;
  metadata?: Record<string, unknown>;
}

export interface SendAgentMessageResult {
  message_id: string;
  to_agent_name: string;
  to_session_id: string;
  seq: number;
  created_at: string;
}

export interface AgentInboxMessage {
  message_id: string;
  seq: number;
  from_agent_name: string | null;
  from_session_id: string | null;
  to_agent_name: string;
  to_session_id: string;
  created_at: string;
  body: AgentMessage;
  metadata: Record<string, unknown>;
}

export interface FetchAgentMessagesInput {
  agent_name: string;
  cwd?: string;
  after_seq?: number;
  limit?: number;
}

export interface FetchAgentMessagesResult {
  agent_name: string;
  session_id: string;
  messages: AgentInboxMessage[];
  next_after_seq: number;
}

export interface AgentDirectoryEntry {
  agent_name: string;
  role: RunRole | null;
  session_id: string;
  status: AgentDirectoryStatus;
  cwd: string;
  last_run_id: string | null;
  updated_at: string;
}

export interface ListAgentsInput {
  cwd?: string;
  backend?: BackendKind;
  status?: AgentDirectoryStatus;
}

export interface ListAgentsResult {
  agents: AgentDirectoryEntry[];
}

export interface AdapterSpawnParams {
  runId: string;
  role: RunRole;
  prompt: string;
  inputMessage: AgentMessage;
  systemPrompt?: string;
  cwd: string;
  sessionMode: SessionMode;
  session: SessionRecord;
  profile?: string;
  outputSchema?: Record<string, unknown>;
  metadata: Record<string, unknown>;
  backendConfig: Record<string, unknown>;
}

export interface AdapterRunHandle {
  sessionId: string;
  eventStream: AsyncIterable<NormalizedEvent | AdapterRawEvent>;
  run(): Promise<void>;
  continue?(input: AgentMessage): Promise<void>;
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
  continue?(handle: AdapterRunHandle, input: AgentMessage): Promise<void>;
}
