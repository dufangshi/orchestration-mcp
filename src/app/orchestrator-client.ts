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
  SpawnRunInput,
  SpawnRunResult,
} from '../core/types.js';
import { DaemonClient } from '../daemon/client.js';
import type { DaemonStartResult, DaemonStatus, DaemonStopResult } from '../daemon/types.js';
import {
  connectToDaemon,
  ensureDaemonRunning,
  getDaemonStatus,
  stopDaemon,
} from '../daemon/supervisor.js';
import type { OrchestratorService } from './orchestrator-service.js';

export class DetachedOrchestratorClient implements OrchestratorService {
  async daemonStart(): Promise<DaemonStartResult> {
    return ensureDaemonRunning();
  }

  async daemonStatus(): Promise<DaemonStatus> {
    return getDaemonStatus();
  }

  async daemonStop(): Promise<DaemonStopResult> {
    return stopDaemon();
  }

  async spawnRun(input: SpawnRunInput): Promise<SpawnRunResult> {
    const client = await this.ensureClient();
    return client.spawnRun({
      ...input,
      metadata: {
        ...(input.metadata ?? {}),
        control_plane: 'daemon',
      },
    });
  }

  async getRun(input: GetRunInput): Promise<GetRunResult> {
    const client = await this.requireClient();
    return client.getRun(input);
  }

  async listRuns(input: ListRunsInput): Promise<ListRunsResult> {
    const client = await this.requireClient();
    return client.listRuns(input);
  }

  async pollEvents(input: { run_id: string; after_seq: number; limit?: number; wait_ms?: number }) {
    const client = await this.requireClient();
    return client.pollEvents(input);
  }

  async continueRun(input: ContinueRunInput): Promise<ContinueRunResult> {
    const client = await this.requireClient();
    return client.continueRun(input);
  }

  async cancelRun(input: CancelRunInput): Promise<CancelRunResult> {
    const client = await this.requireClient();
    return client.cancelRun(input);
  }

  async getEventArtifact(input: GetEventArtifactInput): Promise<GetEventArtifactResult> {
    const client = await this.requireClient();
    return client.getEventArtifact(input);
  }

  private async ensureClient(): Promise<DaemonClient> {
    const started = await ensureDaemonRunning();
    if (!started.daemon) {
      throw new Error('daemon did not expose connection details');
    }
    return new DaemonClient(started.daemon.socket_path);
  }

  private async requireClient(): Promise<DaemonClient> {
    return connectToDaemon();
  }
}
