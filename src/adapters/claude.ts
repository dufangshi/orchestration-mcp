import {
  query,
  type Options as ClaudeOptions,
  type Query as ClaudeQuery,
  type SDKAssistantMessage,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { AsyncEventQueue } from './async-event-queue.js';
import { BaseRunAdapter } from './base.js';
import type {
  AdapterRunHandle,
  AdapterSpawnParams,
  NormalizedEvent,
  RunResult,
} from '../core/types.js';

type ClaudeQueryFactory = (params: {
  prompt: string;
  options: ClaudeOptions;
}) => ClaudeQuery;

interface ClaudeToolState {
  toolName: string;
  taskId?: string;
  input?: Record<string, unknown>;
  parentToolUseId?: string | null;
}

interface ToolResultPayload {
  toolUseIds: string[];
  isError?: boolean;
  text?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  interrupted?: boolean;
  rawOutputPath?: string;
  persistedOutputPath?: string;
  persistedOutputSize?: number;
  backgroundTaskId?: string;
  content?: unknown;
  rawToolUseResult?: unknown;
}

export function buildClaudeOptions(params: AdapterSpawnParams): ClaudeOptions {
  return {
    cwd: params.cwd,
    tools: {
      type: 'preset',
      preset: 'claude_code',
    },
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['user', 'project', 'local'],
    outputFormat: params.outputSchema
      ? {
          type: 'json_schema',
          schema: params.outputSchema,
        }
      : undefined,
    resume:
      params.sessionMode === 'resume' && params.session.backendSessionId
        ? params.session.backendSessionId
        : undefined,
    sessionId: params.sessionMode === 'new' ? params.session.sessionId : undefined,
  };
}

class ClaudeCodeRunHandle implements AdapterRunHandle {
  readonly sessionId: string;
  readonly eventStream: AsyncIterable<NormalizedEvent>;

  private readonly queue = new AsyncEventQueue<NormalizedEvent>();
  private readonly sdkQuery: ClaudeQuery;
  private readonly params: AdapterSpawnParams;
  private readonly activeTools = new Map<string, ClaudeToolState>();
  private readonly completedToolUseIds = new Set<string>();
  private readonly tasks = new Map<string, string>();
  private latestAgentMessage = '';
  private summary = 'Run queued';
  private result: RunResult | null = null;
  private runPromise: Promise<void> | null = null;
  private cancelled = false;
  private finished = false;

  constructor(sdkQuery: ClaudeQuery, params: AdapterSpawnParams) {
    this.sdkQuery = sdkQuery;
    this.params = params;
    this.sessionId = params.session.sessionId;
    this.eventStream = this.queue;
  }

  async run(): Promise<void> {
    if (this.runPromise) {
      return this.runPromise;
    }
    this.runPromise = this.doRun();
    return this.runPromise;
  }

  getSummary(): string {
    return this.summary;
  }

  getResult(): RunResult | null {
    return this.result;
  }

  abort(): void {
    this.cancelled = true;
    this.summary = 'Run cancelled';
    this.sdkQuery.close();
  }

  private async doRun(): Promise<void> {
    const runStartedData: Record<string, unknown> = {};
    if (this.params.session.backendSessionId) {
      runStartedData.backend_session_id = this.params.session.backendSessionId;
    }

    this.emit({
      seq: 0,
      ts: new Date().toISOString(),
      run_id: '',
      session_id: this.sessionId,
      backend: 'claude_code',
      type: 'run_started',
      data: runStartedData,
    });
    this.emit({
      seq: 0,
      ts: new Date().toISOString(),
      run_id: '',
      session_id: this.sessionId,
      backend: 'claude_code',
      type: 'status_changed',
      data: {
        status: 'running',
      },
    });

    try {
      for await (const message of this.sdkQuery) {
        this.handleMessage(message);
      }

      if (!this.finished && !this.cancelled) {
        this.result = {
          finalResponse: this.latestAgentMessage || null,
          structuredOutput: parseStructuredOutput(this.latestAgentMessage),
        };
        this.summary = 'Run completed';
        this.emit({
          seq: 0,
          ts: new Date().toISOString(),
          run_id: '',
          session_id: this.sessionId,
          backend: 'claude_code',
          type: 'run_completed',
          data: {
            final_response: this.result.finalResponse,
            structured_output: this.result.structuredOutput,
          },
        });
        this.finished = true;
      }
    } catch (error) {
      if (!this.cancelled) {
        this.summary = `Run failed: ${String(error)}`;
        this.emit({
          seq: 0,
          ts: new Date().toISOString(),
          run_id: '',
          session_id: this.sessionId,
          backend: 'claude_code',
          type: 'run_failed',
          data: {
            message: String(error),
          },
        });
        this.finished = true;
      }
    } finally {
      this.queue.end();
    }
  }

  private handleMessage(message: SDKMessage): void {
    switch (message.type) {
      case 'assistant':
        this.handleAssistantMessage(message);
        return;
      case 'result':
        this.handleResultMessage(message);
        return;
      case 'stream_event':
        return;
      case 'user':
        this.handleUserMessage(message);
        return;
      case 'tool_progress':
        this.handleToolProgress(message);
        return;
      case 'tool_use_summary':
        this.handleToolSummary(message);
        return;
      case 'auth_status':
        if (message.error) {
          this.summary = `Claude auth issue: ${message.error}`;
          this.emitReasoning(`Claude auth issue: ${message.error}`, {
            output: message.output,
          });
        }
        return;
      case 'prompt_suggestion':
        return;
      case 'rate_limit_event':
        this.summary = `Claude rate limit status: ${message.rate_limit_info.status}`;
        this.emitReasoning(`Claude rate limit status: ${message.rate_limit_info.status}`, {
          rate_limit_info: message.rate_limit_info,
        });
        return;
      case 'system':
        this.handleSystemMessage(message);
        return;
    }
  }

  private handleSystemMessage(message: Extract<SDKMessage, { type: 'system' }>): void {
    switch (message.subtype) {
      case 'init':
        this.summary = `Claude Code initialized in ${message.cwd}`;
        this.emit({
          seq: 0,
          ts: new Date().toISOString(),
          run_id: '',
          session_id: this.sessionId,
          backend: 'claude_code',
          type: 'status_changed',
          data: {
            status: 'running',
            backend_session_id: message.session_id,
            model: message.model,
            tools: message.tools,
            cwd: message.cwd,
          },
        });
        return;
      case 'status':
        if (message.status === 'compacting') {
          this.summary = 'Claude Code is compacting context';
          this.emitReasoning('Claude Code is compacting context', {
            status: message.status,
            permission_mode: message.permissionMode,
          });
        }
        return;
      case 'task_started':
        this.tasks.set(message.task_id, message.description);
        this.summary = `Task started: ${message.description}`;
        this.emitToolEvent('tool_started', {
          tool: 'Task',
          task_id: message.task_id,
          tool_use_id: message.tool_use_id,
          description: message.description,
          task_type: message.task_type,
          prompt: message.prompt,
        });
        return;
      case 'task_progress':
        this.summary = `Task progress: ${message.description}`;
        this.emitReasoning(`Task progress: ${message.description}`, {
          task_id: message.task_id,
          tool_use_id: message.tool_use_id,
          usage: message.usage,
          last_tool_name: message.last_tool_name,
        });
        return;
      case 'task_notification':
        this.summary = `Task ${message.status}: ${message.summary}`;
        this.emitToolEvent('tool_finished', {
          tool: 'Task',
          task_id: message.task_id,
          tool_use_id: message.tool_use_id,
          status: message.status,
          summary: message.summary,
          output_file: message.output_file,
          usage: message.usage,
        });
        return;
      case 'files_persisted':
        this.summary = `Persisted ${message.files.length} file(s)`;
        this.emit({
          seq: 0,
          ts: new Date().toISOString(),
          run_id: '',
          session_id: this.sessionId,
          backend: 'claude_code',
          type: 'file_changed',
          data: {
            changes: message.files.map((file) => ({
              path: file.filename,
              file_id: file.file_id,
            })),
            failed: message.failed,
            processed_at: message.processed_at,
          },
        });
        return;
      case 'local_command_output':
        this.summary = summarizeText(message.content, 'Claude emitted a local command output');
        this.emitAgentMessage(message.content, {
          local_command: true,
        });
        return;
      case 'hook_started':
        this.summary = `Hook started: ${message.hook_name}`;
        this.emitReasoning(`Hook started: ${message.hook_name}`, {
          hook_event: message.hook_event,
          hook_id: message.hook_id,
        });
        return;
      case 'hook_progress':
        this.summary = `Hook progress: ${message.hook_name}`;
        this.emitReasoning(`Hook progress: ${message.hook_name}`, {
          hook_event: message.hook_event,
          hook_id: message.hook_id,
          stdout: message.stdout,
          stderr: message.stderr,
          output: message.output,
        });
        return;
      case 'hook_response':
        this.summary = `Hook finished: ${message.hook_name}`;
        this.emitReasoning(`Hook finished: ${message.hook_name}`, {
          hook_event: message.hook_event,
          hook_id: message.hook_id,
          outcome: message.outcome,
          stdout: message.stdout,
          stderr: message.stderr,
          output: message.output,
          exit_code: message.exit_code,
        });
        return;
      case 'compact_boundary':
        this.summary = 'Claude compacted the session context';
        this.emitReasoning('Claude compacted the session context', {
          compact_metadata: message.compact_metadata,
        });
        return;
      case 'elicitation_complete':
        this.emitReasoning('Claude completed an MCP elicitation exchange', {
          mcp_server_name: message.mcp_server_name,
          elicitation_id: message.elicitation_id,
        });
        return;
    }
  }

  private handleAssistantMessage(message: SDKAssistantMessage): void {
    const textBlocks: string[] = [];

    for (const block of message.message.content) {
      const blockType = getStringProperty(block, 'type');
      if (blockType === 'text') {
        const text = getStringProperty(block, 'text');
        if (text) {
          textBlocks.push(text);
        }
        continue;
      }
      if (blockType === 'thinking') {
        const thinkingText = getStringProperty(block, 'thinking') ?? getStringProperty(block, 'text');
        if (thinkingText) {
          this.summary = 'Claude updated reasoning';
          this.emitReasoning(thinkingText);
        }
        continue;
      }
      if (blockType === 'redacted_thinking') {
        this.summary = 'Claude updated reasoning';
        this.emitReasoning('[redacted thinking]');
        continue;
      }
      if (blockType === 'tool_use' || blockType === 'server_tool_use') {
        const toolUseId = getStringProperty(block, 'id') ?? getStringProperty(block, 'tool_use_id');
        const toolName =
          getStringProperty(block, 'name') ??
          getStringProperty(block, 'tool_name') ??
          getStringProperty(block, 'server_name') ??
          'tool';
        const input = getObjectProperty(block, 'input');
        if (toolUseId) {
          this.activeTools.set(toolUseId, {
            toolName,
            input,
            parentToolUseId: message.parent_tool_use_id,
          });
        }
        this.emitToolStart({
          toolName,
          toolUseId,
          input,
          parentToolUseId: message.parent_tool_use_id,
        });
      }
    }

    const text = textBlocks.join('\n').trim();
    if (!text) {
      return;
    }

    this.latestAgentMessage = text;
    this.summary = summarizeText(text, 'Claude produced a response');
    this.emitAgentMessage(text, {
      assistant_error: message.error,
      parent_tool_use_id: message.parent_tool_use_id,
    });
  }

  private handleToolProgress(message: Extract<SDKMessage, { type: 'tool_progress' }>): void {
    let known = this.activeTools.get(message.tool_use_id);
    if (!known) {
      known = {
        toolName: message.tool_name,
        taskId: message.task_id,
        parentToolUseId: message.parent_tool_use_id,
      };
      this.activeTools.set(message.tool_use_id, known);
      this.emitToolStart({
        toolName: message.tool_name,
        toolUseId: message.tool_use_id,
        input: known.input,
        parentToolUseId: message.parent_tool_use_id,
        taskId: message.task_id,
        elapsedTimeSeconds: message.elapsed_time_seconds,
      });
      return;
    }

    known.taskId ??= message.task_id;

    if (isCommandTool(known.toolName)) {
      const command = extractCommand(known.input);
      this.summary = command ? `Command output: ${command}` : `Command output: ${known.toolName}`;
      this.emitCommandEvent('command_updated', {
        command,
        tool: known.toolName,
        tool_use_id: message.tool_use_id,
        parent_tool_use_id: message.parent_tool_use_id,
        elapsed_time_seconds: message.elapsed_time_seconds,
        task_id: message.task_id,
      });
      return;
    }

    this.summary = `Tool running: ${known.toolName}`;
    this.emitReasoning(`Tool ${known.toolName} running`, {
      tool: known.toolName,
      tool_use_id: message.tool_use_id,
      elapsed_time_seconds: message.elapsed_time_seconds,
      task_id: message.task_id ?? known.taskId,
    });
  }

  private handleToolSummary(message: Extract<SDKMessage, { type: 'tool_use_summary' }>): void {
    if (message.preceding_tool_use_ids.length === 0) {
      this.summary = summarizeText(message.summary, 'Tool finished');
      this.emitToolEvent('tool_finished', {
        tool: 'tool',
        summary: message.summary,
        preceding_tool_use_ids: message.preceding_tool_use_ids,
      });
      return;
    }

    for (const toolUseId of message.preceding_tool_use_ids) {
      if (this.completedToolUseIds.has(toolUseId)) {
        this.activeTools.delete(toolUseId);
        continue;
      }
      const toolState = this.activeTools.get(toolUseId);
      const tool = toolState?.toolName ?? 'tool';
      if (isCommandTool(tool)) {
        const command = extractCommand(toolState?.input);
        this.summary = command ? `Command finished: ${command}` : `Command finished: ${tool}`;
        this.emitCommandEvent('command_finished', {
          command,
          tool,
          tool_use_id: toolUseId,
          summary: message.summary,
          preceding_tool_use_ids: message.preceding_tool_use_ids,
          task_id: toolState?.taskId,
        });
      } else {
        this.summary = `Tool finished: ${tool}`;
        this.emitToolEvent('tool_finished', {
          tool,
          tool_use_id: toolUseId,
          summary: message.summary,
          preceding_tool_use_ids: message.preceding_tool_use_ids,
          task_id: toolState?.taskId,
        });
      }
      this.completedToolUseIds.add(toolUseId);
      this.activeTools.delete(toolUseId);
    }
  }

  private handleUserMessage(message: Extract<SDKMessage, { type: 'user' }>): void {
    const payload = extractToolResultPayload(message);
    if (payload.toolUseIds.length === 0) {
      return;
    }

    for (const toolUseId of payload.toolUseIds) {
      if (this.completedToolUseIds.has(toolUseId)) {
        continue;
      }

      const toolState = this.activeTools.get(toolUseId);
      const toolName = toolState?.toolName ?? 'tool';
      if (isCommandTool(toolName)) {
        const command = extractCommand(toolState?.input);
        this.summary = command ? `Command finished: ${command}` : `Command finished: ${toolName}`;
        this.emitCommandEvent('command_finished', {
          command,
          tool: toolName,
          tool_use_id: toolUseId,
          task_id: toolState?.taskId,
          output: payload.text,
          stdout: payload.stdout,
          stderr: payload.stderr,
          exit_code: payload.exitCode,
          interrupted: payload.interrupted,
          raw_output_path: payload.rawOutputPath,
          persisted_output_path: payload.persistedOutputPath,
          persisted_output_size: payload.persistedOutputSize,
          background_task_id: payload.backgroundTaskId,
          is_error: payload.isError,
          content: payload.content,
          raw_tool_use_result: payload.rawToolUseResult,
        });
      } else {
        this.summary = `Tool finished: ${toolName}`;
        this.emitToolEvent('tool_finished', {
          tool: toolName,
          tool_use_id: toolUseId,
          task_id: toolState?.taskId,
          output: payload.text,
          is_error: payload.isError,
          content: payload.content,
          raw_tool_use_result: payload.rawToolUseResult,
        });
      }

      this.completedToolUseIds.add(toolUseId);
      this.activeTools.delete(toolUseId);
    }
  }

  private handleResultMessage(message: Extract<SDKMessage, { type: 'result' }>): void {
    const usage = {
      usage: message.usage,
      model_usage: message.modelUsage,
      total_cost_usd: message.total_cost_usd,
      duration_ms: message.duration_ms,
      duration_api_ms: message.duration_api_ms,
      num_turns: message.num_turns,
      stop_reason: message.stop_reason,
    };

    if (message.subtype === 'success') {
      this.result = {
        finalResponse: message.result || this.latestAgentMessage || null,
        structuredOutput: message.structured_output,
        usage,
      };
      this.summary = 'Run completed';
      this.emit({
        seq: 0,
        ts: new Date().toISOString(),
        run_id: '',
        session_id: this.sessionId,
        backend: 'claude_code',
        type: 'run_completed',
        data: {
          final_response: this.result.finalResponse,
          structured_output: this.result.structuredOutput,
          usage,
        },
      });
      this.finished = true;
      return;
    }

    const messageText =
      message.errors.join('; ').trim() ||
      `Claude result error: ${message.subtype}`;
    this.result = {
      finalResponse: this.latestAgentMessage || null,
      usage,
    };
    this.summary = `Run failed: ${messageText}`;
    this.emit({
      seq: 0,
      ts: new Date().toISOString(),
      run_id: '',
      session_id: this.sessionId,
      backend: 'claude_code',
      type: 'run_failed',
      data: {
        message: messageText,
        usage,
      },
    });
    this.finished = true;
  }

  private emitAgentMessage(text: string, extra: Record<string, unknown> = {}): void {
    this.emit({
      seq: 0,
      ts: new Date().toISOString(),
      run_id: '',
      session_id: this.sessionId,
      backend: 'claude_code',
      type: 'agent_message',
      data: {
        text,
        ...extra,
      },
    });
  }

  private emitReasoning(text: string, extra: Record<string, unknown> = {}): void {
    this.emit({
      seq: 0,
      ts: new Date().toISOString(),
      run_id: '',
      session_id: this.sessionId,
      backend: 'claude_code',
      type: 'reasoning',
      data: {
        text,
        ...extra,
      },
    });
  }

  private emitToolEvent(
    type: Extract<NormalizedEvent['type'], 'tool_started' | 'tool_finished'>,
    data: Record<string, unknown>,
  ): void {
    this.emit({
      seq: 0,
      ts: new Date().toISOString(),
      run_id: '',
      session_id: this.sessionId,
      backend: 'claude_code',
      type,
      data,
    });
  }

  private emitCommandEvent(
    type: Extract<NormalizedEvent['type'], 'command_started' | 'command_updated' | 'command_finished'>,
    data: Record<string, unknown>,
  ): void {
    this.emit({
      seq: 0,
      ts: new Date().toISOString(),
      run_id: '',
      session_id: this.sessionId,
      backend: 'claude_code',
      type,
      data,
    });
  }

  private emitToolStart(params: {
    toolName: string;
    toolUseId?: string;
    input?: Record<string, unknown>;
    parentToolUseId?: string | null;
    taskId?: string;
    elapsedTimeSeconds?: number;
  }): void {
    if (isCommandTool(params.toolName)) {
      const command = extractCommand(params.input);
      this.summary = command ? `Running command: ${command}` : `Running command: ${params.toolName}`;
      this.emitCommandEvent('command_started', {
        command,
        tool: params.toolName,
        tool_use_id: params.toolUseId,
        parent_tool_use_id: params.parentToolUseId,
        task_id: params.taskId,
        elapsed_time_seconds: params.elapsedTimeSeconds,
        description: extractDescription(params.input),
      });
      return;
    }

    this.summary = `Calling tool: ${params.toolName}`;
    this.emitToolEvent('tool_started', {
      tool: params.toolName,
      tool_use_id: params.toolUseId,
      input: params.input,
      parent_tool_use_id: params.parentToolUseId,
      task_id: params.taskId,
      elapsed_time_seconds: params.elapsedTimeSeconds,
    });
  }

  private emit(event: NormalizedEvent): void {
    this.queue.push(event);
  }
}

export class ClaudeCodeAdapter extends BaseRunAdapter {
  readonly backend = 'claude_code' as const;

  constructor(private readonly createQuery: ClaudeQueryFactory = defaultClaudeQueryFactory) {
    super();
  }

  async spawn(params: AdapterSpawnParams): Promise<AdapterRunHandle> {
    const sdkQuery = this.createQuery({
      prompt: params.prompt,
      options: buildClaudeOptions(params),
    });
    return new ClaudeCodeRunHandle(sdkQuery, params);
  }

  async cancel(handle: AdapterRunHandle): Promise<void> {
    if (handle instanceof ClaudeCodeRunHandle) {
      handle.abort();
    }
  }
}

function defaultClaudeQueryFactory(params: {
  prompt: string;
  options: ClaudeOptions;
}): ClaudeQuery {
  return query(params);
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'string' ? property : undefined;
}

function getObjectProperty(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return property && typeof property === 'object'
    ? (property as Record<string, unknown>)
    : undefined;
}

function getArrayProperty(value: unknown, key: string): unknown[] | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return Array.isArray(property) ? property : undefined;
}

function getNumberProperty(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'number' ? property : undefined;
}

function getBooleanProperty(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'boolean' ? property : undefined;
}

function extractCommand(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  const command = input.command;
  return typeof command === 'string' ? command : undefined;
}

function extractDescription(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  const description = input.description;
  return typeof description === 'string' ? description : undefined;
}

function extractToolResultPayload(message: Extract<SDKMessage, { type: 'user' }>): ToolResultPayload {
  const toolUseIds = new Set<string>();
  if (message.parent_tool_use_id) {
    toolUseIds.add(message.parent_tool_use_id);
  }

  const payload: ToolResultPayload = {
    toolUseIds: [],
    rawToolUseResult: message.tool_use_result,
  };

  if (message.tool_use_result && typeof message.tool_use_result === 'object') {
    const raw = message.tool_use_result as Record<string, unknown>;
    const toolUseId = getStringProperty(raw, 'tool_use_id');
    if (toolUseId) {
      toolUseIds.add(toolUseId);
    }
    payload.stdout = getStringProperty(raw, 'stdout');
    payload.stderr = getStringProperty(raw, 'stderr');
    payload.exitCode = getNumberProperty(raw, 'exitCode') ?? getNumberProperty(raw, 'exit_code');
    payload.interrupted = getBooleanProperty(raw, 'interrupted');
    payload.rawOutputPath =
      getStringProperty(raw, 'rawOutputPath') ?? getStringProperty(raw, 'raw_output_path');
    payload.persistedOutputPath =
      getStringProperty(raw, 'persistedOutputPath') ?? getStringProperty(raw, 'persisted_output_path');
    payload.persistedOutputSize =
      getNumberProperty(raw, 'persistedOutputSize') ?? getNumberProperty(raw, 'persisted_output_size');
    payload.backgroundTaskId =
      getStringProperty(raw, 'backgroundTaskId') ?? getStringProperty(raw, 'background_task_id');
    payload.content = raw.content;
    payload.text = summarizeToolResultText(raw.content) ?? payload.stdout ?? payload.stderr;
  } else if (message.tool_use_result !== undefined) {
    payload.content = message.tool_use_result;
    payload.text = summarizeToolResultText(message.tool_use_result);
  }

  const blocks = getMessageContentBlocks(message.message);
  for (const block of blocks) {
    const blockType = getStringProperty(block, 'type');
    if (blockType !== 'tool_result') {
      continue;
    }

    const toolUseId = getStringProperty(block, 'tool_use_id');
    if (toolUseId) {
      toolUseIds.add(toolUseId);
    }

    payload.isError ??= getBooleanProperty(block, 'is_error');
    payload.content ??= (block as Record<string, unknown>).content;
    payload.text ??= summarizeToolResultText((block as Record<string, unknown>).content);
  }

  payload.toolUseIds = [...toolUseIds];
  return payload;
}

function getMessageContentBlocks(message: unknown): unknown[] {
  if (!message || typeof message !== 'object') {
    return [];
  }
  return getArrayProperty(message, 'content') ?? [];
}

function summarizeToolResultText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const chunks: string[] = [];
  for (const item of value) {
    const text = getStringProperty(item, 'text');
    if (text) {
      chunks.push(text);
      continue;
    }
    const nested = getArrayProperty(item, 'content');
    if (nested) {
      const nestedText = summarizeToolResultText(nested);
      if (nestedText) {
        chunks.push(nestedText);
      }
    }
  }

  if (chunks.length === 0) {
    return undefined;
  }
  return chunks.join('\n');
}

function isCommandTool(toolName: string): boolean {
  return toolName === 'Bash';
}

function parseStructuredOutput(text: string): unknown {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function summarizeText(text: string, fallback: string): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (!singleLine) {
    return fallback;
  }
  return singleLine.length > 120 ? `${singleLine.slice(0, 117)}...` : singleLine;
}
