import { ClaudeCodeAdapter } from '../adapters/claude.js';
import { CodexAdapter } from '../adapters/codex.js';
import { RemoteA2AAdapter } from '../backends/remote-a2a.js';
import { RunManager } from '../core/run-manager.js';
import { Storage } from '../core/storage.js';

export interface OrchestratorApp {
  manager: RunManager;
  storage: Storage;
  shutdown(timeoutMs?: number): Promise<void>;
}

export function createDefaultManager(): RunManager {
  return new RunManager([new CodexAdapter(), new ClaudeCodeAdapter(), new RemoteA2AAdapter()]);
}

export function createOrchestratorApp(options?: {
  manager?: RunManager;
  storage?: Storage;
}): OrchestratorApp {
  const manager = options?.manager ?? createDefaultManager();
  const storage = options?.storage ?? new Storage();

  return {
    manager,
    storage,
    shutdown: (timeoutMs) => manager.shutdown(timeoutMs),
  };
}
