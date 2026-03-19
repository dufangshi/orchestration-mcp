import { RunManager } from '../core/run-manager.js';
import type {
  CancelRunInput,
  CancelRunResult,
  ContinueRunInput,
  ContinueRunResult,
  GetEventArtifactInput,
  GetEventArtifactResult,
  GetRunInput,
  GetRunResult,
  ListRunsInput,
  ListRunsResult,
  NormalizedEvent,
  PollEventsInput,
  PollEventsResult,
  RunStatus,
  SpawnRunInput,
  SpawnRunResult,
} from '../core/types.js';

export interface OrchestratorService {
  spawnRun(input: SpawnRunInput): Promise<SpawnRunResult>;
  getRun(input: GetRunInput): Promise<GetRunResult>;
  listRuns(input: ListRunsInput): Promise<ListRunsResult>;
  pollEvents(input: PollEventsInput): Promise<PollEventsResult>;
  continueRun(input: ContinueRunInput): Promise<ContinueRunResult>;
  cancelRun(input: CancelRunInput): Promise<CancelRunResult>;
  getEventArtifact(input: GetEventArtifactInput): Promise<GetEventArtifactResult>;
  shutdown?(timeoutMs?: number): Promise<void>;
}

export interface TailRunOptions {
  after_seq?: number;
  limit?: number;
  wait_ms?: number;
  timeout_ms?: number;
  stop_on_terminal?: boolean;
}

export interface WaitForRunOptions extends TailRunOptions {
  timeout_ms?: number;
  stop_on_input_required?: boolean;
  stop_on_auth_required?: boolean;
}

export interface WaitForRunResult {
  run: GetRunResult;
  events: NormalizedEvent[];
  next_after_seq: number;
  timed_out: boolean;
}

export class RunManagerService implements OrchestratorService {
  constructor(private readonly manager: Pick<
    RunManager,
    'spawnRun' | 'getRun' | 'listRuns' | 'pollEvents' | 'continueRun' | 'cancelRun' | 'getEventArtifact' | 'shutdown'
  >) {}

  spawnRun(input: SpawnRunInput): Promise<SpawnRunResult> {
    return this.manager.spawnRun(input);
  }

  getRun(input: GetRunInput): Promise<GetRunResult> {
    return this.manager.getRun(input);
  }

  listRuns(input: ListRunsInput): Promise<ListRunsResult> {
    return this.manager.listRuns(input);
  }

  pollEvents(input: PollEventsInput): Promise<PollEventsResult> {
    return this.manager.pollEvents(input);
  }

  continueRun(input: ContinueRunInput): Promise<ContinueRunResult> {
    return this.manager.continueRun(input);
  }

  cancelRun(input: CancelRunInput): Promise<CancelRunResult> {
    return this.manager.cancelRun(input);
  }

  getEventArtifact(input: GetEventArtifactInput): Promise<GetEventArtifactResult> {
    return this.manager.getEventArtifact(input);
  }

  shutdown(timeoutMs?: number): Promise<void> {
    return this.manager.shutdown(timeoutMs);
  }
}

export async function* tailRunEvents(
  service: Pick<OrchestratorService, 'pollEvents'>,
  runId: string,
  options: TailRunOptions = {},
): AsyncGenerator<NormalizedEvent, { next_after_seq: number; status: RunStatus }, void> {
  const startedAt = Date.now();
  let afterSeq = options.after_seq ?? 0;

  for (;;) {
    const polled = await service.pollEvents({
      run_id: runId,
      after_seq: afterSeq,
      limit: options.limit ?? 100,
      wait_ms: options.wait_ms ?? 20000,
    });

    for (const event of polled.events) {
      yield event;
    }

    afterSeq = polled.next_after_seq;
    if (options.stop_on_terminal !== false && isTerminalStatus(polled.status)) {
      return {
        next_after_seq: afterSeq,
        status: polled.status,
      };
    }

    if ((options.wait_ms ?? 20000) === 0 && polled.events.length === 0) {
      return {
        next_after_seq: afterSeq,
        status: polled.status,
      };
    }
  }
}

export async function waitForRun(
  service: Pick<OrchestratorService, 'getRun' | 'pollEvents'>,
  runId: string,
  options: WaitForRunOptions = {},
): Promise<WaitForRunResult> {
  const startedAt = Date.now();
  let afterSeq = options.after_seq ?? 0;
  const events: NormalizedEvent[] = [];

  for (;;) {
    const remainingTimeoutMs =
      options.timeout_ms === undefined
        ? undefined
        : Math.max(0, options.timeout_ms - (Date.now() - startedAt));
    const polled = await service.pollEvents({
      run_id: runId,
      after_seq: afterSeq,
      limit: options.limit ?? 100,
      wait_ms:
        remainingTimeoutMs === undefined
          ? (options.wait_ms ?? 20000)
          : Math.min(options.wait_ms ?? 20000, remainingTimeoutMs),
    });
    events.push(...polled.events);
    afterSeq = polled.next_after_seq;

    if (shouldStopOnStatus(polled.status, options)) {
      return {
        run: await service.getRun({ run_id: runId }),
        events,
        next_after_seq: afterSeq,
        timed_out: false,
      };
    }

    if (options.timeout_ms !== undefined && Date.now() - startedAt >= options.timeout_ms) {
      return {
        run: await service.getRun({ run_id: runId }),
        events,
        next_after_seq: afterSeq,
        timed_out: true,
      };
    }
  }
}

export function isTerminalStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'rejected';
}

function shouldStopOnStatus(status: RunStatus, options: WaitForRunOptions): boolean {
  if (isTerminalStatus(status)) {
    return true;
  }
  if (status === 'input_required') {
    return options.stop_on_input_required !== false;
  }
  if (status === 'auth_required') {
    return options.stop_on_auth_required !== false;
  }
  return false;
}
