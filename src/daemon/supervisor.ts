import { spawn } from 'node:child_process';
import { access, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { DaemonClient } from './client.js';
import { getDaemonSocketPath } from './paths.js';
import { clearDaemonState, readDaemonState } from './server.js';
import type { DaemonStartResult, DaemonStatus, DaemonStopResult } from './types.js';

const START_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

export async function ensureDaemonRunning(): Promise<DaemonStartResult> {
  const status = await getDaemonStatus();
  if (status.status === 'running') {
    return {
      ...status,
      created: false,
    };
  }

  const child = spawn(process.execPath, [fileURLToPath(new URL('./entrypoint.js', import.meta.url))], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  const startedAt = Date.now();
  for (;;) {
    const nextStatus = await getDaemonStatus();
    if (nextStatus.status === 'running') {
      return {
        ...nextStatus,
        created: true,
      };
    }
    if (Date.now() - startedAt > START_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for daemon startup after ${START_TIMEOUT_MS}ms`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export async function getDaemonStatus(): Promise<DaemonStatus> {
  const state = await readDaemonState();
  if (!state) {
    return {
      status: 'stopped',
      daemon: null,
      reason: 'state_file_missing',
    };
  }

  const socketExists = await pathExists(state.socket_path);
  if (!socketExists && !(await isProcessRunning(state.pid))) {
    await clearDaemonState();
    return {
      status: 'stopped',
      daemon: null,
      reason: 'stale_state',
    };
  }

  try {
    const client = new DaemonClient(state.socket_path);
    const remoteState = await client.getDaemonState();
    return {
      status: 'running',
      daemon: remoteState,
    };
  } catch (error) {
    if (!(await isProcessRunning(state.pid))) {
      await clearDaemonState();
      return {
        status: 'stopped',
        daemon: null,
        reason: 'stale_state',
      };
    }
    return {
      status: 'stopped',
      daemon: state,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function connectToDaemon(): Promise<DaemonClient> {
  const status = await getDaemonStatus();
  if (status.status !== 'running' || !status.daemon) {
    throw new Error(
      status.reason
        ? `daemon is not running: ${status.reason}`
        : 'daemon is not running',
    );
  }
  return new DaemonClient(status.daemon.socket_path);
}

export async function stopDaemon(): Promise<DaemonStopResult> {
  const status = await getDaemonStatus();
  if (status.status !== 'running' || !status.daemon) {
    if (status.daemon) {
      await cleanupSocket(status.daemon.socket_path);
      await clearDaemonState();
    }
    return {
      stopped: true,
      previously_running: false,
    };
  }

  const client = new DaemonClient(status.daemon.socket_path);
  await client.shutdown();

  const startedAt = Date.now();
  for (;;) {
    const nextStatus = await getDaemonStatus();
    if (nextStatus.status === 'stopped') {
      return {
        stopped: true,
        previously_running: true,
      };
    }
    if (Date.now() - startedAt > START_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for daemon shutdown after ${START_TIMEOUT_MS}ms`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function cleanupSocket(socketPath: string): Promise<void> {
  if (socketPath === getDaemonSocketPath()) {
    await rm(socketPath, { force: true }).catch(() => undefined);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
