import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, stat } from 'node:fs/promises';

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

test('late terminal events do not override cancelled status', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-cancel-late-'));
  const manager = new RunManager([new LateTerminalAdapter()]);

  const spawned = await manager.spawnRun({
    backend: 'codex',
    role: 'worker',
    prompt: 'cancel me',
    cwd,
    session_mode: 'new',
  });

  await manager.cancelRun({ run_id: spawned.run_id });

  await waitFor(async () => {
    const run = await manager.getRun({ run_id: spawned.run_id });
    assert.equal(run.status, 'cancelled');
    assert.equal(run.last_seq, 2);
  });

  const polled = await manager.pollEvents({
    run_id: spawned.run_id,
    after_seq: 0,
    limit: 10,
    wait_ms: 0,
  });
  assert.deepEqual(polled.events.map((event) => event.type), ['status_changed', 'run_completed']);

  const runJson = await readRunJson(cwd, spawned.run_id);
  assert.equal(runJson.status, 'cancelled');
  assert.equal(runJson.completedAt !== null, true);
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

test('spawnRun does not persist orphaned queued runs when adapter spawn fails', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-spawn-fail-'));
  const manager = new RunManager([new FailingSpawnAdapter()]);

  await assert.rejects(
    manager.spawnRun({
      backend: 'codex',
      role: 'worker',
      prompt: 'explode',
      cwd,
      session_mode: 'new',
    }),
    /spawn failure/,
  );

  const runsDir = path.join(cwd, '.nanobot-orchestrator', 'runs');
  await assert.rejects(stat(runsDir), /ENOENT/);

  const listed = await manager.listRuns({ cwd });
  assert.equal(listed.runs.length, 0);
});

test('shutdown cancels active runs and persists terminal state', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-shutdown-'));
  const manager = new RunManager([new HangingAdapter()]);

  const spawned = await manager.spawnRun({
    backend: 'codex',
    role: 'worker',
    prompt: 'hang',
    cwd,
    session_mode: 'new',
  });

  await manager.shutdown(1000);

  const run = await manager.getRun({ run_id: spawned.run_id });
  assert.equal(run.status, 'cancelled');

  const runJson = await readRunJson(cwd, spawned.run_id);
  assert.equal(runJson.status, 'cancelled');
});

test('RunManager can read historical runs and artifacts back from disk', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-history-'));
  const stdout = 'S'.repeat(9000);
  const rawToolUseResult = {
    content: 'R'.repeat(7000),
    file_path: '/tmp/project/README.md',
    kind: 'read_result',
  };
  const liveManager = new RunManager([
    new CompletingAdapter([
      {
        type: 'run_started',
        data: { status: 'running' },
      },
      {
        type: 'tool_finished',
        data: {
          tool: 'Read',
          command: 'cat README.md',
          stdout,
          raw_tool_use_result: rawToolUseResult,
        },
      },
      {
        type: 'run_completed',
        data: {
          final_response: 'done',
          structured_output: { status: 'ok' },
        },
      },
    ]),
  ]);

  const spawned = await liveManager.spawnRun({
    backend: 'codex',
    role: 'worker',
    prompt: 'sanitize',
    cwd,
    session_mode: 'new',
  });

  await waitFor(async () => {
    const run = await liveManager.getRun({ run_id: spawned.run_id });
    assert.equal(run.status, 'completed');
    assert.equal(run.last_seq, 3);
  });

  const historicalManager = new RunManager([]);
  const historicalRun = await historicalManager.getRun({ run_id: spawned.run_id });
  assert.equal(historicalRun.status, 'completed');
  assert.equal(historicalRun.cwd, cwd);

  const polled = await historicalManager.pollEvents({
    run_id: spawned.run_id,
    after_seq: 0,
    limit: 10,
    wait_ms: 0,
  });
  assert.equal(polled.events.length, 3);

  const toolEvent = polled.events.find((event) => event.type === 'tool_finished');
  assert.ok(toolEvent, 'expected a tool_finished event');
  assert.match(toolEvent.data.stdout, /truncated, see artifact_refs/);
  assert.equal(toolEvent.data.artifact_refs['/stdout'].mime, 'text/plain');
  assert.equal(toolEvent.data.artifact_refs['/raw_tool_use_result'].mime, 'application/json');
  assert.deepEqual(toolEvent.data.raw_tool_use_result, {
    artifact_summary: {
      original_type: 'object',
      key_count: 3,
      preview_keys: ['content', 'file_path', 'kind'],
    },
  });

  const stdoutArtifact = await historicalManager.getEventArtifact({
    run_id: spawned.run_id,
    seq: toolEvent.seq,
    field_path: '/stdout',
  });
  assert.equal(stdoutArtifact.content, stdout);
  assert.equal(stdoutArtifact.has_more, false);

  const readArtifact = await historicalManager.getEventArtifact({
    run_id: spawned.run_id,
    seq: toolEvent.seq,
    field_path: '/raw_tool_use_result',
  });
  assert.deepEqual(JSON.parse(readArtifact.content), rawToolUseResult);

  const listed = await historicalManager.listRuns({ cwd });
  assert.equal(listed.runs.some((run) => run.run_id === spawned.run_id), true);

  await assert.rejects(
    historicalManager.getEventArtifact({
      run_id: spawned.run_id,
      seq: toolEvent.seq,
      field_path: '/missing',
    }),
    /Available field paths: \/stdout, \/raw_tool_use_result|Available field paths: \/raw_tool_use_result, \/stdout/,
  );

  const eventsPath = path.join(
    cwd,
    '.nanobot-orchestrator',
    'runs',
    spawned.run_id,
    'events.jsonl',
  );
  const eventsJsonl = await readFile(eventsPath, 'utf8');
  assert.match(eventsJsonl, /artifact_refs/);
  assert.ok(!eventsJsonl.includes(stdout));
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

class LateTerminalAdapter {
  backend = 'codex';

  async spawn(params) {
    return new LateTerminalHandle(params.session.sessionId);
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

class FailingSpawnAdapter {
  backend = 'codex';

  async spawn() {
    throw new Error('spawn failure');
  }

  async cancel() {}
}

class CompletingAdapter {
  backend = 'codex';

  constructor(events) {
    this.events = events;
  }

  async spawn(params) {
    return new CompletingHandle(params.session.sessionId, this.events);
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

class LateTerminalHandle {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.result = { finalResponse: 'done' };
    this.aborted = false;
    this.eventStream = (async function* (self) {
      while (!self.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      yield {
        seq: 0,
        ts: new Date().toISOString(),
        run_id: '',
        session_id: sessionId,
        backend: 'codex',
        type: 'run_completed',
        data: {
          final_response: 'done',
        },
      };
    })(this);
  }

  async run() {
    while (!this.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  getSummary() {
    return 'Late completion';
  }

  getResult() {
    return this.result;
  }

  abort() {
    this.aborted = true;
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

class CompletingHandle {
  constructor(sessionId, templateEvents) {
    this.sessionId = sessionId;
    this.result = {
      finalResponse: 'done',
      structuredOutput: { status: 'ok' },
    };
    this.eventStream = (async function* () {
      for (const templateEvent of templateEvents) {
        yield {
          seq: 0,
          ts: new Date().toISOString(),
          run_id: '',
          session_id: sessionId,
          backend: 'codex',
          type: templateEvent.type,
          data: structuredClone(templateEvent.data),
        };
      }
    })();
  }

  async run() {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  getSummary() {
    return 'Completed run';
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
