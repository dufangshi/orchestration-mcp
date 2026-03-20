import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { normalizeInputMessage, summarizeMessageParts } from './messages.js';
import { normalizedEventSchema } from './schemas.js';
import { attachArtifactRefs, sanitizeEvent } from './event-sanitizer.js';
import { EventBuffer } from './event-buffer.js';
import { formatProfileSystemPrompt, loadResolvedProfile } from './profile.js';
import { SessionManager } from './session-manager.js';
import { Storage } from './storage.js';
import type {
  AgentDirectoryEntry,
  AgentDirectoryStatus,
  AgentInboxMessage,
  AgentMessage,
  AdapterRunHandle,
  AdapterSpawnParams,
  BackendKind,
  CancelRunInput,
  CancelRunResult,
  ContinueRunInput,
  ContinueRunResult,
  FetchAgentMessagesInput,
  FetchAgentMessagesResult,
  GetEventArtifactInput,
  GetEventArtifactResult,
  GetRunInput,
  GetRunResult,
  ListAgentsInput,
  ListAgentsResult,
  ListRunsInput,
  ListRunsResult,
  NormalizedEvent,
  PollEventsInput,
  PollEventsResult,
  RunAdapter,
  RunRecord,
  RunStatus,
  RunReferenceInput,
  SessionRecord,
  SendAgentMessageInput,
  SendAgentMessageResult,
  SessionMode,
  SpawnRunInput,
  SpawnRunResult,
} from './types.js';

interface ManagedRun {
  record: RunRecord;
  session: SessionRecord;
  adapter: RunAdapter;
  spawnParams: AdapterSpawnParams;
  handle: AdapterRunHandle | null;
  buffer: EventBuffer;
  task: Promise<void>;
  starting: boolean;
  cancelRequested: boolean;
}

interface ResolvedRunTarget {
  record: RunRecord;
  managed: ManagedRun | null;
}

export class RunManager {
  private readonly storage = new Storage();
  private readonly sessions = new SessionManager(this.storage);
  private readonly adapters = new Map<BackendKind, RunAdapter>();
  private readonly runs = new Map<string, ManagedRun>();
  private readonly activeRunsBySession = new Map<string, string>();
  private readonly queuedRunsBySession = new Map<string, ManagedRun[]>();

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
    const inputMessage = normalizeInputMessage({
      prompt: input.prompt,
      inputMessage: input.input_message,
    });
    const prompt = input.prompt ?? summarizeMessageParts(inputMessage.parts) ?? '[structured input]';
    const resolvedProfile = await loadResolvedProfile(input.profile, input.cwd);
    const systemPrompt = resolvedProfile
      ? formatProfileSystemPrompt(resolvedProfile)
      : undefined;
    const session =
      input.session_mode === 'resume'
        ? await this.loadResumeSession(input.cwd, input.backend, input.session_id ?? '')
        : await this.sessions.createNew(
            input.cwd,
            input.backend,
            await this.resolveNewAgentName(input.cwd, input.nickname),
            metadata,
          );
    const agentName =
      input.session_mode === 'resume'
        ? await this.resolveResumeAgentName(session, input.nickname)
        : getSessionAgentName(session);

    const now = new Date().toISOString();
    const runId = randomUUID();
    const record: RunRecord = {
      runId,
      backend: input.backend,
      role: input.role,
      sessionId: session.sessionId,
      agentName,
      status: 'queued',
      cwd: input.cwd,
      prompt,
      profile: input.profile,
      metadata,
      remoteRef: session.remoteRef,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      lastSeq: 0,
      summary: 'Run queued',
      result: null,
      error: null,
    };

    const spawnParams: AdapterSpawnParams = {
      runId,
      role: input.role,
      prompt,
      inputMessage,
      systemPrompt,
      cwd: input.cwd,
      sessionMode: input.session_mode,
      session,
      profile: input.profile,
      outputSchema: input.output_schema,
      metadata,
      backendConfig: input.backend_config ?? {},
    };

    const managed: ManagedRun = {
      record,
      session,
      adapter,
      spawnParams,
      handle: null,
      buffer: new EventBuffer(),
      task: Promise.resolve(),
      starting: false,
      cancelRequested: false,
    };

    const shouldQueue = this.shouldQueueSessionRun(input.session_mode, session);
    if (shouldQueue) {
      managed.record.summary = 'Run queued behind active session run';
      this.runs.set(runId, managed);
      await this.storage.writeRunRecord(record);
      this.enqueueRunForSession(managed);
      return {
        run_id: runId,
        backend: record.backend,
        role: record.role,
        session_id: record.sessionId,
        agent_name: agentName,
        status: record.status,
      };
    }

    const sessionKey = this.getSessionKey(session);
    this.claimSessionRun(sessionKey, runId);
    try {
      managed.handle = await adapter.spawn(spawnParams);
    } catch (error) {
      this.releaseSessionRun(sessionKey, runId);
      throw error;
    }

    this.runs.set(runId, managed);
    await this.storage.writeRunRecord(record);
    this.scheduleManagedRun(managed);

    return {
      run_id: runId,
      backend: record.backend,
      role: record.role,
      session_id: record.sessionId,
      agent_name: agentName,
      status: record.status,
    };
  }

  async getRun(input: GetRunInput): Promise<GetRunResult> {
    const target = await this.resolveRunTarget(input);
    return toGetRunResult(target.record);
  }

  async continueRun(input: ContinueRunInput): Promise<ContinueRunResult> {
    const target = await this.resolveRunTarget(input);
    const managed = target.managed;
    const storedRecord = target.record;

    if (storedRecord.status === 'failed' || storedRecord.status === 'completed') {
      return this.resumeTerminalRun(storedRecord, input.input_message, 'continue_run_after_terminal');
    }

    if (!managed) {
      throw new Error(`run is not active in this process: ${input.run_id}`);
    }
    if (isTerminalStatus(managed.record.status)) {
      throw new Error(`run is already terminal: ${managed.record.status}`);
    }
    if (managed.record.status !== 'input_required' && managed.record.status !== 'auth_required') {
      throw new Error(`run is not awaiting additional input: ${managed.record.status}`);
    }
    if (!managed.handle) {
      throw new Error(`run has not started yet: ${managed.record.status}`);
    }
    const continueFn = managed.adapter.continue ?? managed.handle.continue;
    if (!continueFn) {
      throw new Error(`backend does not support continue: ${managed.record.backend}`);
    }

    const resumedAt = new Date().toISOString();
    const resumeEvent = this.prepareEvent(managed, {
      seq: 0,
      ts: resumedAt,
      run_id: '',
      session_id: managed.record.sessionId,
      backend: managed.record.backend,
      type: 'status_changed',
      data: {
        status: 'running',
        reason: 'continue_run',
      },
    });
    await this.persistEvent(managed, resumeEvent);

    if (managed.adapter.continue) {
      await managed.adapter.continue(managed.handle, input.input_message);
    } else {
      await managed.handle.continue?.(input.input_message);
    }

    return {
      run_id: managed.record.runId,
      status: managed.record.status,
      session_id: managed.record.sessionId,
      agent_name: getRunAgentName(managed.record),
      mode: 'live',
      resumed_from_run_id: null,
    };
  }

  async pollEvents(input: PollEventsInput): Promise<PollEventsResult> {
    const target = await this.resolveRunTarget(input);
    const managed = target.managed;
    if (managed) {
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

    const record = target.record;
    const events = await this.storage.readEvents(record.cwd, record.runId, input.after_seq, input.limit ?? 100);
    return {
      run_id: record.runId,
      status: record.status,
      events,
      next_after_seq: events.at(-1)?.seq ?? input.after_seq,
    };
  }

  async cancelRun(input: CancelRunInput): Promise<CancelRunResult> {
    const target = await this.resolveRunTarget(input);
    const managed = target.managed;
    if (!managed) {
      throw new Error(`run is not active in this process: ${target.record.status}`);
    }

    if (isTerminalStatus(managed.record.status)) {
      throw new Error(`run is already terminal: ${managed.record.status}`);
    }

    if (!managed.handle) {
      await this.cancelQueuedRun(managed);
      return {
        run_id: managed.record.runId,
        status: managed.record.status,
        cancelled_at: managed.record.completedAt ?? new Date().toISOString(),
      };
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

  async getEventArtifact(input: GetEventArtifactInput): Promise<GetEventArtifactResult> {
    const target = await this.resolveRunTarget(input);
    const managed = target.managed;
    if (managed) {
      return this.storage.readEventArtifact(
        managed.record.cwd,
        managed.record.runId,
        input.seq,
        input.field_path,
        input.offset ?? 0,
        input.limit ?? 65536,
      );
    }

    return this.storage.readEventArtifact(
      target.record.cwd,
      target.record.runId,
      input.seq,
      input.field_path,
      input.offset ?? 0,
      input.limit ?? 65536,
    );
  }

  async listRuns(input: ListRunsInput): Promise<ListRunsResult> {
    const runs = (await this.collectMergedRunRecords({
      cwd: input.cwd,
      backend: input.backend,
      status: input.status,
    }))
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
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map(toGetRunResult);

    return { runs };
  }

  async sendAgentMessage(input: SendAgentMessageInput): Promise<SendAgentMessageResult> {
    const sender = input.from_agent_name
      ? await this.resolveAgentSession(input.from_agent_name, input.cwd)
      : null;
    const resolutionCwd = input.cwd ?? sender?.cwd;
    if (sender && resolutionCwd && sender.cwd !== resolutionCwd) {
      throw new Error(`Cross-cwd agent messaging is not supported: ${sender.cwd} -> ${resolutionCwd}`);
    }
    const recipient = await this.resolveAgentSession(input.to_agent_name, resolutionCwd);
    const createdAt = new Date().toISOString();
    const stored = await this.storage.appendInboxMessage(recipient.cwd, recipient.sessionId, {
      message_id: randomUUID(),
      from_agent_name: sender?.agentName ?? null,
      from_session_id: sender?.sessionId ?? null,
      to_agent_name: getSessionAgentName(recipient),
      to_session_id: recipient.sessionId,
      created_at: createdAt,
      body: input.message,
      metadata: input.metadata ?? {},
    });
    return {
      message_id: stored.message_id,
      to_agent_name: stored.to_agent_name,
      to_session_id: stored.to_session_id,
      seq: stored.seq,
      created_at: stored.created_at,
    };
  }

  async fetchAgentMessages(input: FetchAgentMessagesInput): Promise<FetchAgentMessagesResult> {
    const session = await this.resolveAgentSession(input.agent_name, input.cwd);
    const messages = await this.storage.readInboxMessages(
      session.cwd,
      session.sessionId,
      input.after_seq ?? 0,
      input.limit ?? 100,
    );
    return {
      agent_name: getSessionAgentName(session),
      session_id: session.sessionId,
      messages,
      next_after_seq: messages.at(-1)?.seq ?? (input.after_seq ?? 0),
    };
  }

  async listAgents(input: ListAgentsInput): Promise<ListAgentsResult> {
    const sessions = await this.storage.listSessionRecords(input.cwd);
    const mergedRuns = await this.collectMergedRunRecords({
      cwd: input.cwd,
      backend: input.backend,
    });
    const runsBySession = new Map<string, RunRecord[]>();
    for (const record of mergedRuns) {
      const existing = runsBySession.get(record.sessionId) ?? [];
      existing.push(record);
      runsBySession.set(record.sessionId, existing);
    }

    const agents: AgentDirectoryEntry[] = [];
    for (const session of sessions) {
      if (input.backend && session.backend !== input.backend) {
        continue;
      }
      const namedSession = await this.ensureSessionAgentName(session);
      const selectedRun = selectAgentDirectoryRun(runsBySession.get(session.sessionId) ?? []);
      const entry: AgentDirectoryEntry = {
        agent_name: getSessionAgentName(namedSession),
        role: selectedRun?.role ?? null,
        session_id: namedSession.sessionId,
        status: selectedRun?.status ?? 'idle',
        cwd: namedSession.cwd,
        last_run_id: selectedRun?.runId ?? null,
        updated_at: selectedRun?.updatedAt ?? namedSession.updatedAt,
      };
      if (input.status && entry.status !== input.status) {
        continue;
      }
      agents.push(entry);
    }

    agents.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    return { agents };
  }

  async shutdown(timeoutMs = 5000): Promise<void> {
    const activeRuns = [...this.runs.values()].filter((managed) => !isTerminalStatus(managed.record.status));
    for (const managed of activeRuns) {
      try {
        if (!managed.handle) {
          await this.cancelQueuedRun(managed, 'shutdown');
          continue;
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
            reason: 'shutdown',
          },
        });
        await this.persistEvent(managed, event);
      } catch {
        // Best-effort shutdown. Individual adapter failures should not block process exit.
      }
    }

    await Promise.race([
      Promise.allSettled([...this.runs.values()].map((managed) => managed.task)),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
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
    if (!session.backendSessionId && !session.remoteRef?.context_id && !session.remoteRef?.conversation_id) {
      throw new Error(`Session ${sessionId} has no backend session id yet`);
    }
    return session;
  }

  private async resolveNewAgentName(cwd: string, nickname: string | undefined): Promise<string> {
    const requestedName = normalizeAgentNameInput(nickname);
    if (requestedName) {
      await this.assertAgentNameAvailable(cwd, requestedName);
      return requestedName;
    }
    return this.generateDefaultAgentName(cwd);
  }

  private async resolveResumeAgentName(
    session: SessionRecord,
    nickname: string | undefined,
  ): Promise<string> {
    const agentName = getSessionAgentName(await this.ensureSessionAgentName(session));

    const requestedName = normalizeAgentNameInput(nickname);
    if (requestedName && requestedName !== agentName) {
      throw new Error(`Session ${session.sessionId} is already named ${agentName}, not ${requestedName}`);
    }
    return agentName;
  }

  private async ensureSessionAgentName(session: SessionRecord): Promise<SessionRecord> {
    if (session.agentName) {
      return session;
    }
    session.agentName = await this.generateDefaultAgentName(session.cwd, session.sessionId);
    await this.sessions.update(session);
    return session;
  }

  private async generateDefaultAgentName(cwd: string, excludeSessionId?: string): Promise<string> {
    const knownNames = await this.collectKnownAgentNames(cwd, excludeSessionId);
    let index = 1;
    while (knownNames.has(`agent${index}`)) {
      index += 1;
    }
    return `agent${index}`;
  }

  private async assertAgentNameAvailable(cwd: string, agentName: string): Promise<void> {
    const knownNames = await this.collectKnownAgentNames(cwd);
    if (knownNames.has(agentName)) {
      throw new Error(`Agent name is already in use: ${agentName}`);
    }
  }

  private async collectKnownAgentNames(cwd: string, excludeSessionId?: string): Promise<Set<string>> {
    const names = new Set<string>();
    const sessions = await this.storage.listSessionRecords(cwd);
    for (const session of sessions) {
      if (excludeSessionId && session.sessionId === excludeSessionId) {
        continue;
      }
      if (session.agentName) {
        names.add(session.agentName);
      }
    }
    return names;
  }

  private async resolveAgentSession(agentName: string, cwd?: string | null): Promise<SessionRecord> {
    const normalizedName = normalizeAgentNameInput(agentName);
    const resolvedCwd = typeof cwd === 'string' ? cwd : undefined;
    if (!normalizedName) {
      throw new Error('agent_name is required');
    }
    const sessions = await this.storage.listSessionRecords(resolvedCwd);
    const matches: SessionRecord[] = [];
    for (const session of sessions) {
      const namedSession = await this.ensureSessionAgentName(session);
      if (namedSession.agentName === normalizedName) {
        matches.push(namedSession);
      }
    }
    if (matches.length === 0) {
      throw new Error(
        resolvedCwd
          ? `Unknown agent_name in cwd ${resolvedCwd}: ${normalizedName}`
          : `Unknown agent_name: ${normalizedName}`,
      );
    }
    if (matches.length > 1) {
      throw new Error(`agent_name is ambiguous across multiple cwd values: ${normalizedName}`);
    }
    return matches[0];
  }

  private async collectMergedRunRecords(filters: {
    cwd?: string;
    backend?: BackendKind;
    status?: RunStatus;
  } = {}): Promise<RunRecord[]> {
    const liveRecords = [...this.runs.values()].map((managed) => managed.record);
    const persistedRecords = await this.storage.listRunRecords(filters);
    const merged = new Map<string, RunRecord>();
    for (const record of persistedRecords) {
      merged.set(record.runId, record);
    }
    for (const record of liveRecords) {
      merged.set(record.runId, record);
    }
    return [...merged.values()];
  }

  private async resolveRunTarget(input: RunReferenceInput): Promise<ResolvedRunTarget> {
    const runId = typeof input.run_id === 'string' ? input.run_id.trim() : '';
    const agentName = normalizeAgentNameInput(input.agent_name);
    if (!runId && !agentName) {
      throw new Error('Provide run_id or agent_name');
    }

    if (runId) {
      const managed = this.findManagedRun(runId);
      if (managed) {
        return {
          record: managed.record,
          managed,
        };
      }

      const record = await this.storage.readRunRecordById(runId);
      if (!record) {
        throw new Error(`Unknown run_id: ${runId}`);
      }
      return {
        record,
        managed: null,
      };
    }

    const session = await this.resolveAgentSession(agentName!, input.cwd);
    const records = (await this.collectMergedRunRecords({
      cwd: session.cwd,
      backend: session.backend,
    })).filter((record) => record.sessionId === session.sessionId);
    const selected = selectRunReferenceRecord(records);
    if (!selected) {
      throw new Error(
        input.cwd
          ? `No runs found for agent_name in cwd ${input.cwd}: ${agentName}`
          : `No runs found for agent_name: ${agentName}`,
      );
    }

    return {
      record: selected,
      managed: this.findManagedRun(selected.runId),
    };
  }

  private findManagedRun(runId: string): ManagedRun | null {
    return this.runs.get(runId) ?? null;
  }

  private scheduleManagedRun(managed: ManagedRun): void {
    managed.task = this.runManaged(managed)
      .catch(async (error) => {
        await this.markRunFailed(managed, String(error));
      })
      .finally(async () => {
        await this.onManagedRunSettled(managed);
      });
  }

  private async startQueuedRun(managed: ManagedRun): Promise<void> {
    if (isTerminalStatus(managed.record.status)) {
      return;
    }

    const sessionKey = this.getSessionKey(managed.session);
    this.claimSessionRun(sessionKey, managed.record.runId);
    managed.starting = true;

    try {
      managed.handle = await managed.adapter.spawn(managed.spawnParams);
      managed.starting = false;
      if (managed.cancelRequested || isTerminalStatus(managed.record.status)) {
        if (managed.handle) {
          await managed.adapter.cancel(managed.handle);
        }
        this.releaseSessionRun(sessionKey, managed.record.runId);
        await this.startNextQueuedRun(sessionKey);
        return;
      }
      this.scheduleManagedRun(managed);
    } catch (error) {
      managed.starting = false;
      this.releaseSessionRun(sessionKey, managed.record.runId);
      await this.markRunFailed(managed, String(error));
      await this.startNextQueuedRun(sessionKey);
    }
  }

  private async runManaged(managed: ManagedRun): Promise<void> {
    const handle = managed.handle;
    if (!handle) {
      throw new Error(`run has no active handle: ${managed.record.runId}`);
    }

    const [streamResult, runResult] = await Promise.allSettled([
      this.consumeEvents(managed),
      handle.run(),
    ]);

    if (managed.record.status === 'cancelled') {
      await this.storage.writeRunRecord(managed.record);
      await this.storage.writeResult(
        managed.record.cwd,
        managed.record.runId,
        handle.getResult(),
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
      managed.record.status === 'queued' ||
      managed.record.status === 'input_required' ||
      managed.record.status === 'auth_required'
    ) {
      const completedAt = new Date().toISOString();
      managed.record.status = 'completed';
      managed.record.summary = handle.getSummary() || 'Run completed';
      managed.record.updatedAt = completedAt;
      managed.record.completedAt = completedAt;
      managed.record.result = handle.getResult();
      await this.storage.writeRunRecord(managed.record);
      await this.storage.writeResult(managed.record.cwd, managed.record.runId, managed.record.result);
    }
  }

  private async consumeEvents(managed: ManagedRun): Promise<void> {
    const handle = managed.handle;
    if (!handle) {
      throw new Error(`run has no active handle: ${managed.record.runId}`);
    }
    for await (const adapterEvent of handle.eventStream) {
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
    const previousStatus = managed.record.status;
    const fallbackSummary = managed.handle?.getSummary() ?? managed.record.summary;
    managed.record.lastSeq = event.seq;
    managed.record.updatedAt = now;

    const backendSessionId = event.data.backend_session_id ?? event.data.thread_id ?? event.data.context_id;
    if (
      typeof backendSessionId === 'string' &&
      backendSessionId &&
      managed.session.backendSessionId !== backendSessionId
    ) {
      managed.session.backendSessionId = backendSessionId;
      void this.sessions.update(managed.session);
    }

    const remoteRef = extractRemoteRef(managed, event);
    if (remoteRef) {
      managed.session.remoteRef = {
        ...(managed.session.remoteRef ?? {}),
        ...remoteRef,
      };
      managed.record.remoteRef = managed.session.remoteRef;
      void this.sessions.update(managed.session);
    }

    if (isTerminalStatus(previousStatus)) {
      return;
    }

    const status = extractRunStatus(event);
    if (status) {
      managed.record.status = status;
      if (isTerminalStatus(status)) {
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

    const summary = deriveSummary(event, fallbackSummary);
    if (summary) {
      managed.record.summary = summary;
    }

    if (managed.record.status === 'completed' || managed.record.status === 'failed') {
      managed.record.result = managed.handle?.getResult() ?? managed.record.result;
    }
  }

  private async persistEvent(managed: ManagedRun, event: NormalizedEvent): Promise<void> {
    const { event: sanitizedBase, artifacts } = sanitizeEvent(event);
    const refs = await this.storage.writeArtifacts(
      managed.record.cwd,
      managed.record.runId,
      sanitizedBase,
      artifacts,
    );
    const validatedEvent = normalizedEventSchema.parse(attachArtifactRefs(sanitizedBase, refs));

    this.applyEventToRecord(managed, validatedEvent);
    managed.buffer.append(validatedEvent);
    await this.storage.appendEvent(managed.record.cwd, managed.record.runId, validatedEvent);
    await this.storage.writeRunRecord(managed.record);
    if (isTerminalStatus(managed.record.status)) {
      await this.storage.writeResult(managed.record.cwd, managed.record.runId, managed.record.result);
    }
  }

  private async markRunFailed(managed: ManagedRun, message: string): Promise<void> {
    if (isTerminalStatus(managed.record.status)) {
      return;
    }
    const failedAt = new Date().toISOString();
    managed.record.result = managed.handle?.getResult() ?? null;

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

  private async resumeTerminalRun(
    record: RunRecord,
    inputMessage: AgentMessage,
    resumeReason: string,
  ): Promise<ContinueRunResult> {
    const session = await this.sessions.getExisting(record.cwd, record.sessionId);
    if (!session) {
      throw new Error(`Unknown session_id: ${record.sessionId}`);
    }

    const resumable =
      Boolean(session.backendSessionId) ||
      Boolean(session.remoteRef?.context_id) ||
      Boolean(session.remoteRef?.conversation_id);
    if (!resumable) {
      throw new Error(`run failed before the backend session became resumable: ${record.runId}`);
    }

    const resumed = await this.spawnRun({
      backend: record.backend,
      role: record.role,
      cwd: record.cwd,
      session_mode: 'resume',
      session_id: record.sessionId,
      input_message: inputMessage,
      profile: record.profile,
      metadata: {
        resumed_from_run_id: record.runId,
        resume_reason: resumeReason,
      },
      backend_config: this.buildResumeBackendConfig(record, session),
    });

    return {
      run_id: resumed.run_id,
      status: resumed.status,
      session_id: resumed.session_id,
      agent_name: resumed.agent_name,
      mode: 'resume',
      resumed_from_run_id: record.runId,
    };
  }

  private buildResumeBackendConfig(record: RunRecord, session: SessionRecord): Record<string, unknown> {
    if (record.backend !== 'remote_a2a') {
      return {};
    }

    const agentUrl = session.remoteRef?.agent_url ?? record.remoteRef?.agent_url;
    return agentUrl ? { agent_url: agentUrl } : {};
  }

  private shouldQueueSessionRun(sessionMode: SessionMode, session: SessionRecord): boolean {
    if (sessionMode !== 'resume') {
      return false;
    }
    const sessionKey = this.getSessionKey(session);
    return this.activeRunsBySession.has(sessionKey) || (this.queuedRunsBySession.get(sessionKey)?.length ?? 0) > 0;
  }

  private enqueueRunForSession(managed: ManagedRun): void {
    const sessionKey = this.getSessionKey(managed.session);
    const queue = this.queuedRunsBySession.get(sessionKey) ?? [];
    queue.push(managed);
    this.queuedRunsBySession.set(sessionKey, queue);
  }

  private claimSessionRun(sessionKey: string, runId: string): void {
    const activeRunId = this.activeRunsBySession.get(sessionKey);
    if (activeRunId && activeRunId !== runId) {
      throw new Error(`session already has an active run: ${sessionKey}`);
    }
    this.activeRunsBySession.set(sessionKey, runId);
  }

  private releaseSessionRun(sessionKey: string, runId: string): void {
    if (this.activeRunsBySession.get(sessionKey) === runId) {
      this.activeRunsBySession.delete(sessionKey);
    }
  }

  private async onManagedRunSettled(managed: ManagedRun): Promise<void> {
    if (!isTerminalStatus(managed.record.status)) {
      return;
    }
    const sessionKey = this.getSessionKey(managed.session);
    this.releaseSessionRun(sessionKey, managed.record.runId);
    await this.startNextQueuedRun(sessionKey);
  }

  private async startNextQueuedRun(sessionKey: string): Promise<void> {
    if (this.activeRunsBySession.has(sessionKey)) {
      return;
    }
    const queue = this.queuedRunsBySession.get(sessionKey);
    if (!queue?.length) {
      this.queuedRunsBySession.delete(sessionKey);
      return;
    }
    const next = queue.shift();
    if (!queue.length) {
      this.queuedRunsBySession.delete(sessionKey);
    } else {
      this.queuedRunsBySession.set(sessionKey, queue);
    }
    if (!next) {
      return;
    }
    await this.startQueuedRun(next);
  }

  private async cancelQueuedRun(managed: ManagedRun, reason?: string): Promise<void> {
    managed.cancelRequested = true;
    const sessionKey = this.getSessionKey(managed.session);
    const queue = this.queuedRunsBySession.get(sessionKey);
    if (queue) {
      const nextQueue = queue.filter((candidate) => candidate.record.runId !== managed.record.runId);
      if (nextQueue.length) {
        this.queuedRunsBySession.set(sessionKey, nextQueue);
      } else {
        this.queuedRunsBySession.delete(sessionKey);
      }
    }

    if (isTerminalStatus(managed.record.status)) {
      return;
    }

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
        ...(reason ? { reason } : {}),
      },
    });
    await this.persistEvent(managed, event);
  }

  private getSessionKey(session: SessionRecord): string {
    return `${session.cwd}::${session.sessionId}`;
  }
}

function toGetRunResult(record: RunRecord): GetRunResult {
  return {
    run_id: record.runId,
    backend: record.backend,
    role: record.role,
    session_id: record.sessionId,
    agent_name: getRunAgentName(record),
    status: record.status,
    started_at: record.startedAt,
    updated_at: record.updatedAt,
    summary: record.summary,
    last_seq: record.lastSeq,
    cwd: record.cwd,
    metadata: record.metadata ?? {},
    remote_ref: record.remoteRef ?? null,
  };
}

function getRunAgentName(record: RunRecord): string {
  return record.agentName ?? `run-${record.runId.slice(0, 8)}`;
}

function getSessionAgentName(session: SessionRecord): string {
  return session.agentName ?? `session-${session.sessionId.slice(0, 8)}`;
}

function normalizeAgentNameInput(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function selectAgentDirectoryRun(records: RunRecord[]): RunRecord | null {
  if (records.length === 0) {
    return null;
  }

  const active = records
    .filter((record) => !isTerminalStatus(record.status))
    .sort(compareRunRecordsByPriority);
  if (active.length > 0) {
    return active[0];
  }

  const sorted = [...records].sort(compareRunRecordsByPriority);
  return sorted[0] ?? null;
}

function selectRunReferenceRecord(records: RunRecord[]): RunRecord | null {
  if (records.length === 0) {
    return null;
  }

  const executing = records
    .filter((record) => record.status === 'running' || record.status === 'input_required' || record.status === 'auth_required')
    .sort(compareRunRecordsByPriority);
  if (executing.length > 0) {
    return executing[0];
  }

  const queued = records
    .filter((record) => record.status === 'queued')
    .sort(compareRunRecordsByPriority);
  if (queued.length > 0) {
    return queued[0];
  }

  const sorted = [...records].sort(compareRunRecordsByPriority);
  return sorted[0] ?? null;
}

function compareRunRecordsByPriority(left: RunRecord, right: RunRecord): number {
  const updated = right.updatedAt.localeCompare(left.updatedAt);
  if (updated !== 0) {
    return updated;
  }
  return right.startedAt.localeCompare(left.startedAt);
}

function isRawEvent(value: NormalizedEvent | { kind: 'raw' }): value is { kind: 'raw' } {
  return 'kind' in value && value.kind === 'raw';
}

function isTerminalStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'rejected';
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
  if (event.type === 'input_required') {
    return 'input_required';
  }
  if (event.type === 'auth_required') {
    return 'auth_required';
  }
  if (event.type === 'rejected') {
    return 'rejected';
  }
  if (event.type === 'status_changed') {
    const status = event.data.status;
    if (
      status === 'queued' ||
      status === 'running' ||
      status === 'input_required' ||
      status === 'auth_required' ||
      status === 'completed' ||
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'rejected'
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
      if (event.data.status === 'input_required') {
        return 'Waiting for additional input';
      }
      if (event.data.status === 'auth_required') {
        return 'Authentication required';
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
    case 'artifact_added':
      return typeof event.data.name === 'string' ? `Artifact: ${event.data.name}` : 'Added artifact';
    case 'todo_updated':
      return 'Updated task checklist';
    case 'input_required':
      return typeof event.data.text === 'string' ? truncate(event.data.text) : 'Waiting for additional input';
    case 'auth_required':
      return typeof event.data.text === 'string' ? truncate(event.data.text) : 'Authentication required';
    case 'rejected':
      return typeof event.data.message === 'string' ? `Rejected: ${event.data.message}` : 'Run rejected';
    case 'run_completed':
      return 'Run completed';
    case 'run_failed':
      return typeof event.data.message === 'string'
        ? `Run failed: ${event.data.message}`
        : 'Run failed';
    case 'agent_message':
      return typeof event.data.text === 'string' ? truncate(event.data.text) : fallback;
    case 'message_added':
      return typeof event.data.text === 'string' ? truncate(event.data.text) : 'Added message';
    case 'reasoning':
      return 'Updated reasoning';
    default:
      return fallback;
  }
}

function extractRemoteRef(managed: ManagedRun, event: NormalizedEvent): SessionRecord['remoteRef'] | null {
  const value = event.data.remote_ref;
  if (value && typeof value === 'object') {
    return {
      ...(value as SessionRecord['remoteRef']),
      provider: managed.record.backend,
    };
  }

  const contextId = getStringField(event.data, 'context_id');
  const taskId = getStringField(event.data, 'task_id');
  const agentUrl = getStringField(event.data, 'agent_url');
  const agentName = getStringField(event.data, 'agent_name');
  const conversationId =
    getStringField(event.data, 'conversation_id') ??
    getStringField(event.data, 'backend_session_id') ??
    getStringField(event.data, 'thread_id');

  if (!contextId && !taskId && !agentUrl && !agentName && !conversationId) {
    return null;
  }

  return {
    provider: managed.record.backend,
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(taskId ? { task_id: taskId } : {}),
    ...(contextId ? { context_id: contextId } : {}),
    ...(agentUrl ? { agent_url: agentUrl } : {}),
    ...(agentName ? { agent_name: agentName } : {}),
  };
}

function getStringField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' && value ? value : null;
}

function truncate(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > 120 ? `${singleLine.slice(0, 117)}...` : singleLine;
}
