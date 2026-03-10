import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { EventBuffer } from './event-buffer.js';
import { SessionManager } from './session-manager.js';
import { Storage } from './storage.js';
import type {
  AdapterRunHandle,
  BackendKind,
  CancelRunInput,
  CancelRunResult,
  GetRunInput,
  GetRunResult,
  ListRunsInput,
  ListRunsResult,
  NormalizedEvent,
  PollEventsInput,
  PollEventsResult,
  RunAdapter,
  RunRecord,
  RunStatus,
  SessionRecord,
  SpawnRunInput,
  SpawnRunResult,
} from './types.js';

interface ManagedRun {
  record: RunRecord;
  session: SessionRecord;
  adapter: RunAdapter;
  handle: AdapterRunHandle;
  buffer: EventBuffer;
  task: Promise<void>;
}

export class RunManager {
  private readonly storage = new Storage();
  private readonly sessions = new SessionManager(this.storage);
  private readonly adapters = new Map<BackendKind, RunAdapter>();
  private readonly runs = new Map<string, ManagedRun>();

  constructor(adapters: RunAdapter[]) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.backend, adapter);
    }
  }

  async spawnRun(input: SpawnRunInput): Promise<SpawnRunResult> {
    if (!path.isAbsolute(input.cwd)) {
      throw new Error(`cwd must be an absolute path: ${input.cwd}`);
    }
    await this.storage.validateCwd(input.cwd);

    const adapter = this.adapters.get(input.backend);
    if (!adapter) {
      throw new Error(`Unsupported backend: ${input.backend}`);
    }

    const metadata = input.metadata ?? {};
    const session =
      input.session_mode === 'resume'
        ? await this.loadResumeSession(input.cwd, input.backend, input.session_id ?? '')
        : await this.sessions.createNew(input.cwd, input.backend, metadata);

    const now = new Date().toISOString();
    const runId = randomUUID();
    const record: RunRecord = {
      runId,
      backend: input.backend,
      role: input.role,
      sessionId: session.sessionId,
      status: 'queued',
      cwd: input.cwd,
      prompt: input.prompt,
      profile: input.profile,
      metadata,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      lastSeq: 0,
      summary: 'Run queued',
      result: null,
      error: null,
    };

    await this.storage.writeRunRecord(record);
    const handle = await adapter.spawn({
      runId,
      role: input.role,
      prompt: input.prompt,
      cwd: input.cwd,
      sessionMode: input.session_mode,
      session,
      profile: input.profile,
      outputSchema: input.output_schema,
      metadata,
    });
    const buffer = new EventBuffer();
    const managed: ManagedRun = {
      record,
      session,
      adapter,
      handle,
      buffer,
      task: Promise.resolve(),
    };
    managed.task = this.runManaged(managed).catch(async (error) => {
      await this.markRunFailed(managed, String(error));
    });
    this.runs.set(runId, managed);

    return {
      run_id: runId,
      backend: record.backend,
      role: record.role,
      session_id: record.sessionId,
      status: record.status,
    };
  }

  async getRun(input: GetRunInput): Promise<GetRunResult> {
    const managed = this.getManagedRun(input.run_id);
    return toGetRunResult(managed.record);
  }

  async pollEvents(input: PollEventsInput): Promise<PollEventsResult> {
    const managed = this.getManagedRun(input.run_id);
    const events = await managed.buffer.waitForAfter(
      input.after_seq,
      input.limit ?? 100,
      input.wait_ms ?? 20000,
    );
    return {
      run_id: managed.record.runId,
      status: managed.record.status,
      events,
      next_after_seq: events.at(-1)?.seq ?? input.after_seq,
    };
  }

  async cancelRun(input: CancelRunInput): Promise<CancelRunResult> {
    const managed = this.getManagedRun(input.run_id);
    if (
      managed.record.status === 'completed' ||
      managed.record.status === 'failed' ||
      managed.record.status === 'cancelled'
    ) {
      throw new Error(`run is already terminal: ${managed.record.status}`);
    }

    await managed.adapter.cancel(managed.handle);
    const cancelledAt = new Date().toISOString();
    const event = this.prepareEvent(managed, {
      seq: 0,
      ts: cancelledAt,
      run_id: '',
      session_id: managed.record.sessionId,
      backend: managed.record.backend,
      type: 'status_changed',
      data: {
        status: 'cancelled',
      },
    });
    managed.record.result = managed.handle.getResult();
    await this.persistEvent(managed, event);

    return {
      run_id: managed.record.runId,
      status: managed.record.status,
      cancelled_at: cancelledAt,
    };
  }

  async listRuns(input: ListRunsInput): Promise<ListRunsResult> {
    const runs = [...this.runs.values()]
      .map((managed) => managed.record)
      .filter((record) => {
        if (input.status && record.status !== input.status) {
          return false;
        }
        if (input.backend && record.backend !== input.backend) {
          return false;
        }
        if (input.cwd && record.cwd !== input.cwd) {
          return false;
        }
        return true;
      })
      .map(toGetRunResult);

    return { runs };
  }

  private async loadResumeSession(
    cwd: string,
    backend: BackendKind,
    sessionId: string,
  ): Promise<SessionRecord> {
    const session = await this.sessions.getExisting(cwd, sessionId);
    if (!session) {
      throw new Error(`Unknown session_id: ${sessionId}`);
    }
    if (session.backend !== backend) {
      throw new Error(
        `Session ${sessionId} is bound to backend ${session.backend}, not ${backend}`,
      );
    }
    if (!session.backendSessionId) {
      throw new Error(`Session ${sessionId} has no backend session id yet`);
    }
    return session;
  }

  private getManagedRun(runId: string): ManagedRun {
    const managed = this.runs.get(runId);
    if (!managed) {
      throw new Error(`Unknown run_id: ${runId}`);
    }
    return managed;
  }

  private async runManaged(managed: ManagedRun): Promise<void> {
    const [streamResult, runResult] = await Promise.allSettled([
      this.consumeEvents(managed),
      managed.handle.run(),
    ]);

    if (managed.record.status === 'cancelled') {
      await this.storage.writeRunRecord(managed.record);
      await this.storage.writeResult(
        managed.record.cwd,
        managed.record.runId,
        managed.handle.getResult(),
      );
      return;
    }

    if (streamResult.status === 'rejected') {
      await this.markRunFailed(managed, String(streamResult.reason));
      return;
    }
    if (runResult.status === 'rejected') {
      await this.markRunFailed(managed, String(runResult.reason));
      return;
    }

    if (
      managed.record.status === 'running' ||
      managed.record.status === 'queued'
    ) {
      const completedAt = new Date().toISOString();
      managed.record.status = 'completed';
      managed.record.summary = managed.handle.getSummary() || 'Run completed';
      managed.record.updatedAt = completedAt;
      managed.record.completedAt = completedAt;
      managed.record.result = managed.handle.getResult();
      await this.storage.writeRunRecord(managed.record);
      await this.storage.writeResult(managed.record.cwd, managed.record.runId, managed.record.result);
    }
  }

  private async consumeEvents(managed: ManagedRun): Promise<void> {
    for await (const adapterEvent of managed.handle.eventStream) {
      if (isRawEvent(adapterEvent)) {
        continue;
      }
      const event = this.prepareEvent(managed, adapterEvent);
      await this.persistEvent(managed, event);
    }
  }

  private prepareEvent(managed: ManagedRun, event: NormalizedEvent): NormalizedEvent {
    return {
      ...event,
      seq: managed.record.lastSeq + 1,
      ts: event.ts || new Date().toISOString(),
      run_id: managed.record.runId,
      session_id: managed.record.sessionId,
      backend: managed.record.backend,
    };
  }

  private applyEventToRecord(managed: ManagedRun, event: NormalizedEvent): void {
    const now = event.ts;
    managed.record.lastSeq = event.seq;
    managed.record.updatedAt = now;

    const status = extractRunStatus(event);
    if (status) {
      managed.record.status = status;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        managed.record.completedAt = now;
      }
    }

    if (event.type === 'run_started') {
      managed.record.status = 'running';
    }
    if (event.type === 'run_completed') {
      managed.record.status = 'completed';
      managed.record.completedAt = now;
      managed.record.result = {
        finalResponse: (event.data.final_response as string | null | undefined) ?? null,
        structuredOutput: event.data.structured_output,
        usage: event.data.usage,
      };
    }
    if (event.type === 'run_failed') {
      managed.record.status = 'failed';
      managed.record.completedAt = now;
      managed.record.error = String(event.data.message ?? 'Run failed');
    }

    const summary = deriveSummary(event, managed.handle.getSummary());
    if (summary) {
      managed.record.summary = summary;
    }

    const backendSessionId = event.data.backend_session_id ?? event.data.thread_id;
    if (
      typeof backendSessionId === 'string' &&
      backendSessionId &&
      managed.session.backendSessionId !== backendSessionId
    ) {
      managed.session.backendSessionId = backendSessionId;
      void this.sessions.update(managed.session);
    }

    if (managed.record.status === 'completed' || managed.record.status === 'failed') {
      managed.record.result = managed.handle.getResult() ?? managed.record.result;
    }
  }

  private async persistEvent(managed: ManagedRun, event: NormalizedEvent): Promise<void> {
    this.applyEventToRecord(managed, event);
    managed.buffer.append(event);
    await this.storage.appendEvent(managed.record.cwd, managed.record.runId, event);
    await this.storage.writeRunRecord(managed.record);
    if (
      managed.record.status === 'completed' ||
      managed.record.status === 'failed' ||
      managed.record.status === 'cancelled'
    ) {
      await this.storage.writeResult(managed.record.cwd, managed.record.runId, managed.record.result);
    }
  }

  private async markRunFailed(managed: ManagedRun, message: string): Promise<void> {
    if (managed.record.status === 'failed' || managed.record.status === 'cancelled') {
      return;
    }
    const failedAt = new Date().toISOString();
    managed.record.result = managed.handle.getResult();

    const event = this.prepareEvent(managed, {
      seq: 0,
      ts: failedAt,
      run_id: '',
      session_id: managed.record.sessionId,
      backend: managed.record.backend,
      type: 'run_failed',
      data: {
        message,
      },
    });
    await this.persistEvent(managed, event);
  }
}

function toGetRunResult(record: RunRecord): GetRunResult {
  return {
    run_id: record.runId,
    backend: record.backend,
    role: record.role,
    session_id: record.sessionId,
    status: record.status,
    started_at: record.startedAt,
    updated_at: record.updatedAt,
    summary: record.summary,
    last_seq: record.lastSeq,
    cwd: record.cwd,
    metadata: record.metadata,
  };
}

function isRawEvent(value: NormalizedEvent | { kind: 'raw' }): value is { kind: 'raw' } {
  return 'kind' in value && value.kind === 'raw';
}

function extractRunStatus(event: NormalizedEvent): RunStatus | null {
  if (event.type === 'run_started') {
    return 'running';
  }
  if (event.type === 'run_completed') {
    return 'completed';
  }
  if (event.type === 'run_failed') {
    return 'failed';
  }
  if (event.type === 'status_changed') {
    const status = event.data.status;
    if (
      status === 'queued' ||
      status === 'running' ||
      status === 'completed' ||
      status === 'failed' ||
      status === 'cancelled'
    ) {
      return status;
    }
  }
  return null;
}

function deriveSummary(event: NormalizedEvent, fallback: string): string {
  switch (event.type) {
    case 'run_started':
      return 'Run started';
    case 'status_changed': {
      if (event.data.status === 'cancelled') {
        return 'Run cancelled';
      }
      return typeof event.data.status === 'string' ? `Status: ${event.data.status}` : fallback;
    }
    case 'command_started':
    case 'command_updated':
    case 'command_finished':
      return typeof event.data.command === 'string' ? `${event.type}: ${event.data.command}` : fallback;
    case 'file_changed':
      return Array.isArray(event.data.changes)
        ? `Updated ${event.data.changes.length} file(s)`
        : fallback;
    case 'tool_started':
    case 'tool_finished':
      return typeof event.data.tool === 'string' ? `${event.type}: ${event.data.tool}` : fallback;
    case 'todo_updated':
      return 'Updated task checklist';
    case 'run_completed':
      return 'Run completed';
    case 'run_failed':
      return typeof event.data.message === 'string'
        ? `Run failed: ${event.data.message}`
        : 'Run failed';
    case 'agent_message':
      return typeof event.data.text === 'string' ? truncate(event.data.text) : fallback;
    case 'reasoning':
      return 'Updated reasoning';
    default:
      return fallback;
  }
}

function truncate(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > 120 ? `${singleLine.slice(0, 117)}...` : singleLine;
}
