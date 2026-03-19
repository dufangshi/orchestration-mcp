import { normalizedEventSchema } from '../core/schemas.js';
import { Storage } from '../core/storage.js';
import type { NormalizedEvent, RunRecord } from '../core/types.js';

const ACTIVE_STATUSES = new Set(['queued', 'running', 'input_required', 'auth_required']);
const DEFAULT_FAILURE_MESSAGE = 'orchestrator host stopped before the run completed';

export async function reconcileOrphanedRuns(
  storage = new Storage(),
  message = DEFAULT_FAILURE_MESSAGE,
): Promise<number> {
  const records = await storage.listRunRecords();
  let reconciled = 0;

  for (const record of records) {
    if (!ACTIVE_STATUSES.has(record.status)) {
      continue;
    }
    if (record.metadata?.control_plane !== 'daemon') {
      continue;
    }
    await markOrphanedRunFailed(storage, record, message);
    reconciled += 1;
  }

  return reconciled;
}

async function markOrphanedRunFailed(storage: Storage, record: RunRecord, message: string): Promise<void> {
  const failedAt = new Date().toISOString();
  const event: NormalizedEvent = normalizedEventSchema.parse({
    seq: record.lastSeq + 1,
    ts: failedAt,
    run_id: record.runId,
    session_id: record.sessionId,
    backend: record.backend,
    type: 'run_failed',
    data: {
      message,
      reason: 'daemon_recovery',
    },
  });

  record.status = 'failed';
  record.error = message;
  record.lastSeq = event.seq;
  record.updatedAt = failedAt;
  record.completedAt = failedAt;
  record.summary = `Run failed: ${message}`;

  await storage.appendEvent(record.cwd, record.runId, event);
  await storage.writeRunRecord(record);
  await storage.writeResult(record.cwd, record.runId, record.result);
}
