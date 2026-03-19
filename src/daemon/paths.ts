import path from 'node:path';

import { getOrchestratorHomeDir } from '../core/paths.js';

export function getDaemonDir(): string {
  return path.join(getOrchestratorHomeDir(), 'daemon');
}

export function getDaemonStatePath(): string {
  return path.join(getDaemonDir(), 'daemon.json');
}

export function getDaemonSocketPath(): string {
  return path.join(getDaemonDir(), 'control.sock');
}
