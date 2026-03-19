import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';

import express from 'express';
import type { Server } from 'node:http';

import type { OrchestratorService } from '../app/orchestrator-service.js';
import { getEventArtifactSchema, getRunSchema, listRunsSchema, pollEventsSchema, spawnRunSchema, continueRunSchema, cancelRunSchema } from '../core/schemas.js';
import { getDaemonDir, getDaemonSocketPath, getDaemonStatePath } from './paths.js';
import type { DaemonState } from './types.js';

export interface DaemonServerHandle {
  state: DaemonState;
  close(): Promise<void>;
}

export async function startDaemonServer(service: OrchestratorService): Promise<DaemonServerHandle> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const state: DaemonState = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    socket_path: getDaemonSocketPath(),
  };

  let server: Server | null = null;
  let closing: Promise<void> | null = null;

  const close = async (): Promise<void> => {
    if (closing) {
      return closing;
    }
    closing = (async () => {
      if (service.shutdown) {
        await service.shutdown();
      }
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server?.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
      await rm(state.socket_path, { force: true }).catch(() => undefined);
      await rm(getDaemonStatePath(), { force: true }).catch(() => undefined);
    })();
    return closing;
  };

  app.get('/daemon/status', (_req, res) => {
    res.json(state);
  });

  app.post('/daemon/shutdown', (_req, res) => {
    res.json({ ok: true });
    setImmediate(() => {
      void close();
    });
  });

  app.post('/runs/spawn', asyncHandler(async (req, res) => {
    const input = spawnRunSchema.parse(req.body);
    res.json(await service.spawnRun(input));
  }));

  app.post('/runs/get', asyncHandler(async (req, res) => {
    const input = getRunSchema.parse(req.body);
    res.json(await service.getRun(input));
  }));

  app.post('/runs/list', asyncHandler(async (req, res) => {
    const input = listRunsSchema.parse(req.body ?? {});
    res.json(await service.listRuns(input));
  }));

  app.post('/runs/poll', asyncHandler(async (req, res) => {
    const input = pollEventsSchema.parse(req.body);
    res.json(await service.pollEvents(input));
  }));

  app.post('/runs/continue', asyncHandler(async (req, res) => {
    const input = continueRunSchema.parse(req.body);
    res.json(await service.continueRun(input));
  }));

  app.post('/runs/cancel', asyncHandler(async (req, res) => {
    const input = cancelRunSchema.parse(req.body);
    res.json(await service.cancelRun(input));
  }));

  app.post('/runs/artifact', asyncHandler(async (req, res) => {
    const input = getEventArtifactSchema.parse(req.body);
    res.json(await service.getEventArtifact(input));
  }));

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  });

  await mkdir(getDaemonDir(), { recursive: true });
  await rm(state.socket_path, { force: true }).catch(() => undefined);

  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(state.socket_path, () => {
      server?.off('error', reject);
      resolve();
    });
  });

  await writeDaemonState(state);

  return {
    state,
    close,
  };
}

export async function readDaemonState(): Promise<DaemonState | null> {
  try {
    const raw = await readFile(getDaemonStatePath(), 'utf8');
    return JSON.parse(raw) as DaemonState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function clearDaemonState(): Promise<void> {
  await rm(getDaemonStatePath(), { force: true }).catch(() => undefined);
  await rm(getDaemonSocketPath(), { force: true }).catch(() => undefined);
}

async function writeDaemonState(state: DaemonState): Promise<void> {
  await writeFile(getDaemonStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function asyncHandler(
  handler: (req: express.Request, res: express.Response) => Promise<void>,
): express.RequestHandler {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}
