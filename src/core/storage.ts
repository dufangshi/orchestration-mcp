import { mkdir, appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { NormalizedEvent, RunRecord, RunResult, SessionRecord } from './types.js';

const ROOT_DIR = '.nanobot-orchestrator';

export class Storage {
  getRootDir(cwd: string): string {
    return path.join(cwd, ROOT_DIR);
  }

  getRunsDir(cwd: string): string {
    return path.join(this.getRootDir(cwd), 'runs');
  }

  getRunDir(cwd: string, runId: string): string {
    return path.join(this.getRunsDir(cwd), runId);
  }

  getSessionsDir(cwd: string): string {
    return path.join(this.getRootDir(cwd), 'sessions');
  }

  getSessionPath(cwd: string, sessionId: string): string {
    return path.join(this.getSessionsDir(cwd), `${sessionId}.json`);
  }

  async validateCwd(cwd: string): Promise<void> {
    const info = await stat(cwd);
    if (!info.isDirectory()) {
      throw new Error(`cwd is not a directory: ${cwd}`);
    }
  }

  async writeRunRecord(record: RunRecord): Promise<void> {
    const runDir = this.getRunDir(record.cwd, record.runId);
    await mkdir(runDir, { recursive: true });
    await writeJson(path.join(runDir, 'run.json'), record);
  }

  async appendEvent(cwd: string, runId: string, event: NormalizedEvent): Promise<void> {
    const runDir = this.getRunDir(cwd, runId);
    await mkdir(runDir, { recursive: true });
    await appendFile(path.join(runDir, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
  }

  async writeResult(cwd: string, runId: string, result: RunResult | null): Promise<void> {
    const runDir = this.getRunDir(cwd, runId);
    await mkdir(runDir, { recursive: true });
    await writeJson(path.join(runDir, 'result.json'), result);
  }

  async writeSessionRecord(record: SessionRecord): Promise<void> {
    const sessionsDir = this.getSessionsDir(record.cwd);
    await mkdir(sessionsDir, { recursive: true });
    await writeJson(this.getSessionPath(record.cwd, record.sessionId), record);
  }

  async readSessionRecord(cwd: string, sessionId: string): Promise<SessionRecord | null> {
    try {
      const raw = await readFile(this.getSessionPath(cwd, sessionId), 'utf8');
      return JSON.parse(raw) as SessionRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
