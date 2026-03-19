import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPeerEnvironment, getPeerIdentity } from '../dist/core/peer-env.js';

test('getPeerIdentity prefers the session agent name', () => {
  const params = createParams({
    sessionId: 'session-1',
    agentName: 'worker1',
    cwd: '/tmp/project',
  });

  assert.deepEqual(getPeerIdentity(params), {
    agentName: 'worker1',
    sessionId: 'session-1',
    cwd: '/tmp/project',
  });
});

test('getPeerIdentity falls back to a derived agent name', () => {
  const params = createParams({
    sessionId: '1234567890abcdef',
    agentName: undefined,
    cwd: '/tmp/project',
  });

  assert.deepEqual(getPeerIdentity(params), {
    agentName: 'agent-12345678',
    sessionId: '1234567890abcdef',
    cwd: '/tmp/project',
  });
});

test('buildPeerEnvironment injects PEER variables and prepends cwd to PATH', () => {
  const params = createParams({
    sessionId: 'session-2',
    agentName: 'reviewer1',
    cwd: '/tmp/peer-project',
  });

  const env = buildPeerEnvironment(params);
  assert.equal(env.PEER_NAME, 'reviewer1');
  assert.equal(env.PEER_SESSION_ID, 'session-2');
  assert.equal(env.PEER_CWD, '/tmp/peer-project');
  assert.equal(env.PATH.split(':')[0], '/tmp/peer-project');
});

function createParams({ sessionId, agentName, cwd }) {
  return {
    runId: 'run-1',
    role: 'worker',
    prompt: 'hello',
    cwd,
    sessionMode: 'new',
    session: {
      sessionId,
      backend: 'codex',
      cwd,
      agentName,
      backendSessionId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    },
    metadata: {},
    backendConfig: {},
  };
}
