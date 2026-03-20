import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';

import { runOrchestratorCli } from '../dist/cli/orchestrator.js';
import { RunManager } from '../dist/core/run-manager.js';
import { Storage } from '../dist/core/storage.js';

const originalOrchestratorHome = process.env.NANOBOT_ORCHESTRATOR_HOME;
process.env.NANOBOT_ORCHESTRATOR_HOME = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-cli-home-'));

test.after(() => {
  if (originalOrchestratorHome === undefined) {
    delete process.env.NANOBOT_ORCHESTRATOR_HOME;
  } else {
    process.env.NANOBOT_ORCHESTRATOR_HOME = originalOrchestratorHome;
  }
});

test('orchestrator review uses reviewer role and defaults the reviewer profile from cwd', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-cli-review-'));
  await mkdir(path.join(cwd, 'profile'), { recursive: true });
  await writeFile(
    path.join(cwd, 'profile', 'reviewer-remediator.md'),
    '# Reviewer\nFix only low-risk issues.\n',
    'utf8',
  );

  const adapter = new CapturingAdapter([
    {
      type: 'agent_message',
      data: {
        text: 'Review complete.',
      },
    },
    {
      type: 'run_completed',
      data: {
        final_response: 'Review complete.',
      },
    },
  ]);
  const io = createIo({}, cwd);
  const manager = new RunManager([adapter]);
  const storage = new Storage();

  const exitCode = await runOrchestratorCli(
    ['review', 'Review the latest diff.', '--output', 'json'],
    io,
    {
      createApp: () => ({
        manager,
        storage,
        shutdown: async (timeoutMs = 1000) => {
          await manager.shutdown(timeoutMs);
        },
      }),
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(adapter.lastParams.role, 'reviewer');
  assert.match(adapter.lastParams.systemPrompt ?? '', /Fix only low-risk issues\./);

  const payload = readJson(io.stdoutText());
  assert.equal(payload.run.role, 'reviewer');
  assert.equal(payload.run.status, 'completed');
  assert.equal(payload.result.finalResponse, 'done');
});

test('orchestrator run --detach uses the detached client and returns spawn metadata', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-cli-detach-'));
  const io = createIo({}, cwd);
  const detachedClient = new FakeDetachedClient();

  const exitCode = await runOrchestratorCli(
    ['run', 'Ship it.', '--detach', '--output', 'json'],
    io,
    {
      createApp: () => createReadOnlyApp(),
      createDetachedClient: () => detachedClient,
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(detachedClient.spawnInputs.length, 1);
  assert.equal(detachedClient.spawnInputs[0].role, 'worker');
  assert.equal(detachedClient.spawnInputs[0].session_mode, 'new');

  const payload = readJson(io.stdoutText());
  assert.equal(payload.run_id, 'detached-run-1');
  assert.equal(payload.status, 'queued');
  assert.equal(payload.agent_name, 'worker1');
});

test('orchestrator daemon and detached run lifecycle commands use the detached client', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-cli-detached-ops-'));
  const detachedClient = new FakeDetachedClient();

  const daemonIo = createIo({}, cwd);
  const daemonExitCode = await runOrchestratorCli(['daemon', 'status', '--output', 'json'], daemonIo, {
    createApp: () => createReadOnlyApp(),
    createDetachedClient: () => detachedClient,
  });
  assert.equal(daemonExitCode, 0);
  assert.equal(readJson(daemonIo.stdoutText()).status, 'running');

  const continueIo = createIo({}, cwd);
  const continueExitCode = await runOrchestratorCli(
    ['runs', 'continue', 'worker1', 'Please continue.', '--cwd', cwd, '--output', 'json'],
    continueIo,
    {
      createApp: () => createReadOnlyApp(),
      createDetachedClient: () => detachedClient,
    },
  );
  assert.equal(continueExitCode, 0);
  assert.equal(detachedClient.continueInputs.length, 1);
  assert.equal(detachedClient.continueInputs[0].agent_name, 'worker1');
  assert.equal(detachedClient.continueInputs[0].cwd, cwd);
  assert.equal(
    detachedClient.continueInputs[0].input_message.parts.find((part) => part.type === 'text')?.text,
    'Please continue.',
  );
  assert.equal(readJson(continueIo.stdoutText()).mode, 'resume');

  const cancelIo = createIo({}, cwd);
  const cancelExitCode = await runOrchestratorCli(['runs', 'cancel', 'worker1', '--cwd', cwd, '--output', 'json'], cancelIo, {
    createApp: () => createReadOnlyApp(),
    createDetachedClient: () => detachedClient,
  });
  assert.equal(cancelExitCode, 0);
  assert.equal(detachedClient.cancelInputs.length, 1);
  assert.equal(detachedClient.cancelInputs[0].agent_name, 'worker1');
  assert.equal(detachedClient.cancelInputs[0].cwd, cwd);
  assert.equal(readJson(cancelIo.stdoutText()).status, 'cancelled');
});

test('orchestrator runs list and runs show expose persisted runs', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-cli-runs-'));
  const seedManager = new RunManager([
    new CompletingAdapter([
      {
        type: 'run_completed',
        data: {
          final_response: 'done',
        },
      },
    ]),
  ]);

  const spawned = await seedManager.spawnRun({
    backend: 'codex',
    role: 'worker',
    prompt: 'seed',
    cwd,
    session_mode: 'new',
  });

  await waitFor(async () => {
    const run = await seedManager.getRun({ run_id: spawned.run_id });
    assert.equal(run.status, 'completed');
  });
  await seedManager.shutdown(1000);

  const listIo = createIo({}, cwd);
  const listExitCode = await runOrchestratorCli(['runs', 'list', '--cwd', cwd, '--output', 'json'], listIo, {
    createApp: () => createReadOnlyApp(),
  });
  assert.equal(listExitCode, 0);
  const listPayload = readJson(listIo.stdoutText());
  assert.equal(listPayload.runs.length, 1);
  assert.equal(listPayload.runs[0].run_id, spawned.run_id);

  const showIo = createIo({}, cwd);
  const showExitCode = await runOrchestratorCli(['runs', 'show', spawned.agent_name, '--cwd', cwd, '--output', 'json'], showIo, {
    createApp: () => createReadOnlyApp(),
  });
  assert.equal(showExitCode, 0);
  const showPayload = readJson(showIo.stdoutText());
  assert.equal(showPayload.run_id, spawned.run_id);
  assert.equal(showPayload.status, 'completed');
});

test('orchestrator events tail streams persisted events as jsonl', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-cli-events-'));
  const seedManager = new RunManager([
    new CompletingAdapter([
      {
        type: 'agent_message',
        data: {
          text: 'Working on it.',
        },
      },
      {
        type: 'run_completed',
        data: {
          final_response: 'done',
        },
      },
    ]),
  ]);

  const spawned = await seedManager.spawnRun({
    backend: 'codex',
    role: 'planner',
    prompt: 'seed',
    cwd,
    session_mode: 'new',
  });

  await waitFor(async () => {
    const run = await seedManager.getRun({ run_id: spawned.run_id });
    assert.equal(run.status, 'completed');
  });
  await seedManager.shutdown(1000);

  const io = createIo({}, cwd);
  const exitCode = await runOrchestratorCli(
    ['events', 'tail', spawned.agent_name, '--cwd', cwd, '--output', 'jsonl', '--timeout', '0'],
    io,
    { createApp: () => createReadOnlyApp() },
  );
  assert.equal(exitCode, 0);

  const lines = io
    .stdoutText()
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(lines[0].type, 'agent_message');
  assert.equal(lines[1].type, 'run_completed');
  assert.equal(lines.at(-1).type, 'run_summary');
  assert.equal(lines.at(-1).run.run_id, spawned.run_id);
});

test('orchestrator artifacts get reads persisted event artifacts', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-cli-artifacts-'));
  const stdout = 'S'.repeat(9000);
  const seedManager = new RunManager([
    new CompletingAdapter([
      {
        type: 'tool_finished',
        data: {
          tool: 'Read',
          stdout,
        },
      },
      {
        type: 'run_completed',
        data: {
          final_response: 'done',
        },
      },
    ]),
  ]);

  const spawned = await seedManager.spawnRun({
    backend: 'codex',
    role: 'worker',
    prompt: 'seed',
    cwd,
    session_mode: 'new',
  });

  let toolEventSeq = 0;
  await waitFor(async () => {
    const polled = await seedManager.pollEvents({
      run_id: spawned.run_id,
      after_seq: 0,
      limit: 10,
      wait_ms: 0,
    });
    const toolEvent = polled.events.find((event) => event.type === 'tool_finished');
    assert.ok(toolEvent);
    toolEventSeq = toolEvent.seq;
    const run = await seedManager.getRun({ run_id: spawned.run_id });
    assert.equal(run.status, 'completed');
  });
  await seedManager.shutdown(1000);

  const io = createIo({}, cwd);
  const exitCode = await runOrchestratorCli(
    ['artifacts', 'get', spawned.agent_name, '--cwd', cwd, String(toolEventSeq), '/stdout', '--output', 'json'],
    io,
    { createApp: () => createReadOnlyApp() },
  );
  assert.equal(exitCode, 0);

  const payload = readJson(io.stdoutText());
  assert.equal(payload.run_id, spawned.run_id);
  assert.equal(payload.field_path, '/stdout');
  assert.equal(payload.content, stdout);
});

test('foreground runs that stop for input are cancelled before the CLI exits', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-cli-input-required-'));
  const io = createIo({}, cwd);
  const manager = new RunManager([new InputRequiredAdapter()]);
  const storage = new Storage();

  const exitCode = await runOrchestratorCli(
    ['run', 'Needs approval.', '--output', 'json'],
    io,
    {
      createApp: () => ({
        manager,
        storage,
        shutdown: async (timeoutMs = 1000) => {
          await manager.shutdown(timeoutMs);
        },
      }),
      createDetachedClient: () => new FakeDetachedClient(),
    },
  );

  assert.equal(exitCode, 7);
  assert.match(io.stderrText(), /run was cancelled/i);

  const payload = readJson(io.stdoutText());
  assert.equal(payload.run.status, 'cancelled');

  const persisted = await storage.readRunRecordById(payload.run.run_id);
  assert.equal(persisted?.status, 'cancelled');
});

function createReadOnlyApp() {
  const manager = new RunManager([]);
  const storage = new Storage();
  return {
    manager,
    storage,
    shutdown: async (timeoutMs = 0) => {
      await manager.shutdown(timeoutMs);
    },
  };
}

function createIo(env, cwd, options = {}) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const hasStdinText = Object.prototype.hasOwnProperty.call(options, 'stdinText');
  const stdinText = options.stdinText ?? '';

  return {
    env,
    cwd,
    stdinIsTTY: !hasStdinText,
    async readStdin() {
      return stdinText;
    },
    stdout: {
      write(chunk) {
        stdoutChunks.push(String(chunk));
        return true;
      },
    },
    stderr: {
      write(chunk) {
        stderrChunks.push(String(chunk));
        return true;
      },
    },
    sleep: async () => {},
    stdoutText() {
      return stdoutChunks.join('');
    },
    stderrText() {
      return stderrChunks.join('');
    },
  };
}

function readJson(text) {
  return JSON.parse(text);
}

class CompletingAdapter {
  constructor(events) {
    this.backend = 'codex';
    this.events = events;
  }

  async spawn(params) {
    return new CompletingHandle(params.session.sessionId, this.events);
  }

  async cancel() {}
}

class CapturingAdapter {
  constructor(events) {
    this.backend = 'codex';
    this.events = events;
  }

  async spawn(params) {
    this.lastParams = params;
    return new CompletingHandle(params.session.sessionId, this.events);
  }

  async cancel() {}
}

class InputRequiredAdapter {
  constructor() {
    this.backend = 'codex';
  }

  async spawn(params) {
    return new InputRequiredHandle(params.session.sessionId);
  }

  async cancel(handle) {
    handle.abort();
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

class InputRequiredHandle {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.cancelled = false;
    this.result = null;
    this.eventStream = this.createStream();
  }

  createStream() {
    return (async function* (self) {
      yield {
        seq: 0,
        ts: new Date().toISOString(),
        run_id: '',
        session_id: self.sessionId,
        backend: 'codex',
        type: 'run_started',
        data: {},
      };
      yield {
        seq: 0,
        ts: new Date().toISOString(),
        run_id: '',
        session_id: self.sessionId,
        backend: 'codex',
        type: 'input_required',
        data: {
          text: 'approval required',
        },
      };
      while (!self.cancelled) {
        await sleep(5);
      }
    })(this);
  }

  async run() {
    while (!this.cancelled) {
      await sleep(5);
    }
  }

  getSummary() {
    return this.cancelled ? 'Cancelled after input required' : 'Waiting for input';
  }

  getResult() {
    return this.result;
  }

  abort() {
    this.cancelled = true;
  }
}

class FakeDetachedClient {
  constructor() {
    this.spawnInputs = [];
    this.continueInputs = [];
    this.cancelInputs = [];
  }

  async daemonStart() {
    return this.#status(true);
  }

  async daemonStatus() {
    return this.#status(false);
  }

  async daemonStop() {
    return {
      stopped: true,
      previously_running: true,
    };
  }

  async spawnRun(input) {
    this.spawnInputs.push(input);
    return {
      run_id: 'detached-run-1',
      backend: input.backend,
      role: input.role,
      session_id: input.session_id ?? 'session-detached-1',
      agent_name: input.nickname ?? 'worker1',
      status: 'queued',
    };
  }

  async continueRun(input) {
    this.continueInputs.push(input);
    return {
      run_id: 'detached-run-2',
      status: 'queued',
      session_id: 'session-detached-1',
      agent_name: 'worker1',
      mode: 'resume',
      resumed_from_run_id: input.run_id ?? null,
    };
  }

  async cancelRun(input) {
    this.cancelInputs.push(input);
    return {
      run_id: input.run_id ?? 'detached-run-1',
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
    };
  }

  #status(created) {
    return {
      status: 'running',
      daemon: {
        pid: 1234,
        started_at: '2026-03-19T00:00:00.000Z',
        socket_path: '/tmp/control.sock',
      },
      ...(created ? { created: true } : {}),
    };
  }
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

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
