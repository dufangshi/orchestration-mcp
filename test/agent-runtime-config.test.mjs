import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';

import { buildClaudeOptions } from '../dist/adapters/claude.js';
import { buildCodexThreadOptions } from '../dist/adapters/codex.js';

const originalEnv = {
  ORCHESTRATOR_ENV_FILE: process.env.ORCHESTRATOR_ENV_FILE,
  ORCHESTRATOR_CODEX_SANDBOX_MODE: process.env.ORCHESTRATOR_CODEX_SANDBOX_MODE,
  ORCHESTRATOR_CODEX_APPROVAL_POLICY: process.env.ORCHESTRATOR_CODEX_APPROVAL_POLICY,
  ORCHESTRATOR_CODEX_NETWORK_ACCESS_ENABLED: process.env.ORCHESTRATOR_CODEX_NETWORK_ACCESS_ENABLED,
  ORCHESTRATOR_CLAUDE_PERMISSION_MODE: process.env.ORCHESTRATOR_CLAUDE_PERMISSION_MODE,
  ORCHESTRATOR_CLAUDE_ALLOW_DANGEROUSLY_SKIP_PERMISSIONS:
    process.env.ORCHESTRATOR_CLAUDE_ALLOW_DANGEROUSLY_SKIP_PERMISSIONS,
};

test.afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test('Codex runtime defaults to danger-full-access', () => {
  process.env.ORCHESTRATOR_ENV_FILE = path.join(os.tmpdir(), 'orchestrator-missing.env');
  delete process.env.ORCHESTRATOR_CODEX_SANDBOX_MODE;
  delete process.env.ORCHESTRATOR_CODEX_APPROVAL_POLICY;
  delete process.env.ORCHESTRATOR_CODEX_NETWORK_ACCESS_ENABLED;

  const options = buildCodexThreadOptions(buildAdapterParams());
  assert.equal(options.sandboxMode, 'danger-full-access');
  assert.equal(options.approvalPolicy, 'never');
  assert.equal(options.networkAccessEnabled, true);
});

test('local .env overrides Codex and Claude runtime permissions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-env-'));
  const envFile = path.join(dir, '.env');
  await writeFile(
    envFile,
    [
      'ORCHESTRATOR_CODEX_SANDBOX_MODE=workspace-write',
      'ORCHESTRATOR_CODEX_APPROVAL_POLICY=on-request',
      'ORCHESTRATOR_CODEX_NETWORK_ACCESS_ENABLED=false',
      'ORCHESTRATOR_CLAUDE_PERMISSION_MODE=acceptEdits',
      'ORCHESTRATOR_CLAUDE_ALLOW_DANGEROUSLY_SKIP_PERMISSIONS=false',
    ].join('\n'),
    'utf8',
  );

  process.env.ORCHESTRATOR_ENV_FILE = envFile;
  delete process.env.ORCHESTRATOR_CODEX_SANDBOX_MODE;
  delete process.env.ORCHESTRATOR_CODEX_APPROVAL_POLICY;
  delete process.env.ORCHESTRATOR_CODEX_NETWORK_ACCESS_ENABLED;
  delete process.env.ORCHESTRATOR_CLAUDE_PERMISSION_MODE;
  delete process.env.ORCHESTRATOR_CLAUDE_ALLOW_DANGEROUSLY_SKIP_PERMISSIONS;

  const codexOptions = buildCodexThreadOptions(buildAdapterParams());
  assert.equal(codexOptions.sandboxMode, 'workspace-write');
  assert.equal(codexOptions.approvalPolicy, 'on-request');
  assert.equal(codexOptions.networkAccessEnabled, false);

  const claudeOptions = buildClaudeOptions(buildAdapterParams());
  assert.equal(claudeOptions.permissionMode, 'acceptEdits');
  assert.equal(claudeOptions.allowDangerouslySkipPermissions, false);
});

function buildAdapterParams() {
  return {
    runId: 'run-1',
    role: 'worker',
    prompt: 'Implement feature',
    cwd: '/tmp/project',
    profile: undefined,
    outputSchema: undefined,
    metadata: {},
    backendConfig: {},
    sessionMode: 'new',
    systemPrompt: undefined,
    inputMessage: {
      role: 'user',
      parts: [{ type: 'text', text: 'Implement feature' }],
    },
    session: {
      sessionId: 'session-1',
      backend: 'codex',
      cwd: '/tmp/project',
      agentName: 'agent1',
      backendSessionId: null,
      remoteRef: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    },
  };
}
