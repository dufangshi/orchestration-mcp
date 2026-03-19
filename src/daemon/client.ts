import http from 'node:http';

import type { OrchestratorService } from '../app/orchestrator-service.js';
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
  PollEventsInput,
  PollEventsResult,
  SpawnRunInput,
  SpawnRunResult,
} from '../core/types.js';
import type { DaemonState } from './types.js';

export class DaemonClient implements OrchestratorService {
  constructor(private readonly socketPath: string) {}

  spawnRun(input: SpawnRunInput): Promise<SpawnRunResult> {
    return this.requestJson('POST', '/runs/spawn', input);
  }

  getRun(input: GetRunInput): Promise<GetRunResult> {
    return this.requestJson('POST', '/runs/get', input);
  }

  listRuns(input: ListRunsInput): Promise<ListRunsResult> {
    return this.requestJson('POST', '/runs/list', input);
  }

  pollEvents(input: PollEventsInput): Promise<PollEventsResult> {
    return this.requestJson('POST', '/runs/poll', input);
  }

  continueRun(input: ContinueRunInput): Promise<ContinueRunResult> {
    return this.requestJson('POST', '/runs/continue', input);
  }

  cancelRun(input: CancelRunInput): Promise<CancelRunResult> {
    return this.requestJson('POST', '/runs/cancel', input);
  }

  getEventArtifact(input: GetEventArtifactInput): Promise<GetEventArtifactResult> {
    return this.requestJson('POST', '/runs/artifact', input);
  }

  getDaemonState(): Promise<DaemonState> {
    return this.requestJson('GET', '/daemon/status');
  }

  async shutdown(): Promise<void> {
    await this.requestJson('POST', '/daemon/shutdown', {});
  }

  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');

    return new Promise<T>((resolve, reject) => {
      const req = http.request(
        {
          method,
          path,
          socketPath: this.socketPath,
          headers: payload
            ? {
                'content-type': 'application/json',
                'content-length': String(payload.length),
              }
            : undefined,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if ((res.statusCode ?? 500) >= 400) {
              const message = parseErrorMessage(raw) ?? `Daemon request failed: ${res.statusCode}`;
              reject(new Error(message));
              return;
            }
            if (!raw.trim()) {
              resolve(undefined as T);
              return;
            }
            resolve(JSON.parse(raw) as T);
          });
        },
      );

      req.on('error', reject);
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }
}

function parseErrorMessage(raw: string): string | null {
  if (!raw.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { error?: string };
    return typeof parsed.error === 'string' ? parsed.error : raw;
  } catch {
    return raw;
  }
}
