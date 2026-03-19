import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';

import { SessionManager } from '../dist/core/session-manager.js';
import { Storage } from '../dist/core/storage.js';

test('SessionManager creates, reloads, and updates session records', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-session-'));
  const storage = new Storage();
  const sessions = new SessionManager(storage);

  const created = await sessions.createNew(cwd, 'codex', 'worker1', { task: 'audit' });
  assert.equal(created.cwd, cwd);
  assert.equal(created.backend, 'codex');
  assert.equal(created.agentName, 'worker1');
  assert.equal(created.metadata.task, 'audit');

  const reloadedManager = new SessionManager(storage);
  const loaded = await reloadedManager.getExisting(cwd, created.sessionId);
  assert.equal(loaded?.sessionId, created.sessionId);
  assert.equal(loaded?.agentName, 'worker1');
  assert.equal(loaded?.metadata.task, 'audit');

  loaded.backendSessionId = 'backend-thread-1';
  await reloadedManager.update(loaded);

  const persisted = await storage.readSessionRecord(cwd, created.sessionId);
  assert.equal(persisted?.backendSessionId, 'backend-thread-1');
  assert.ok(Date.parse(persisted.updatedAt) >= Date.parse(created.updatedAt));
});
