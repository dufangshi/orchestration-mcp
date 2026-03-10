import { Codex, type Thread, type ThreadEvent, type ThreadItem } from '@openai/codex-sdk';

import { AsyncEventQueue } from './async-event-queue.js';
import { BaseRunAdapter } from './base.js';
import type {
  AdapterRunHandle,
  AdapterSpawnParams,
  NormalizedEvent,
  RunResult,
} from '../core/types.js';

class CodexRunHandle implements AdapterRunHandle {
  readonly sessionId: string;
  readonly eventStream: AsyncIterable<NormalizedEvent>;

  private readonly queue = new AsyncEventQueue<NormalizedEvent>();
  private readonly abortController = new AbortController();
  private readonly thread: Thread;
  private readonly params: AdapterSpawnParams;
  private latestAgentMessage = '';
  private usage: unknown = null;
  private result: RunResult | null = null;
  private summary = 'Run queued';
  private started = false;
  private finished = false;
  private runPromise: Promise<void> | null = null;

  constructor(thread: Thread, params: AdapterSpawnParams) {
    this.thread = thread;
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
    this.abortController.abort();
  }

  private async doRun(): Promise<void> {
    this.emit({
      seq: 0,
      ts: new Date().toISOString(),
      run_id: '',
      session_id: this.sessionId,
      backend: 'codex',
      type: 'run_started',
      data: {
        thread_id: this.params.session.backendSessionId,
      },
    });
    this.emit({
      seq: 0,
      ts: new Date().toISOString(),
      run_id: '',
      session_id: this.sessionId,
      backend: 'codex',
      type: 'status_changed',
      data: {
        status: 'running',
      },
    });

    try {
      const streamed = await this.thread.runStreamed(this.params.prompt, {
        outputSchema: this.params.outputSchema,
        signal: this.abortController.signal,
      });

      for await (const event of streamed.events) {
        this.handleThreadEvent(event);
      }

      if (!this.finished && !this.abortController.signal.aborted) {
        this.result = {
          finalResponse: this.latestAgentMessage || null,
          structuredOutput: parseStructuredOutput(this.latestAgentMessage),
          usage: this.usage,
        };
        this.summary = 'Run completed';
        this.emit({
          seq: 0,
          ts: new Date().toISOString(),
          run_id: '',
          session_id: this.sessionId,
          backend: 'codex',
          type: 'run_completed',
          data: {
            final_response: this.result.finalResponse,
            structured_output: this.result.structuredOutput,
            usage: this.usage,
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
          backend: 'codex',
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

  private handleThreadEvent(event: ThreadEvent): void {
    switch (event.type) {
      case 'thread.started':
        this.summary = 'Codex thread started';
        this.emit({
          seq: 0,
          ts: new Date().toISOString(),
          run_id: '',
          session_id: this.sessionId,
          backend: 'codex',
          type: 'status_changed',
          data: {
            status: 'running',
            thread_id: event.thread_id,
          },
        });
        return;
      case 'turn.started':
        if (!this.started) {
          this.started = true;
          this.summary = 'Turn started';
        }
        return;
      case 'turn.completed':
        this.usage = event.usage;
        return;
      case 'turn.failed':
        this.summary = `Run failed: ${event.error.message}`;
        this.emit({
          seq: 0,
          ts: new Date().toISOString(),
          run_id: '',
          session_id: this.sessionId,
          backend: 'codex',
          type: 'run_failed',
          data: {
            message: event.error.message,
          },
        });
        this.finished = true;
        return;
      case 'error':
        this.summary = `Run failed: ${event.message}`;
        this.emit({
          seq: 0,
          ts: new Date().toISOString(),
          run_id: '',
          session_id: this.sessionId,
          backend: 'codex',
          type: 'run_failed',
          data: {
            message: event.message,
          },
        });
        this.finished = true;
        return;
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        this.handleThreadItem(event.type, event.item);
        return;
    }
  }

  private handleThreadItem(eventType: ThreadEvent['type'], item: ThreadItem): void {
    switch (item.type) {
      case 'agent_message':
        this.latestAgentMessage = item.text;
        this.summary = summarizeAgentMessage(item.text);
        this.emitEvent('agent_message', { text: item.text });
        return;
      case 'reasoning':
        this.summary = 'Codex updated reasoning';
        this.emitEvent('reasoning', { text: item.text });
        return;
      case 'command_execution':
        if (eventType === 'item.started') {
          this.summary = `Running command: ${item.command}`;
          this.emitEvent('command_started', {
            command: item.command,
            output: item.aggregated_output,
            status: item.status,
          });
          return;
        }
        if (eventType === 'item.completed') {
          this.summary = `Command finished: ${item.command}`;
          this.emitEvent('command_finished', {
            command: item.command,
            output: item.aggregated_output,
            status: item.status,
            exit_code: item.exit_code,
          });
          return;
        }
        this.summary = `Command output: ${item.command}`;
        this.emitEvent('command_updated', {
          command: item.command,
          output: item.aggregated_output,
          status: item.status,
          exit_code: item.exit_code,
        });
        return;
      case 'file_change':
        this.summary = `Updated ${item.changes.length} file(s)`;
        this.emitEvent('file_changed', {
          status: item.status,
          changes: item.changes,
        });
        return;
      case 'mcp_tool_call':
        if (item.status === 'in_progress') {
          this.summary = `Calling tool: ${item.tool}`;
          this.emitEvent('tool_started', {
            server: item.server,
            tool: item.tool,
            arguments: item.arguments,
          });
          return;
        }
        this.summary = `Tool finished: ${item.tool}`;
        this.emitEvent('tool_finished', {
          server: item.server,
          tool: item.tool,
          arguments: item.arguments,
          result: item.result,
          error: item.error,
          status: item.status,
        });
        return;
      case 'web_search':
        this.summary = `Searching the web: ${item.query}`;
        this.emitEvent(eventType === 'item.completed' ? 'tool_finished' : 'tool_started', {
          server: 'codex',
          tool: 'web_search',
          arguments: {
            query: item.query,
          },
        });
        return;
      case 'todo_list':
        this.summary = `Updated checklist with ${item.items.length} item(s)`;
        this.emitEvent('todo_updated', {
          items: item.items,
        });
        return;
      case 'error':
        this.summary = `Item error: ${item.message}`;
        this.emitEvent('reasoning', {
          text: item.message,
        });
        return;
    }
  }

  private emitEvent(type: NormalizedEvent['type'], data: Record<string, unknown>): void {
    this.emit({
      seq: 0,
      ts: new Date().toISOString(),
      run_id: '',
      session_id: this.sessionId,
      backend: 'codex',
      type,
      data,
    });
  }

  private emit(event: NormalizedEvent): void {
    this.queue.push(event);
  }
}

export class CodexAdapter extends BaseRunAdapter {
  readonly backend = 'codex' as const;

  async spawn(params: AdapterSpawnParams): Promise<AdapterRunHandle> {
    const codex = new Codex();
    const threadOptions = {
      workingDirectory: params.cwd,
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'never' as const,
      networkAccessEnabled: true,
    };

    const thread =
      params.sessionMode === 'resume' && params.session.backendSessionId
        ? codex.resumeThread(params.session.backendSessionId, threadOptions)
        : codex.startThread(threadOptions);

    return new CodexRunHandle(thread, params);
  }

  async cancel(handle: AdapterRunHandle): Promise<void> {
    if (handle instanceof CodexRunHandle) {
      handle.abort();
    }
  }
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

function summarizeAgentMessage(text: string): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (!singleLine) {
    return 'Codex produced a response';
  }
  return singleLine.length > 120 ? `${singleLine.slice(0, 117)}...` : singleLine;
}
