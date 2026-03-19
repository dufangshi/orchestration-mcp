import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

export const ORCHESTRATOR_ROOT_DIR = '.nanobot-orchestrator';

export function getOrchestratorHomeDir(): string {
  const override = process.env.NANOBOT_ORCHESTRATOR_HOME?.trim();
  if (override) {
    return path.resolve(override);
  }
  const currentHome = process.env.HOME?.trim() || homedir();
  const preferred = path.join(currentHome, ORCHESTRATOR_ROOT_DIR);
  try {
    accessSync(currentHome, constants.W_OK);
    return preferred;
  } catch {
    return path.join(process.cwd(), ORCHESTRATOR_ROOT_DIR, 'home');
  }
}
