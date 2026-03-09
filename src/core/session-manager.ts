import { randomUUID } from 'node:crypto';

import type { BackendKind, SessionRecord } from './types.js';
import { Storage } from './storage.js';

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(private readonly storage: Storage) {}

  async createNew(
    cwd: string,
    backend: BackendKind,
    metadata: Record<string, unknown>,
  ): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      sessionId: randomUUID(),
      backend,
      cwd,
      backendSessionId: null,
      createdAt: now,
      updatedAt: now,
      metadata,
    };
    this.sessions.set(this.key(cwd, record.sessionId), record);
    await this.storage.writeSessionRecord(record);
    return record;
  }

  async getExisting(cwd: string, sessionId: string): Promise<SessionRecord | null> {
    const key = this.key(cwd, sessionId);
    const cached = this.sessions.get(key);
    if (cached) {
      return cached;
    }
    const record = await this.storage.readSessionRecord(cwd, sessionId);
    if (record) {
      this.sessions.set(key, record);
    }
    return record;
  }

  async update(record: SessionRecord): Promise<void> {
    record.updatedAt = new Date().toISOString();
    this.sessions.set(this.key(record.cwd, record.sessionId), record);
    await this.storage.writeSessionRecord(record);
  }

  private key(cwd: string, sessionId: string): string {
    return `${cwd}::${sessionId}`;
  }
}
