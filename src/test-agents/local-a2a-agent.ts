import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';

import type { AgentCard, Message, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { UserBuilder, agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express';
import express from 'express';

import { CodexAdapter } from '../adapters/codex.js';
import { ClaudeCodeAdapter } from '../adapters/claude.js';
import { extractOrchestrationCwd } from '../core/a2a-metadata.js';
import { summarizeMessageParts } from '../core/messages.js';
import type {
  AdapterRunHandle,
  AgentMessage,
  BackendKind,
  RunAdapter,
  SessionRecord,
} from '../core/types.js';

interface LocalA2ATestAgentOptions {
  agentCard: AgentCard;
  backend: RunAdapter;
  defaultCwd?: string;
}

interface ActiveTaskState {
  handle: AdapterRunHandle;
  session: SessionRecord;
  latestAgentMessage: string;
}

export interface StartedLocalA2ATestAgent {
  app: express.Express;
  server: HttpServer;
  url: string;
  close(): Promise<void>;
}

class LocalBackendA2AExecutor implements AgentExecutor {
  private readonly activeTasks = new Map<string, ActiveTaskState>();
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly backend: RunAdapter,
    private readonly defaultCwd?: string,
  ) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const existingSession = this.sessions.get(requestContext.contextId) ?? null;
    const cwd = resolveExecutionCwd(requestContext.userMessage, existingSession?.cwd ?? null, this.defaultCwd);
    const session = existingSession ?? createSessionRecord(cwd, this.backend.backend, requestContext.contextId);
    this.sessions.set(requestContext.contextId, session);

    const inputMessage = fromA2AMessage(requestContext.userMessage);
    const prompt = summarizeMessageParts(inputMessage.parts) ?? '[structured input]';
    const handle = await this.backend.spawn({
      runId: requestContext.taskId,
      role: 'worker',
      prompt,
      inputMessage,
      cwd,
      sessionMode: existingSession?.backendSessionId ? 'resume' : 'new',
      session,
      metadata: {},
      backendConfig: {},
    });

    const taskState: ActiveTaskState = {
      handle,
      session,
      latestAgentMessage: '',
    };
    this.activeTasks.set(requestContext.taskId, taskState);

    const initialTask: Task = {
      kind: 'task',
      id: requestContext.taskId,
      contextId: requestContext.contextId,
      status: {
        state: 'submitted',
        timestamp: new Date().toISOString(),
      },
      history: [requestContext.userMessage],
    };
    eventBus.publish(initialTask);

    const consume = (async () => {
      for await (const event of handle.eventStream) {
        if ('kind' in event) {
          continue;
        }
        const backendSessionId =
          typeof event.data.backend_session_id === 'string'
            ? event.data.backend_session_id
            : typeof event.data.thread_id === 'string'
              ? event.data.thread_id
              : null;
        if (backendSessionId && session.backendSessionId !== backendSessionId) {
          session.backendSessionId = backendSessionId;
          this.sessions.set(requestContext.contextId, session);
        }
        switch (event.type) {
          case 'agent_message': {
            const text = typeof event.data.text === 'string' ? event.data.text : '';
            taskState.latestAgentMessage = text || taskState.latestAgentMessage;
            eventBus.publish({
              kind: 'status-update',
              taskId: requestContext.taskId,
              contextId: requestContext.contextId,
              status: {
                state: 'working',
                timestamp: new Date().toISOString(),
                message: toA2AMessage(text, requestContext.taskId, requestContext.contextId),
              },
              final: false,
            } satisfies TaskStatusUpdateEvent);
            break;
          }
          case 'input_required':
            eventBus.publish({
              kind: 'status-update',
              taskId: requestContext.taskId,
              contextId: requestContext.contextId,
              status: {
                state: 'input-required',
                timestamp: new Date().toISOString(),
                message: toA2AMessage(
                  typeof event.data.text === 'string' ? event.data.text : 'Additional input required',
                  requestContext.taskId,
                  requestContext.contextId,
                ),
              },
              final: false,
            } satisfies TaskStatusUpdateEvent);
            break;
          case 'auth_required':
            eventBus.publish({
              kind: 'status-update',
              taskId: requestContext.taskId,
              contextId: requestContext.contextId,
              status: {
                state: 'auth-required',
                timestamp: new Date().toISOString(),
                message: toA2AMessage(
                  typeof event.data.text === 'string' ? event.data.text : 'Authentication required',
                  requestContext.taskId,
                  requestContext.contextId,
                ),
              },
              final: false,
            } satisfies TaskStatusUpdateEvent);
            break;
          case 'rejected':
            eventBus.publish({
              kind: 'status-update',
              taskId: requestContext.taskId,
              contextId: requestContext.contextId,
              status: {
                state: 'rejected',
                timestamp: new Date().toISOString(),
                message: toA2AMessage(
                  typeof event.data.message === 'string' ? event.data.message : 'Rejected',
                  requestContext.taskId,
                  requestContext.contextId,
                ),
              },
              final: true,
            } satisfies TaskStatusUpdateEvent);
            break;
          case 'run_failed':
            eventBus.publish({
              kind: 'status-update',
              taskId: requestContext.taskId,
              contextId: requestContext.contextId,
              status: {
                state: 'failed',
                timestamp: new Date().toISOString(),
                message: toA2AMessage(
                  typeof event.data.message === 'string' ? event.data.message : 'Run failed',
                  requestContext.taskId,
                  requestContext.contextId,
                ),
              },
              final: true,
            } satisfies TaskStatusUpdateEvent);
            break;
          case 'run_completed': {
            const artifactParts = [];
            if (taskState.latestAgentMessage) {
              artifactParts.push({ kind: 'text', text: taskState.latestAgentMessage } as const);
            }
            if (event.data.structured_output && typeof event.data.structured_output === 'object') {
              artifactParts.push({ kind: 'data', data: event.data.structured_output as Record<string, unknown> } as const);
            }
            if (artifactParts.length > 0) {
              eventBus.publish({
                kind: 'artifact-update',
                taskId: requestContext.taskId,
                contextId: requestContext.contextId,
                artifact: {
                  artifactId: 'final-response',
                  name: 'final-response',
                  parts: artifactParts,
                },
              } satisfies TaskArtifactUpdateEvent);
            }
            eventBus.publish({
              kind: 'status-update',
              taskId: requestContext.taskId,
              contextId: requestContext.contextId,
              status: {
                state: 'completed',
                timestamp: new Date().toISOString(),
              },
              final: true,
            } satisfies TaskStatusUpdateEvent);
            break;
          }
        }
      }
    })();

    await Promise.allSettled([consume, handle.run()]);
    eventBus.finished();
    this.activeTasks.delete(requestContext.taskId);
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const active = this.activeTasks.get(taskId);
    if (!active) {
      return;
    }
    await this.backend.cancel(active.handle);
    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId: active.session.sessionId,
      status: {
        state: 'canceled',
        timestamp: new Date().toISOString(),
      },
      final: true,
    } satisfies TaskStatusUpdateEvent);
    eventBus.finished();
    this.activeTasks.delete(taskId);
  }
}

export async function startLocalA2ATestAgent(
  options: LocalA2ATestAgentOptions,
): Promise<StartedLocalA2ATestAgent> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const requestHandler = new DefaultRequestHandler(
    options.agentCard,
    new InMemoryTaskStore(),
    new LocalBackendA2AExecutor(options.backend, options.defaultCwd),
  );

  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
  app.use('/a2a/jsonrpc', jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve local A2A agent address');
  }

  return {
    app,
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

export async function startCodexA2ATestAgent(defaultCwd?: string): Promise<StartedLocalA2ATestAgent> {
  const agentCard: AgentCard = {
    name: 'Codex Test Agent',
    description: 'A local Codex-backed A2A test agent.',
    protocolVersion: '0.3.0',
    version: '0.1.0',
    url: '',
    preferredTransport: 'JSONRPC',
    skills: [
      {
        id: 'codex-code',
        name: 'Codex Code',
        description: 'Runs coding tasks using the local Codex SDK.',
        tags: ['code', 'codex'],
      },
    ],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
  };
  const started = await startLocalA2ATestAgent({
    agentCard,
    backend: new CodexAdapter(),
    defaultCwd,
  });
  agentCard.url = `${started.url}/a2a/jsonrpc`;
  return started;
}

export async function startClaudeA2ATestAgent(defaultCwd?: string): Promise<StartedLocalA2ATestAgent> {
  const agentCard: AgentCard = {
    name: 'Claude Code Test Agent',
    description: 'A local Claude Code-backed A2A test agent.',
    protocolVersion: '0.3.0',
    version: '0.1.0',
    url: '',
    preferredTransport: 'JSONRPC',
    skills: [
      {
        id: 'claude-code',
        name: 'Claude Code',
        description: 'Runs coding tasks using the local Claude Agent SDK.',
        tags: ['code', 'claude'],
      },
    ],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
  };
  const started = await startLocalA2ATestAgent({
    agentCard,
    backend: new ClaudeCodeAdapter(),
    defaultCwd,
  });
  agentCard.url = `${started.url}/a2a/jsonrpc`;
  return started;
}

function createSessionRecord(cwd: string, backend: BackendKind, sessionId: string): SessionRecord {
  const now = new Date().toISOString();
  return {
    sessionId,
    backend,
    cwd,
    backendSessionId: null,
    remoteRef: null,
    createdAt: now,
    updatedAt: now,
    metadata: {},
  };
}

function resolveExecutionCwd(message: Message, existingCwd: string | null, defaultCwd?: string): string {
  const requestedCwd = extractOrchestrationCwd(message.metadata) ?? defaultCwd ?? null;
  if (!requestedCwd) {
    throw new Error('A2A request metadata.nanobot_orchestrator.cwd is required for new contexts');
  }
  if (!path.isAbsolute(requestedCwd)) {
    throw new Error(`A2A request cwd must be absolute: ${requestedCwd}`);
  }

  const normalizedCwd = path.resolve(requestedCwd);
  if (existingCwd && existingCwd !== normalizedCwd) {
    throw new Error(
      `A2A context ${message.contextId ?? '[unknown]'} is already bound to cwd ${existingCwd}, received ${normalizedCwd}`,
    );
  }

  return existingCwd ?? normalizedCwd;
}

function fromA2AMessage(message: Message): AgentMessage {
  return {
    role: message.role,
    parts: message.parts.map((part) => {
      switch (part.kind) {
        case 'text':
          return { type: 'text', text: part.text };
        case 'data':
          return { type: 'data', data: part.data };
        case 'file':
          return {
            type: 'file',
            uri: 'uri' in part.file ? part.file.uri : undefined,
            bytes_base64: 'bytes' in part.file ? part.file.bytes : undefined,
            mime_type: part.file.mimeType,
            name: part.file.name,
          };
      }
    }),
  };
}

function toA2AMessage(text: string, taskId: string, contextId: string): Message {
  return {
    kind: 'message',
    messageId: `${taskId}-${Date.now()}`,
    role: 'agent',
    taskId,
    contextId,
    parts: [{ kind: 'text', text }],
  };
}
