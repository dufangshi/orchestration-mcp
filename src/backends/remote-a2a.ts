import { randomUUID } from 'node:crypto';

import type {
  AgentCard,
  Artifact,
  DataPart,
  FilePart,
  Message as A2AMessage,
  MessageSendParams,
  Part,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
  TextPart,
} from '@a2a-js/sdk';
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type Client,
} from '@a2a-js/sdk/client';

import type {
  AdapterRunHandle,
  AdapterSpawnParams,
  AgentMessage,
  MessagePart,
  NormalizedEvent,
  RemoteRef,
  RunResult,
  TaskArtifact,
} from '../core/types.js';
import { AsyncEventQueue } from '../adapters/async-event-queue.js';
import { BaseRunAdapter } from '../adapters/base.js';
import { attachOrchestrationMetadata } from '../core/a2a-metadata.js';
import { summarizeMessageParts } from '../core/messages.js';

interface RemoteA2ABackendConfig {
  agentUrl: string;
  agentCardPath?: string;
  headers: Record<string, string>;
  historyLength?: number;
  blocking?: boolean;
  acceptedOutputModes?: string[];
}

type A2AStreamEvent = Task | A2AMessage | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

class RemoteA2ARunHandle implements AdapterRunHandle {
  readonly sessionId: string;
  readonly eventStream: AsyncIterable<NormalizedEvent>;

  private readonly queue = new AsyncEventQueue<NormalizedEvent>();
  private readonly abortController = new AbortController();
  private readonly config: RemoteA2ABackendConfig;
  private readonly params: AdapterSpawnParams;
  private readonly clientPromise: Promise<Client>;
  private readonly cardPromise: Promise<AgentCard>;
  private readonly artifacts: TaskArtifact[] = [];
  private latestAgentMessage = '';
  private latestStructuredOutput: unknown;
  private usage: unknown;
  private summary = 'Run queued';
  private result: RunResult | null = null;
  private runPromise: Promise<void> | null = null;
  private finished = false;
  private resolvedAgentUrl: string;
  private currentTaskId: string | null = null;
  private currentContextId: string | null = null;
  private waitingForInput = false;
  private continueResolve: ((input: AgentMessage) => void) | null = null;
  private continueReject: ((error: Error) => void) | null = null;

  constructor(params: AdapterSpawnParams, config: RemoteA2ABackendConfig) {
    this.params = params;
    this.config = config;
    this.sessionId = params.session.sessionId;
    this.resolvedAgentUrl = config.agentUrl;
    this.eventStream = this.queue;
    const fetchImpl = buildConfiguredFetch(config);
    const factory = new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [
          new JsonRpcTransportFactory({ fetchImpl }),
          new RestTransportFactory({ fetchImpl }),
        ],
      }),
    );
    this.cardPromise = new DefaultAgentCardResolver({ fetchImpl }).resolve(
      config.agentUrl,
      config.agentCardPath,
    );
    this.clientPromise = factory.createFromUrl(config.agentUrl, config.agentCardPath);
  }

  async run(): Promise<void> {
    if (this.runPromise) {
      return this.runPromise;
    }
    this.runPromise = this.doRun();
    return this.runPromise;
  }

  async continue(input: AgentMessage): Promise<void> {
    if (!this.waitingForInput || !this.continueResolve) {
      throw new Error('remote_a2a run is not awaiting additional input');
    }
    this.waitingForInput = false;
    this.continueResolve(input);
    this.continueResolve = null;
    this.continueReject = null;
  }

  getSummary(): string {
    return this.summary;
  }

  getResult(): RunResult | null {
    return this.result;
  }

  async abort(): Promise<void> {
    this.abortController.abort();
    if (this.continueReject) {
      this.continueReject(new Error('run cancelled'));
      this.continueReject = null;
      this.continueResolve = null;
    }
    if (this.currentTaskId) {
      try {
        const client = await this.clientPromise;
        await client.cancelTask({ id: this.currentTaskId }, { signal: AbortSignal.timeout(5000) });
      } catch {
        // Best-effort remote cancellation. The orchestration layer also records a cancelled state.
      }
    }
  }

  private async doRun(): Promise<void> {
    try {
      const card = await this.cardPromise;
      this.resolvedAgentUrl = card.url || this.config.agentUrl;
      this.emit({
        seq: 0,
        ts: new Date().toISOString(),
        run_id: '',
        session_id: this.sessionId,
        backend: 'remote_a2a',
        type: 'run_started',
        data: {
          remote_ref: {
            provider: 'remote_a2a',
            agent_url: this.resolvedAgentUrl,
            agent_name: card.name,
            context_id: this.params.session.remoteRef?.context_id ?? null,
            task_id: this.params.session.remoteRef?.task_id ?? null,
          },
          agent_name: card.name,
          agent_url: this.resolvedAgentUrl,
        },
      });
      this.emit({
        seq: 0,
        ts: new Date().toISOString(),
        run_id: '',
        session_id: this.sessionId,
        backend: 'remote_a2a',
        type: 'status_changed',
        data: {
          status: 'running',
          agent_name: card.name,
          agent_url: this.resolvedAgentUrl,
        },
      });

      let nextInput: AgentMessage | null = this.params.inputMessage;
      while (nextInput && !this.abortController.signal.aborted) {
        await this.processInput(nextInput);
        if (!this.waitingForInput) {
          break;
        }
        nextInput = await this.waitForContinuation();
        this.emit({
          seq: 0,
          ts: new Date().toISOString(),
          run_id: '',
          session_id: this.sessionId,
          backend: 'remote_a2a',
          type: 'status_changed',
          data: {
            status: 'running',
            task_id: this.currentTaskId,
            context_id: this.currentContextId,
            agent_url: this.resolvedAgentUrl,
          },
        });
      }

      if (!this.finished && !this.abortController.signal.aborted) {
        this.result = {
          finalResponse: this.latestAgentMessage || null,
          structuredOutput: this.latestStructuredOutput,
          usage: this.usage,
          artifacts: this.artifacts.slice(),
        };
        this.summary = 'Run completed';
        this.emit({
          seq: 0,
          ts: new Date().toISOString(),
          run_id: '',
          session_id: this.sessionId,
          backend: 'remote_a2a',
          type: 'run_completed',
          data: {
            final_response: this.result.finalResponse,
            structured_output: this.result.structuredOutput,
            artifacts: this.result.artifacts,
            usage: this.usage,
            task_id: this.currentTaskId,
            context_id: this.currentContextId,
            agent_url: this.resolvedAgentUrl,
          },
        });
        this.finished = true;
      }
    } catch (error) {
      if (!this.abortController.signal.aborted) {
        this.summary = `Run failed: ${String(error)}`;
        this.emit({
          seq: 0,
          ts: new Date().toISOString(),
          run_id: '',
          session_id: this.sessionId,
          backend: 'remote_a2a',
          type: 'run_failed',
          data: {
            message: String(error),
            task_id: this.currentTaskId,
            context_id: this.currentContextId,
          agent_url: this.resolvedAgentUrl,
        },
      });
        this.finished = true;
      }
    } finally {
      this.queue.end();
    }
  }

  private async processInput(input: AgentMessage): Promise<void> {
    const client = await this.clientPromise;
    const params = buildSendParams(
      input,
      this.currentTaskId,
      this.currentContextId,
      this.params,
      this.config,
    );
    const stream = client.sendMessageStream(params, { signal: this.abortController.signal });
    for await (const event of stream) {
      this.handleA2AEvent(event);
    }
  }

  private async waitForContinuation(): Promise<AgentMessage> {
    this.waitingForInput = true;
    return new Promise<AgentMessage>((resolve, reject) => {
      this.continueResolve = resolve;
      this.continueReject = reject;
    });
  }

  private handleA2AEvent(event: A2AStreamEvent): void {
    switch (event.kind) {
      case 'message':
        this.handleMessage(event);
        return;
      case 'task':
        this.handleTask(event);
        return;
      case 'status-update':
        this.handleStatusUpdate(event);
        return;
      case 'artifact-update':
        this.handleArtifactUpdate(event);
        return;
    }
  }

  private handleMessage(message: A2AMessage): void {
    this.latestAgentMessage = summarizeA2AMessage(message) ?? this.latestAgentMessage;
    this.summary = this.latestAgentMessage || 'Received A2A message';
    const converted = fromA2AMessage(message);
    this.emit({
      seq: 0,
      ts: new Date().toISOString(),
      run_id: '',
      session_id: this.sessionId,
      backend: 'remote_a2a',
      type: 'message_added',
      data: {
        message,
        role: message.role,
        text: this.latestAgentMessage,
      },
    });
    if (converted.role === 'agent' && this.latestAgentMessage) {
      this.emit({
        seq: 0,
        ts: new Date().toISOString(),
        run_id: '',
        session_id: this.sessionId,
        backend: 'remote_a2a',
        type: 'agent_message',
        data: {
          text: this.latestAgentMessage,
          task_id: this.currentTaskId,
          context_id: this.currentContextId,
        },
      });
    }
  }

  private handleTask(task: Task): void {
    this.currentTaskId = task.id;
    this.currentContextId = task.contextId;
    if (task.artifacts) {
      for (const artifact of task.artifacts) {
        this.recordArtifact(artifact, true);
      }
    }
    this.emit({
      seq: 0,
      ts: new Date().toISOString(),
      run_id: '',
      session_id: this.sessionId,
      backend: 'remote_a2a',
      type: 'status_changed',
      data: {
        status: mapTaskState(task.status.state),
        task_id: task.id,
        context_id: task.contextId,
        remote_ref: makeRemoteRef(this.resolvedAgentUrl, task.id, task.contextId),
        state: task.status.state,
      },
    });
    if (task.status.message) {
      this.handleMessage(task.status.message);
    }
    if (task.status.state === 'input-required') {
      this.emitInputRequired(task.status.message, task.id, task.contextId);
    }
    if (task.status.state === 'auth-required') {
      this.emitAuthRequired(task.status.message, task.id, task.contextId);
    }
    if (task.status.state === 'rejected') {
      this.emitRejected(task.status.message, task.id, task.contextId);
    }
  }

  private handleStatusUpdate(event: TaskStatusUpdateEvent): void {
    this.currentTaskId = event.taskId;
    this.currentContextId = event.contextId;
    const status = mapTaskState(event.status.state);
    this.emit({
      seq: 0,
      ts: new Date().toISOString(),
      run_id: '',
      session_id: this.sessionId,
      backend: 'remote_a2a',
      type: 'status_changed',
      data: {
        status,
        state: event.status.state,
        task_id: event.taskId,
        context_id: event.contextId,
        remote_ref: makeRemoteRef(this.resolvedAgentUrl, event.taskId, event.contextId),
      },
    });
    if (event.status.message) {
      this.handleMessage(event.status.message);
    }
    if (event.status.state === 'input-required') {
      this.emitInputRequired(event.status.message, event.taskId, event.contextId);
      this.waitingForInput = true;
    }
    if (event.status.state === 'auth-required') {
      this.emitAuthRequired(event.status.message, event.taskId, event.contextId);
      this.waitingForInput = true;
    }
    if (event.status.state === 'rejected') {
      this.emitRejected(event.status.message, event.taskId, event.contextId);
      this.finished = true;
    }
    if (event.status.state === 'completed') {
      this.finished = false;
    }
    if (event.status.state === 'failed') {
      this.finished = true;
    }
  }

  private handleArtifactUpdate(event: TaskArtifactUpdateEvent): void {
    this.currentTaskId = event.taskId;
    this.currentContextId = event.contextId;
    this.recordArtifact(event.artifact, false);
  }

  private recordArtifact(artifact: Artifact, fromTaskSnapshot: boolean): void {
    if (!this.artifacts.some((known) => known.artifactId === artifact.artifactId)) {
      this.artifacts.push(fromA2AArtifact(artifact));
    }
    const text = summarizeA2ATextParts(artifact.parts) ?? summarizeA2AParts(artifact.parts);
    if (text) {
      this.latestAgentMessage = text;
    }
    const dataPart = artifact.parts.find((part): part is DataPart => part.kind === 'data');
    if (dataPart) {
      this.latestStructuredOutput = dataPart.data;
    }
    this.emit({
      seq: 0,
      ts: new Date().toISOString(),
      run_id: '',
      session_id: this.sessionId,
      backend: 'remote_a2a',
      type: 'artifact_added',
      data: {
        artifact_id: artifact.artifactId,
        name: artifact.name,
        description: artifact.description,
        parts: artifact.parts,
        text,
        task_id: this.currentTaskId,
        context_id: this.currentContextId,
        from_task_snapshot: fromTaskSnapshot,
      },
    });
  }

  private emitInputRequired(message: A2AMessage | undefined, taskId: string, contextId: string): void {
    const text = message ? summarizeA2AMessage(message) : null;
    this.summary = text ?? 'Waiting for additional input';
    this.emit({
      seq: 0,
      ts: new Date().toISOString(),
      run_id: '',
      session_id: this.sessionId,
      backend: 'remote_a2a',
      type: 'input_required',
      data: {
        text,
        message,
        task_id: taskId,
        context_id: contextId,
      },
    });
  }

  private emitAuthRequired(message: A2AMessage | undefined, taskId: string, contextId: string): void {
    const text = message ? summarizeA2AMessage(message) : null;
    this.summary = text ?? 'Authentication required';
    this.emit({
      seq: 0,
      ts: new Date().toISOString(),
      run_id: '',
      session_id: this.sessionId,
      backend: 'remote_a2a',
      type: 'auth_required',
      data: {
        text,
        message,
        task_id: taskId,
        context_id: contextId,
      },
    });
  }

  private emitRejected(message: A2AMessage | undefined, taskId: string, contextId: string): void {
    const text = message ? summarizeA2AMessage(message) : null;
    this.summary = text ?? 'Run rejected';
    this.emit({
      seq: 0,
      ts: new Date().toISOString(),
      run_id: '',
      session_id: this.sessionId,
      backend: 'remote_a2a',
      type: 'rejected',
      data: {
        message: text,
        response: message,
        task_id: taskId,
        context_id: contextId,
      },
    });
  }

  private emit(event: NormalizedEvent): void {
    this.queue.push(event);
  }
}

export class RemoteA2AAdapter extends BaseRunAdapter {
  readonly backend = 'remote_a2a' as const;

  async spawn(params: AdapterSpawnParams): Promise<AdapterRunHandle> {
    return new RemoteA2ARunHandle(params, parseConfig(params.backendConfig));
  }

  async cancel(handle: AdapterRunHandle): Promise<void> {
    if (handle instanceof RemoteA2ARunHandle) {
      await handle.abort();
    }
  }

  async continue(handle: AdapterRunHandle, input: AgentMessage): Promise<void> {
    if (!(handle instanceof RemoteA2ARunHandle)) {
      throw new Error('Unsupported remote_a2a handle');
    }
    await handle.continue(input);
  }
}

function parseConfig(config: Record<string, unknown>): RemoteA2ABackendConfig {
  if (typeof config.agent_url !== 'string' || !config.agent_url) {
    throw new Error('remote_a2a backend_config.agent_url is required');
  }
  const headers = toStringMap(config.headers);
  if (typeof config.auth_token === 'string' && config.auth_token) {
    headers.Authorization = `Bearer ${config.auth_token}`;
  }
  return {
    agentUrl: config.agent_url,
    agentCardPath: typeof config.agent_card_path === 'string' ? config.agent_card_path : undefined,
    headers,
    historyLength: typeof config.history_length === 'number' ? config.history_length : undefined,
    blocking: typeof config.blocking === 'boolean' ? config.blocking : true,
    acceptedOutputModes: Array.isArray(config.accepted_output_modes)
      ? config.accepted_output_modes.filter((value): value is string => typeof value === 'string')
      : undefined,
  };
}

function buildConfiguredFetch(config: RemoteA2ABackendConfig): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [key, value] of Object.entries(config.headers)) {
      headers.set(key, value);
    }
    return fetch(input, {
      ...init,
      headers,
    });
  };
}

function buildSendParams(
  input: AgentMessage,
  taskId: string | null,
  contextId: string | null,
  params: AdapterSpawnParams,
  config: RemoteA2ABackendConfig,
): MessageSendParams {
  const message: A2AMessage = {
    kind: 'message',
    messageId: randomUUID(),
    role: input.role === 'system' ? 'user' : input.role,
    parts: input.parts.map(toA2APart),
    metadata: attachOrchestrationMetadata(input.metadata, {
      cwd: params.cwd,
      runId: params.runId,
      sessionId: params.session.sessionId,
    }),
    taskId: taskId ?? undefined,
    contextId: contextId ?? undefined,
  };
  return {
    message,
    configuration: {
      blocking: config.blocking,
      historyLength: config.historyLength,
      acceptedOutputModes: config.acceptedOutputModes,
    },
  };
}

function toA2APart(part: MessagePart): Part {
  switch (part.type) {
    case 'text':
      return { kind: 'text', text: part.text };
    case 'data':
      return { kind: 'data', data: part.data };
    case 'file':
      if (part.uri) {
        return {
          kind: 'file',
          file: {
            uri: part.uri,
            mimeType: part.mime_type,
            name: part.name,
          },
        };
      }
      return {
        kind: 'file',
        file: {
          bytes: part.bytes_base64 ?? '',
          mimeType: part.mime_type,
          name: part.name,
        },
      };
  }
}

function fromA2AMessage(message: A2AMessage): AgentMessage {
  return {
    role: message.role,
    parts: message.parts.map(fromA2APart),
    metadata: message.metadata,
  };
}

function fromA2AArtifact(artifact: Artifact): TaskArtifact {
  return {
    artifactId: artifact.artifactId,
    name: artifact.name,
    description: artifact.description,
    parts: artifact.parts.map(fromA2APart),
    metadata: artifact.metadata,
  };
}

function fromA2APart(part: Part): MessagePart {
  switch (part.kind) {
    case 'text':
      return {
        type: 'text',
        text: (part as TextPart).text,
      };
    case 'data':
      return {
        type: 'data',
        data: (part as DataPart).data,
      };
    case 'file': {
      const file = (part as FilePart).file;
      return {
        type: 'file',
        uri: 'uri' in file ? file.uri : undefined,
        bytes_base64: 'bytes' in file ? file.bytes : undefined,
        mime_type: file.mimeType,
        name: file.name,
      };
    }
  }
}

function summarizeA2AMessage(message: A2AMessage): string | null {
  return summarizeA2AParts(message.parts);
}

function summarizeA2AParts(parts: Part[]): string | null {
  const converted = parts.map(fromA2APart);
  return summarizeMessageParts(converted);
}

function summarizeA2ATextParts(parts: Part[]): string | null {
  const texts = parts
    .filter((part): part is TextPart => part.kind === 'text')
    .map((part) => part.text.trim())
    .filter(Boolean);
  return texts.length > 0 ? texts.join('\n\n') : null;
}

function mapTaskState(state: Task['status']['state']): NormalizedEvent['data']['status'] {
  switch (state) {
    case 'submitted':
      return 'queued';
    case 'working':
      return 'running';
    case 'input-required':
      return 'input_required';
    case 'auth-required':
      return 'auth_required';
    case 'completed':
      return 'completed';
    case 'canceled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    case 'rejected':
      return 'rejected';
    default:
      return 'running';
  }
}

function makeRemoteRef(
  agentUrl: string,
  taskId: string | null,
  contextId: string | null,
): RemoteRef {
  return {
    provider: 'remote_a2a',
    task_id: taskId,
    context_id: contextId,
    agent_url: agentUrl,
  };
}

function toStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => typeof entry === 'string')
    .map(([key, entry]) => [key, entry as string]);
  return Object.fromEntries(entries);
}
