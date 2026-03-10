import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';

import { RunManager } from '../dist/core/run-manager.js';

test('cancelRun persists lastSeq and cancelled event consistently', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-cancel-'));
  const manager = new RunManager([new HangingAdapter()]);

  const spawned = await manager.spawnRun({
    backend: 'codex',
    role: 'worker',
    prompt: 'hang',
    cwd,
    session_mode: 'new',
  });

  const cancelled = await manager.cancelRun({ run_id: spawned.run_id });
  assert.equal(cancelled.status, 'cancelled');

  await waitFor(async () => {
    const run = await manager.getRun({ run_id: spawned.run_id });
    assert.equal(run.status, 'cancelled');
    assert.equal(run.last_seq, 1);
  });

  const runJson = await readRunJson(cwd, spawned.run_id);
  assert.equal(runJson.lastSeq, 1);

  const polled = await manager.pollEvents({
    run_id: spawned.run_id,
    after_seq: 0,
    limit: 10,
    wait_ms: 0,
  });
  assert.equal(polled.events.length, 1);
  assert.equal(polled.events[0].seq, 1);
  assert.equal(polled.events[0].data.status, 'cancelled');
});

test('markRunFailed persists lastSeq when background run fails', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-fail-'));
  const manager = new RunManager([new RejectingAdapter()]);

  const spawned = await manager.spawnRun({
    backend: 'codex',
    role: 'worker',
    prompt: 'fail',
    cwd,
    session_mode: 'new',
  });

  await waitFor(async () => {
    const run = await manager.getRun({ run_id: spawned.run_id });
    assert.equal(run.status, 'failed');
    assert.equal(run.last_seq, 1);
  });

  const runJson = await readRunJson(cwd, spawned.run_id);
  assert.equal(runJson.lastSeq, 1);
  assert.match(runJson.error, /simulated failure/);
});

class HangingAdapter {
  backend = 'codex';

  async spawn(params) {
    const handle = new HangingHandle(params.session.sessionId);
    this.lastHandle = handle;
    return handle;
  }

  async cancel(handle) {
    handle.abort();
  }
}

class RejectingAdapter {
  backend = 'codex';

  async spawn(params) {
    return new RejectingHandle(params.session.sessionId);
  }

  async cancel() {}
}

class HangingHandle {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.eventStream = emptyStream();
    this.result = null;
    this.runPromise = new Promise((resolve) => {
      this.resolveRun = resolve;
    });
  }

  async run() {
    return this.runPromise;
  }

  getSummary() {
    return 'Hanging run';
  }

  getResult() {
    return this.result;
  }

  abort() {
    this.resolveRun();
  }
}

class RejectingHandle {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.eventStream = emptyStream();
    this.result = null;
  }

  async run() {
    throw new Error('simulated failure');
  }

  getSummary() {
    return 'Rejecting run';
  }

  getResult() {
    return this.result;
  }
}

function emptyStream() {
  return (async function* () {})();
}

async function readRunJson(cwd, runId) {
  const filePath = path.join(cwd, '.nanobot-orchestrator', 'runs', runId, 'run.json');
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function waitFor(assertion, timeoutMs = 1000) {
  const startedAt = Date.now();
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt > timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
