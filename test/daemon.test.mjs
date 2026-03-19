import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { DetachedOrchestratorClient } from '../dist/app/orchestrator-client.js';
import { tailRunEvents, waitForRun } from '../dist/app/orchestrator-service.js';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('daemon supervisor owns detached runs across start/status/continue/cancel/stop flows', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-daemon-home-'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-daemon-cwd-'));
  const factoryPath = await writeFactoryModule();
  const previousHome = process.env.NANOBOT_ORCHESTRATOR_HOME;
  const previousFactory = process.env.NANOBOT_DAEMON_FACTORY_MODULE;

  process.env.NANOBOT_ORCHESTRATOR_HOME = homeDir;
  process.env.NANOBOT_DAEMON_FACTORY_MODULE = factoryPath;

  const client = new DetachedOrchestratorClient();

  try {
    const started = await client.daemonStart();
    assert.equal(started.status, 'running');
    assert.equal(started.created, true);
    assert.match(started.daemon?.socket_path ?? '', /control\.sock$/);

    const existing = await client.daemonStart();
    assert.equal(existing.status, 'running');
    assert.equal(existing.created, false);

    const status = await client.daemonStatus();
    assert.equal(status.status, 'running');
    assert.equal(status.daemon?.pid > 0, true);

    const first = await client.spawnRun({
      backend: 'codex',
      role: 'worker',
      prompt: 'first',
      cwd,
      session_mode: 'new',
    });

    const paused = await waitForRun(client, first.run_id, {
      timeout_ms: 3_000,
      wait_ms: 50,
    });
    assert.equal(paused.timed_out, false);
    assert.equal(paused.run.status, 'input_required');
    assert.deepEqual(
      paused.events.map((event) => event.type),
      ['run_started', 'input_required'],
    );

    await client.continueRun({
      run_id: first.run_id,
      input_message: {
        role: 'user',
        parts: [{ type: 'text', text: 'approved' }],
      },
    });

    const completed = await waitForRun(client, first.run_id, {
      after_seq: paused.next_after_seq,
      timeout_ms: 3_000,
      wait_ms: 50,
      stop_on_input_required: false,
      stop_on_auth_required: false,
    });
    assert.equal(completed.timed_out, false);
    assert.equal(completed.run.status, 'completed');

    const historicalTail = [];
    for await (const event of tailRunEvents(client, first.run_id, { after_seq: 0, wait_ms: 0 })) {
      historicalTail.push(event.type);
    }
    assert.deepEqual(
      historicalTail,
      ['run_started', 'input_required', 'status_changed', 'run_completed'],
    );

    const second = await client.spawnRun({
      backend: 'codex',
      role: 'worker',
      prompt: 'second',
      cwd,
      session_mode: 'new',
    });

    const secondPaused = await waitForRun(client, second.run_id, {
      timeout_ms: 3_000,
      wait_ms: 50,
    });
    assert.equal(secondPaused.run.status, 'input_required');

    const cancelled = await client.cancelRun({ run_id: second.run_id });
    assert.equal(cancelled.status, 'cancelled');

    const listed = await client.listRuns({ cwd });
    assert.equal(listed.runs.length, 2);
    assert.equal(listed.runs.some((run) => run.run_id === first.run_id && run.status === 'completed'), true);
    assert.equal(listed.runs.some((run) => run.run_id === second.run_id && run.status === 'cancelled'), true);

    const stopped = await client.daemonStop();
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.previously_running, true);

    const finalStatus = await client.daemonStatus();
    assert.equal(finalStatus.status, 'stopped');
  } finally {
    try {
      await client.daemonStop();
    } catch {
      // Best-effort cleanup for failed assertions.
    }

    if (previousHome === undefined) {
      delete process.env.NANOBOT_ORCHESTRATOR_HOME;
    } else {
      process.env.NANOBOT_ORCHESTRATOR_HOME = previousHome;
    }

    if (previousFactory === undefined) {
      delete process.env.NANOBOT_DAEMON_FACTORY_MODULE;
    } else {
      process.env.NANOBOT_DAEMON_FACTORY_MODULE = previousFactory;
    }
  }
});

async function writeFactoryModule() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-daemon-factory-'));
  const filePath = path.join(dir, 'factory.mjs');
  const runManagerUrl = pathToFileURL(path.join(repoRoot, 'dist/core/run-manager.js')).href;
  const serviceUrl = pathToFileURL(path.join(repoRoot, 'dist/app/orchestrator-service.js')).href;

  await writeFile(
    filePath,
    `
import { RunManager } from ${JSON.stringify(runManagerUrl)};
import { RunManagerService } from ${JSON.stringify(serviceUrl)};

export function createDaemonService() {
  return new RunManagerService(new RunManager([new ContinueAdapter()]));
}

class ContinueAdapter {
  constructor() {
    this.backend = 'codex';
  }

  async spawn(params) {
    return new ContinueHandle(params.session.sessionId);
  }

  async cancel(handle) {
    handle.abort();
  }

  async continue(handle, input) {
    handle.continue(input);
  }
}

class ContinueHandle {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.completed = false;
    this.cancelled = false;
    this.finalResponse = null;
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
      while (!self.completed && !self.cancelled) {
        await sleep(5);
      }
      if (self.completed) {
        yield {
          seq: 0,
          ts: new Date().toISOString(),
          run_id: '',
          session_id: self.sessionId,
          backend: 'codex',
          type: 'run_completed',
          data: {
            final_response: self.finalResponse,
          },
        };
      }
    })(this);
  }

  async run() {
    while (!this.completed && !this.cancelled) {
      await sleep(5);
    }
  }

  continue(input) {
    this.finalResponse = input.parts.find((part) => part.type === 'text')?.text ?? 'continued';
    this.completed = true;
  }

  abort() {
    this.cancelled = true;
  }

  getSummary() {
    if (this.cancelled) {
      return 'Cancelled run';
    }
    if (this.completed) {
      return 'Completed after continue';
    }
    return 'Waiting for continue';
  }

  getResult() {
    if (!this.completed) {
      return null;
    }
    return {
      finalResponse: this.finalResponse,
    };
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
`,
    'utf8',
  );

  return filePath;
}
