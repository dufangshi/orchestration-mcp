import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, stat } from 'node:fs/promises';

import { runPeerCli } from '../dist/cli/peer.js';
import { RunManager } from '../dist/core/run-manager.js';

test('peer whoami resolves current identity from PEER env', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'peer-cli-whoami-'));
  const manager = new RunManager([new IdleAdapter()]);

  const worker = await manager.spawnRun({
    backend: 'codex',
    role: 'worker',
    nickname: 'worker1',
    prompt: 'worker',
    cwd,
    session_mode: 'new',
  });

  const io = createIo({
    PEER_NAME: 'worker1',
    PEER_CWD: cwd,
  }, cwd);
  const exitCode = await runPeerCli(['whoami', '--json'], io);
  assert.equal(exitCode, 0);

  const payload = readJson(io.stdoutText());
  assert.equal(payload.agent_name, 'worker1');
  assert.equal(payload.session_id, worker.session_id);
  assert.equal(payload.cwd, cwd);
  assert.equal(payload.role, 'worker');

  await manager.shutdown(1000);
});

test('peer list returns the persisted agent directory', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'peer-cli-list-'));
  const manager = new RunManager([new IdleAdapter()]);

  await manager.spawnRun({
    backend: 'codex',
    role: 'worker',
    nickname: 'worker1',
    prompt: 'worker',
    cwd,
    session_mode: 'new',
  });
  await manager.spawnRun({
    backend: 'codex',
    role: 'reviewer',
    nickname: 'reviewer1',
    prompt: 'reviewer',
    cwd,
    session_mode: 'new',
  });

  const io = createIo({}, cwd);
  const exitCode = await runPeerCli(['list', '--cwd', cwd, '--json'], io);
  assert.equal(exitCode, 0);

  const payload = readJson(io.stdoutText());
  assert.deepEqual(
    payload.agents.map((agent) => agent.agent_name).sort(),
    ['reviewer1', 'worker1'],
  );

  await manager.shutdown(1000);
});

test('peer send delivers messages and peer inbox reads them without mutating the cursor', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'peer-cli-inbox-'));
  const manager = new RunManager([new IdleAdapter()]);

  await manager.spawnRun({
    backend: 'codex',
    role: 'worker',
    nickname: 'worker1',
    prompt: 'worker',
    cwd,
    session_mode: 'new',
  });
  await manager.spawnRun({
    backend: 'codex',
    role: 'reviewer',
    nickname: 'reviewer1',
    prompt: 'reviewer',
    cwd,
    session_mode: 'new',
  });

  const sendIo = createIo({
    PEER_NAME: 'worker1',
    PEER_CWD: cwd,
  }, cwd);
  const sendExitCode = await runPeerCli(['send', 'reviewer1', 'Please review checkpoint 3.', '--json'], sendIo);
  assert.equal(sendExitCode, 0);

  const sent = readJson(sendIo.stdoutText());
  assert.equal(sent.to_agent_name, 'reviewer1');
  assert.equal(sent.seq, 1);

  const inboxIo = createIo({
    PEER_NAME: 'reviewer1',
    PEER_CWD: cwd,
  }, cwd);
  const inboxExitCode = await runPeerCli(['inbox', '--json'], inboxIo);
  assert.equal(inboxExitCode, 0);

  const inbox = readJson(inboxIo.stdoutText());
  assert.equal(inbox.agent_name, 'reviewer1');
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].from_agent_name, 'worker1');
  assert.equal(inbox.messages[0].body.parts[0].text, 'Please review checkpoint 3.');

  const cursorPath = path.join(cwd, '.nanobot-orchestrator', 'agents', 'reviewer1.cursor');
  await assert.rejects(stat(cursorPath), /ENOENT/);

  await manager.shutdown(1000);
});

test('peer wait returns new messages, advances its cursor, and preserves the cursor on timeout', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'peer-cli-wait-'));
  const manager = new RunManager([new IdleAdapter()]);

  await manager.spawnRun({
    backend: 'codex',
    role: 'worker',
    nickname: 'worker1',
    prompt: 'worker',
    cwd,
    session_mode: 'new',
  });
  await manager.spawnRun({
    backend: 'codex',
    role: 'reviewer',
    nickname: 'reviewer1',
    prompt: 'reviewer',
    cwd,
    session_mode: 'new',
  });

  const cursorPath = path.join(cwd, '.nanobot-orchestrator', 'agents', 'reviewer1.cursor');
  const reviewerEnv = {
    PEER_NAME: 'reviewer1',
    PEER_CWD: cwd,
  };

  const sendFirstIo = createIo({
    PEER_NAME: 'worker1',
    PEER_CWD: cwd,
  }, cwd);
  await runPeerCli(['send', 'reviewer1', 'First review request.'], sendFirstIo);

  const waitFirstIo = createIo(reviewerEnv, cwd);
  const firstExitCode = await runPeerCli(['wait', '--json', '--timeout', '0'], waitFirstIo);
  assert.equal(firstExitCode, 0);
  const firstPayload = readJson(waitFirstIo.stdoutText());
  assert.equal(firstPayload.messages.length, 1);
  assert.equal(firstPayload.next_after_seq, 1);
  assert.equal((await readFile(cursorPath, 'utf8')).trim(), '1');

  const waitTimeoutIo = createIo(reviewerEnv, cwd);
  const timeoutExitCode = await runPeerCli(['wait', '--json', '--timeout', '0'], waitTimeoutIo);
  assert.equal(timeoutExitCode, 0);
  const timeoutPayload = readJson(waitTimeoutIo.stdoutText());
  assert.deepEqual(timeoutPayload.messages, []);
  assert.equal(timeoutPayload.next_after_seq, 1);
  assert.equal((await readFile(cursorPath, 'utf8')).trim(), '1');

  const sendSecondIo = createIo({
    PEER_NAME: 'worker1',
    PEER_CWD: cwd,
  }, cwd);
  await runPeerCli(['send', 'reviewer1', 'Second review request.'], sendSecondIo);

  const waitSecondIo = createIo(reviewerEnv, cwd);
  const secondExitCode = await runPeerCli(['wait', '--json', '--timeout', '0'], waitSecondIo);
  assert.equal(secondExitCode, 0);
  const secondPayload = readJson(waitSecondIo.stdoutText());
  assert.equal(secondPayload.messages.length, 1);
  assert.equal(secondPayload.messages[0].seq, 2);
  assert.equal(secondPayload.next_after_seq, 2);
  assert.equal((await readFile(cursorPath, 'utf8')).trim(), '2');

  await manager.shutdown(1000);
});

test('peer commands fail clearly when the current identity is unknown', async () => {
  const io = createIo({}, process.cwd());
  const exitCode = await runPeerCli(['whoami'], io);
  assert.equal(exitCode, 1);
  assert.match(io.stderrText(), /Current agent identity is unknown/);
});

function createIo(env, cwd) {
  const stdoutChunks = [];
  const stderrChunks = [];

  return {
    env,
    cwd,
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

class IdleAdapter {
  backend = 'codex';

  async spawn(params) {
    return new IdleRunHandle(params);
  }

  async cancel(handle) {
    handle.abort();
  }

  async continue() {
    return {
      continued: false,
      status: 'rejected',
      errorMessage: 'continue is not supported in IdleAdapter',
    };
  }
}

class IdleRunHandle {
  constructor(params) {
    this.sessionId = params.session.sessionId;
    this.eventStream = emptyStream();
    this.runPromise = new Promise((resolve) => {
      this.resolveRun = resolve;
    });
  }

  async run() {
    return this.runPromise;
  }

  getSummary() {
    return 'Idle';
  }

  getResult() {
    return null;
  }

  abort() {
    this.resolveRun();
  }
}

function emptyStream() {
  return (async function* () {})();
}
