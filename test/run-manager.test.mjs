import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';

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

test('spawnRun loads profile content and passes it to adapters as systemPrompt', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-profile-'));
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-profile-file-'));
  const profilePath = path.join(profileDir, 'reviewer.md');
  await writeFile(profilePath, '# Reviewer\nAlways review only the latest diff.\n');

  const adapter = new CapturingAdapter();
  const manager = new RunManager([adapter]);

  const spawned = await manager.spawnRun({
    backend: 'codex',
    role: 'reviewer',
    prompt: 'Review the latest diff',
    cwd,
    session_mode: 'new',
    profile: profilePath,
  });

  await waitFor(async () => {
    const run = await manager.getRun({ run_id: spawned.run_id });
    assert.equal(run.status, 'completed');
  });

  assert.equal(adapter.lastParams?.profile, profilePath);
  assert.match(adapter.lastParams?.systemPrompt ?? '', /Profile source:/);
  assert.match(adapter.lastParams?.systemPrompt ?? '', /Always review only the latest diff\./);
});

test('spawnRun assigns explicit nicknames and preserves them across resume runs', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-agent-name-explicit-'));
  const adapter = new SessionQueueAdapter();
  const manager = new RunManager([adapter]);

  const first = await manager.spawnRun({
    backend: 'codex',
    role: 'worker',
    nickname: 'worker1',
    prompt: 'first',
    cwd,
    session_mode: 'new',
  });

  assert.equal(first.agent_name, 'worker1');

  await waitFor(async () => {
    const run = await manager.getRun({ run_id: first.run_id });
    assert.equal(run.status, 'running');
    assert.equal(run.agent_name, 'worker1');
  });

  const second = await manager.spawnRun({
    backend: 'codex',
    role: 'worker',
    prompt: 'resume',
    cwd,
    session_mode: 'resume',
    session_id: first.session_id,
  });

  assert.equal(second.agent_name, 'worker1');

  await assert.rejects(
    manager.spawnRun({
      backend: 'codex',
      role: 'worker',
      nickname: 'worker2',
      prompt: 'rename attempt',
      cwd,
      session_mode: 'resume',
      session_id: first.session_id,
    }),
    /already named worker1, not worker2/,
  );

  await manager.cancelRun({ run_id: second.run_id });
  await manager.shutdown(1000);
});

test('spawnRun auto-generates unique agent names for new sessions', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-agent-name-default-'));
  const manager = new RunManager([new HangingAdapter()]);

  const first = await manager.spawnRun({
    backend: 'codex',
    role: 'worker',
    prompt: 'first',
    cwd,
    session_mode: 'new',
  });
  const second = await manager.spawnRun({
    backend: 'codex',
    role: 'reviewer',
    prompt: 'second',
    cwd,
    session_mode: 'new',
  });

  assert.equal(first.agent_name, 'agent1');
  assert.equal(second.agent_name, 'agent2');

  const firstRun = await manager.getRun({ run_id: first.run_id });
  const secondRun = await manager.getRun({ run_id: second.run_id });
  assert.equal(firstRun.agent_name, 'agent1');
  assert.equal(secondRun.agent_name, 'agent2');

  const listed = await manager.listRuns({ cwd });
  assert.equal(listed.runs.some((run) => run.agent_name === 'agent1'), true);
  assert.equal(listed.runs.some((run) => run.agent_name === 'agent2'), true);

  await manager.shutdown(1000);
});

test('spawnRun rejects duplicate nicknames for new sessions', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-agent-name-duplicate-'));
  const manager = new RunManager([new HangingAdapter()]);

  const first = await manager.spawnRun({
    backend: 'codex',
    role: 'worker',
    nickname: 'reviewer1',
    prompt: 'first',
    cwd,
    session_mode: 'new',
  });

  assert.equal(first.agent_name, 'reviewer1');

  await assert.rejects(
    manager.spawnRun({
      backend: 'codex',
      role: 'worker',
      nickname: 'reviewer1',
      prompt: 'second',
      cwd,
      session_mode: 'new',
    }),
    /already in use: reviewer1/,
  );

  await manager.shutdown(1000);
});

test('RunManager sends and fetches session inbox messages by agent_name', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-agent-message-'));
  const manager = new RunManager([new HangingAdapter()]);

  await manager.spawnRun({
    backend: 'codex',
    role: 'worker',
    nickname: 'worker1',
    prompt: 'worker',
    cwd,
    session_mode: 'new',
  });
  const reviewer = await manager.spawnRun({
    backend: 'codex',
    role: 'reviewer',
    nickname: 'reviewer1',
    prompt: 'reviewer',
    cwd,
    session_mode: 'new',
  });

  const sent = await manager.sendAgentMessage({
    cwd,
    from_agent_name: 'worker1',
    to_agent_name: 'reviewer1',
    message: {
      role: 'user',
      parts: [{ type: 'text', text: 'Please review the latest revision.' }],
    },
    metadata: { revision: 3 },
  });

  assert.equal(sent.to_agent_name, 'reviewer1');
  assert.equal(sent.seq, 1);

  const firstFetch = await manager.fetchAgentMessages({
    cwd,
    agent_name: 'reviewer1',
    after_seq: 0,
    limit: 10,
  });
  assert.equal(firstFetch.session_id, reviewer.session_id);
  assert.equal(firstFetch.messages.length, 1);
  assert.equal(firstFetch.messages[0].from_agent_name, 'worker1');
  assert.equal(firstFetch.messages[0].metadata.revision, 3);
  assert.equal(firstFetch.next_after_seq, 1);

  await manager.sendAgentMessage({
    cwd,
    to_agent_name: 'reviewer1',
    message: {
      role: 'system',
      parts: [{ type: 'text', text: 'A final review is required before completion.' }],
    },
  });

  const secondFetch = await manager.fetchAgentMessages({
    cwd,
    agent_name: 'reviewer1',
    after_seq: firstFetch.next_after_seq,
    limit: 10,
  });
  assert.equal(secondFetch.messages.length, 1);
  assert.equal(secondFetch.messages[0].seq, 2);
  assert.equal(secondFetch.messages[0].from_agent_name, null);
  assert.equal(secondFetch.next_after_seq, 2);

  await assert.rejects(
    manager.sendAgentMessage({
      cwd,
      to_agent_name: 'missing-agent',
      message: {
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    }),
    /Unknown agent_name/,
  );

  await manager.shutdown(1000);
});

test('continueRun resumes a failed Codex session with a new run', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-continue-failed-'));
  const manager = new RunManager([new RecoverableFailureAdapter()]);

  const first = await manager.spawnRun({
    backend: 'codex',
    role: 'worker',
    nickname: 'worker1',
    prompt: 'first attempt',
    cwd,
    session_mode: 'new',
  });

  await waitFor(async () => {
    const run = await manager.getRun({ run_id: first.run_id });
    assert.equal(run.status, 'failed');
    assert.match(run.summary, /stream disconnected \/ network error/);
  });

  const resumed = await manager.continueRun({
    run_id: first.run_id,
    input_message: {
      role: 'user',
      parts: [{ type: 'text', text: 'Please continue from where you left off.' }],
    },
  });

  assert.equal(resumed.mode, 'resume');
  assert.equal(resumed.resumed_from_run_id, first.run_id);
  assert.equal(resumed.session_id, first.session_id);
  assert.equal(resumed.agent_name, 'worker1');
  assert.notEqual(resumed.run_id, first.run_id);

  await waitFor(async () => {
    const run = await manager.getRun({ run_id: resumed.run_id });
    assert.equal(run.status, 'completed');
    assert.equal(run.agent_name, 'worker1');
  });

  const completed = await manager.getRun({ run_id: resumed.run_id });
  assert.equal(completed.session_id, first.session_id);

  await manager.shutdown(1000);
});

test('listAgents returns stable agent directory entries', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-agent-directory-'));
  const adapter = new SessionQueueAdapter();
  const manager = new RunManager([adapter]);

  const worker = await manager.spawnRun({
    backend: 'codex',
    role: 'worker',
    nickname: 'worker1',
    prompt: 'worker',
    cwd,
    session_mode: 'new',
  });
  const reviewer = await manager.spawnRun({
    backend: 'codex',
    role: 'reviewer',
    prompt: 'reviewer',
    cwd,
    session_mode: 'new',
  });

  await waitFor(async () => {
    const workerRun = await manager.getRun({ run_id: worker.run_id });
    const reviewerRun = await manager.getRun({ run_id: reviewer.run_id });
    assert.equal(workerRun.status, 'running');
    assert.equal(reviewerRun.status, 'running');
  });

  const listed = await manager.listAgents({ cwd });
  assert.equal(listed.agents.length, 2);
  assert.deepEqual(
    listed.agents.map((agent) => agent.agent_name).sort(),
    [reviewer.agent_name, worker.agent_name].sort(),
  );

  const workerEntry = listed.agents.find((agent) => agent.agent_name === 'worker1');
  assert.equal(workerEntry?.role, 'worker');
  assert.equal(workerEntry?.status, 'running');
  assert.equal(workerEntry?.last_run_id, worker.run_id);
  assert.equal(workerEntry?.cwd, cwd);

  const reviewerEntry = listed.agents.find((agent) => agent.agent_name === reviewer.agent_name);
  assert.equal(reviewerEntry?.role, 'reviewer');
  assert.equal(reviewerEntry?.status, 'running');

  adapter.handles[0].complete();
  adapter.handles[1].complete();
  await manager.shutdown(1000);
});

test('resume runs on the same session are queued until the active run finishes', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-session-queue-'));
  const adapter = new SessionQueueAdapter();
  const manager = new RunManager([adapter]);

  const first = await manager.spawnRun({
    backend: 'codex',
    role: 'worker',
    prompt: 'first',
    cwd,
    session_mode: 'new',
  });

  await waitFor(async () => {
    const run = await manager.getRun({ run_id: first.run_id });
    assert.equal(run.status, 'running');
    assert.equal(run.last_seq, 1);
  });

  const second = await manager.spawnRun({
    backend: 'codex',
    role: 'worker',
    prompt: 'second',
    cwd,
    session_mode: 'resume',
    session_id: first.session_id,
  });

  assert.equal(second.status, 'queued');
  assert.deepEqual(adapter.spawnedRunIds, [first.run_id]);

  const queuedRun = await manager.getRun({ run_id: second.run_id });
  assert.equal(queuedRun.status, 'queued');
  assert.equal(queuedRun.summary, 'Run queued behind active session run');

  const queuedPoll = await manager.pollEvents({
    run_id: second.run_id,
    after_seq: 0,
    limit: 10,
    wait_ms: 10,
  });
  assert.equal(queuedPoll.status, 'queued');
  assert.equal(queuedPoll.events.length, 0);

  adapter.handles[0].complete();

  await waitFor(async () => {
    const run = await manager.getRun({ run_id: first.run_id });
    assert.equal(run.status, 'completed');
  });

  await waitFor(() => {
    assert.deepEqual(adapter.spawnedRunIds, [first.run_id, second.run_id]);
  });

  await waitFor(async () => {
    const run = await manager.getRun({ run_id: second.run_id });
    assert.equal(run.status, 'running');
    assert.equal(run.last_seq, 1);
  });

  adapter.handles[1].complete();

  await waitFor(async () => {
    const run = await manager.getRun({ run_id: second.run_id });
    assert.equal(run.status, 'completed');
  });
});

test('cancelRun removes queued session resumes before they start', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-session-cancel-'));
  const adapter = new SessionQueueAdapter();
  const manager = new RunManager([adapter]);

  const first = await manager.spawnRun({
    backend: 'codex',
    role: 'worker',
    prompt: 'first',
    cwd,
    session_mode: 'new',
  });

  await waitFor(async () => {
    const run = await manager.getRun({ run_id: first.run_id });
    assert.equal(run.status, 'running');
  });

  const second = await manager.spawnRun({
    backend: 'codex',
    role: 'worker',
    prompt: 'second',
    cwd,
    session_mode: 'resume',
    session_id: first.session_id,
  });

  const cancelled = await manager.cancelRun({ run_id: second.run_id });
  assert.equal(cancelled.status, 'cancelled');

  const cancelledRun = await manager.getRun({ run_id: second.run_id });
  assert.equal(cancelledRun.status, 'cancelled');
  assert.equal(cancelledRun.last_seq, 1);

  adapter.handles[0].complete();

  await waitFor(async () => {
    const run = await manager.getRun({ run_id: first.run_id });
    assert.equal(run.status, 'completed');
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(adapter.spawnedRunIds, [first.run_id]);
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
  await waitFor(async () => {
    const historicalRun = await historicalManager.getRun({ run_id: spawned.run_id });
    assert.equal(historicalRun.status, 'completed');
    assert.equal(historicalRun.cwd, cwd);
  });

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

class CapturingAdapter {
  backend = 'codex';

  async spawn(params) {
    this.lastParams = params;
    return new CompletingHandle(params.session.sessionId, [
      {
        type: 'run_completed',
        data: {
          final_response: 'done',
        },
      },
    ]);
  }

  async cancel() {}
}

class SessionQueueAdapter {
  backend = 'codex';

  constructor() {
    this.handles = [];
    this.spawnedRunIds = [];
  }

  async spawn(params) {
    const handle = new SessionQueueHandle(
      params.session.sessionId,
      params.session.backendSessionId ?? `thread-${params.session.sessionId}`,
    );
    this.handles.push(handle);
    this.spawnedRunIds.push(params.runId);
    return handle;
  }

  async cancel(handle) {
    handle.abort();
  }
}

class RecoverableFailureAdapter {
  backend = 'codex';

  async spawn(params) {
    if (params.sessionMode === 'resume') {
      return new RecoverableResumeHandle(
        params.session.sessionId,
        params.session.backendSessionId ?? 'thread-recovered',
        params.inputMessage,
      );
    }
    return new RecoverableFailureHandle(params.session.sessionId, 'thread-recoverable');
  }

  async cancel(handle) {
    handle.abort();
  }
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

class SessionQueueHandle {
  constructor(sessionId, threadId) {
    this.sessionId = sessionId;
    this.threadId = threadId;
    this.result = {
      finalResponse: 'done',
    };
    this.completed = false;
    this.aborted = false;
    this.eventStream = (async function* (self) {
      yield {
        seq: 0,
        ts: new Date().toISOString(),
        run_id: '',
        session_id: sessionId,
        backend: 'codex',
        type: 'run_started',
        data: {
          thread_id: self.threadId,
        },
      };
      while (!self.completed && !self.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!self.aborted) {
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
      }
    })(this);
  }

  async run() {
    while (!this.completed && !this.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  getSummary() {
    return this.completed ? 'Completed run' : 'Queued session run';
  }

  getResult() {
    return this.completed ? this.result : null;
  }

  complete() {
    this.completed = true;
  }

  abort() {
    this.aborted = true;
  }
}

class RecoverableFailureHandle {
  constructor(sessionId, threadId) {
    this.sessionId = sessionId;
    this.threadId = threadId;
    this.result = null;
    this.eventStream = (async function* () {
      yield {
        seq: 0,
        ts: new Date().toISOString(),
        run_id: '',
        session_id: sessionId,
        backend: 'codex',
        type: 'run_started',
        data: {
          thread_id: threadId,
        },
      };
    })();
  }

  async run() {
    throw new Error('stream disconnected / network error');
  }

  getSummary() {
    return 'Run failed: stream disconnected / network error';
  }

  getResult() {
    return this.result;
  }

  abort() {}
}

class RecoverableResumeHandle {
  constructor(sessionId, threadId, inputMessage) {
    this.sessionId = sessionId;
    this.threadId = threadId;
    this.finalResponse = inputMessage.parts.find((part) => part.type === 'text')?.text ?? 'continued';
    this.result = {
      finalResponse: this.finalResponse,
    };
    this.eventStream = (async function* () {
      yield {
        seq: 0,
        ts: new Date().toISOString(),
        run_id: '',
        session_id: sessionId,
        backend: 'codex',
        type: 'run_started',
        data: {
          thread_id: threadId,
        },
      };
      yield {
        seq: 0,
        ts: new Date().toISOString(),
        run_id: '',
        session_id: sessionId,
        backend: 'codex',
        type: 'run_completed',
        data: {
          final_response: this.finalResponse,
        },
      };
    }).call(this);
  }

  async run() {}

  getSummary() {
    return 'Run completed after resume';
  }

  getResult() {
    return this.result;
  }

  abort() {}
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
