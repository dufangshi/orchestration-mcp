#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { RunManagerService } from '../app/orchestrator-service.js';
import { createDefaultManager } from '../app/orchestrator-app.js';
import type { OrchestratorService } from '../app/orchestrator-service.js';
import { RunManager } from '../core/run-manager.js';
import { clearDaemonState, startDaemonServer } from './server.js';
import { reconcileOrphanedRuns } from './orphaned-runs.js';

async function main(): Promise<void> {
  await reconcileOrphanedRuns();
  const service = await loadDaemonService();
  const server = await startDaemonServer(service);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await server.close();
  };

  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
}

main().catch(async (error) => {
  await clearDaemonState().catch(() => undefined);
  console.error('Failed to start daemon:', error);
  process.exit(1);
});

async function loadDaemonService(): Promise<OrchestratorService> {
  const factoryModule = process.env.NANOBOT_DAEMON_FACTORY_MODULE?.trim();
  if (!factoryModule) {
    return new RunManagerService(createDefaultManager());
  }

  const imported = await import(resolveImportSpecifier(factoryModule));
  if (typeof imported.createDaemonService === 'function') {
    return imported.createDaemonService();
  }
  if (typeof imported.createRunManager === 'function') {
    return new RunManagerService(imported.createRunManager() as RunManager);
  }
  throw new Error(
    `Factory module ${factoryModule} must export createDaemonService() or createRunManager()`,
  );
}

function resolveImportSpecifier(specifier: string): string {
  if (specifier.startsWith('file://')) {
    return specifier;
  }
  if (path.isAbsolute(specifier)) {
    return pathToFileURL(specifier).href;
  }
  return specifier;
}
