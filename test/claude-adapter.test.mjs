import test from 'node:test';
import assert from 'node:assert/strict';

import { buildClaudeOptions, ClaudeCodeAdapter } from '../dist/adapters/claude.js';

test('buildClaudeOptions uses orchestration session ids for new and resume modes', () => {
  const baseParams = {
    runId: 'run-1',
    role: 'worker',
    prompt: 'Implement feature',
    cwd: '/tmp/project',
    profile: undefined,
    outputSchema: undefined,
    metadata: {},
  };

  const newOptions = buildClaudeOptions({
    ...baseParams,
    sessionMode: 'new',
    systemPrompt: 'Review only the latest diff.',
    session: {
      sessionId: 'session-1',
      backend: 'claude_code',
      cwd: '/tmp/project',
      backendSessionId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    },
  });
  assert.equal(newOptions.sessionId, 'session-1');
  assert.equal(newOptions.resume, undefined);
  assert.equal(newOptions.permissionMode, 'bypassPermissions');
  assert.deepEqual(newOptions.systemPrompt, {
    type: 'preset',
    preset: 'claude_code',
    append: 'Review only the latest diff.',
  });

  const resumeOptions = buildClaudeOptions({
    ...baseParams,
    sessionMode: 'resume',
    systemPrompt: undefined,
    session: {
      sessionId: 'session-1',
      backend: 'claude_code',
      cwd: '/tmp/project',
      backendSessionId: 'backend-session-9',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    },
  });
  assert.equal(resumeOptions.sessionId, undefined);
  assert.equal(resumeOptions.resume, 'backend-session-9');
});

test('ClaudeCodeAdapter maps streamed SDK messages into normalized events', async () => {
  const adapter = new ClaudeCodeAdapter(({ options }) =>
    createFakeQuery([
      {
        type: 'system',
        subtype: 'init',
        session_id: options.sessionId ?? 'backend-session-1',
        uuid: 'u-init',
        cwd: '/tmp/project',
        model: 'claude-sonnet-4-6',
        tools: ['Read', 'Edit', 'Bash'],
        mcp_servers: [],
        apiKeySource: 'user',
        claude_code_version: '1.0.0',
        permissionMode: 'bypassPermissions',
        slash_commands: [],
        output_style: 'default',
        skills: [],
        plugins: [],
      },
      {
        type: 'assistant',
        session_id: 'session-1',
        uuid: 'u-tool-use',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: {
                command: 'npm test',
                description: 'Run the test suite',
              },
            },
            {
              type: 'tool_use',
              id: 'tool-2',
              name: 'Read',
              input: {
                file_path: '/tmp/project/README.md',
              },
            },
          ],
        },
      },
      {
        type: 'tool_progress',
        session_id: 'session-1',
        uuid: 'u-tool-progress',
        tool_use_id: 'tool-1',
        tool_name: 'Bash',
        parent_tool_use_id: null,
        elapsed_time_seconds: 1,
      },
      {
        type: 'user',
        session_id: 'session-1',
        uuid: 'u-tool-result',
        parent_tool_use_id: 'tool-1',
        tool_use_result: {
          tool_use_id: 'tool-1',
          stdout: '8 tests passed',
          stderr: '',
          exitCode: 0,
          persistedOutputPath: '/tmp/project/.logs/npm-test.txt',
        },
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              is_error: false,
              content: [{ type: 'text', text: '8 tests passed' }],
            },
          ],
        },
      },
      {
        type: 'tool_use_summary',
        session_id: 'session-1',
        uuid: 'u-tool-summary',
        summary: 'Ran npm test',
        preceding_tool_use_ids: ['tool-1', 'tool-2'],
      },
      {
        type: 'system',
        subtype: 'files_persisted',
        session_id: 'session-1',
        uuid: 'u-files',
        processed_at: new Date().toISOString(),
        files: [
          { filename: 'src/a.ts', file_id: 'f-1' },
          { filename: 'src/b.ts', file_id: 'f-2' },
        ],
        failed: [],
      },
      {
        type: 'assistant',
        session_id: 'session-1',
        uuid: 'u-assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'thinking', thinking: 'Need to adjust the tests.' },
            { type: 'text', text: 'Implemented the change and updated tests.' },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        session_id: 'session-1',
        uuid: 'u-result',
        duration_ms: 1000,
        duration_api_ms: 800,
        is_error: false,
        num_turns: 2,
        result: 'Implemented the change and updated tests.',
        stop_reason: 'end_turn',
        total_cost_usd: 0.02,
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: {
            web_search_requests: 0,
          },
        },
        modelUsage: {},
        permission_denials: [],
        structured_output: {
          status: 'ok',
        },
      },
    ]),
  );

  const handle = await adapter.spawn({
    runId: 'run-1',
    role: 'worker',
    prompt: 'Implement feature',
    cwd: '/tmp/project',
    sessionMode: 'new',
    session: {
      sessionId: 'session-1',
      backend: 'claude_code',
      cwd: '/tmp/project',
      backendSessionId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    },
    metadata: {},
  });

  const eventsPromise = collect(handle.eventStream);
  await handle.run();
  const events = await eventsPromise;

  assert.deepEqual(
    events.map((event) => event.type),
    [
      'run_started',
      'status_changed',
      'status_changed',
      'command_started',
      'tool_started',
      'command_updated',
      'command_finished',
      'tool_finished',
      'file_changed',
      'reasoning',
      'agent_message',
      'run_completed',
    ],
  );
  assert.equal(events[0].backend, 'claude_code');
  assert.deepEqual(events[0].data, {});
  assert.equal(events[2].data.backend_session_id, 'session-1');
  assert.equal(events[3].data.command, 'npm test');
  assert.equal(events[4].data.tool, 'Read');
  assert.equal(events[5].data.command, 'npm test');
  assert.equal(events[6].data.stdout, '8 tests passed');
  assert.equal(events[6].data.exit_code, 0);
  assert.equal(events[6].data.persisted_output_path, '/tmp/project/.logs/npm-test.txt');
  assert.equal(events[7].data.tool, 'Read');
  assert.equal(events[8].data.changes.length, 2);
  assert.equal(events[9].data.text, 'Need to adjust the tests.');
  assert.equal(events[10].data.text, 'Implemented the change and updated tests.');
  assert.equal(events.at(-1).data.structured_output.status, 'ok');
});


test('ClaudeCodeAdapter ignores late result messages after abort', async () => {
  const adapter = new ClaudeCodeAdapter(() =>
    createDelayedFakeQuery([
      {
        type: 'result',
        subtype: 'success',
        session_id: 'session-1',
        uuid: 'u-result',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: 'late success',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: { web_search_requests: 0 },
        },
        modelUsage: {},
        permission_denials: [],
        structured_output: { ok: true },
      },
    ], 5),
  );

  const handle = await adapter.spawn({
    runId: 'run-1',
    role: 'worker',
    prompt: 'Implement feature',
    cwd: '/tmp/project',
    sessionMode: 'new',
    session: {
      sessionId: 'session-1',
      backend: 'claude_code',
      cwd: '/tmp/project',
      backendSessionId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    },
    metadata: {},
  });

  const eventsPromise = collect(handle.eventStream);
  const runPromise = handle.run();
  handle.abort();
  await runPromise;
  const events = await eventsPromise;

  assert.deepEqual(
    events.map((event) => event.type),
    ['run_started', 'status_changed'],
  );
  assert.equal(handle.getSummary(), 'Run cancelled');
  assert.equal(handle.getResult(), null);
});

test('ClaudeCodeAdapter emits exactly one command_started when tool_progress arrives before tool_use', async () => {
  const adapter = new ClaudeCodeAdapter(() =>
    createFakeQuery([
      {
        type: 'tool_progress',
        session_id: 'session-1',
        uuid: 'u-tool-progress',
        tool_use_id: 'tool-1',
        tool_name: 'Bash',
        parent_tool_use_id: null,
        elapsed_time_seconds: 1,
      },
      {
        type: 'assistant',
        session_id: 'session-1',
        uuid: 'u-tool-use',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: {
                command: 'npm test',
              },
            },
          ],
        },
      },
      {
        type: 'tool_use_summary',
        session_id: 'session-1',
        uuid: 'u-tool-summary',
        summary: 'Ran npm test',
        preceding_tool_use_ids: ['tool-1'],
      },
      {
        type: 'result',
        subtype: 'success',
        session_id: 'session-1',
        uuid: 'u-result',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: 'done',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: { web_search_requests: 0 },
        },
        modelUsage: {},
        permission_denials: [],
        structured_output: { ok: true },
      },
    ]),
  );

  const handle = await adapter.spawn({
    runId: 'run-1',
    role: 'worker',
    prompt: 'Implement feature',
    cwd: '/tmp/project',
    sessionMode: 'new',
    session: {
      sessionId: 'session-1',
      backend: 'claude_code',
      cwd: '/tmp/project',
      backendSessionId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    },
    metadata: {},
  });

  const eventsPromise = collect(handle.eventStream);
  await handle.run();
  const events = await eventsPromise;

  assert.equal(events.filter((event) => event.type === 'command_started').length, 1);
  assert.equal(events.filter((event) => event.type === 'command_finished').length, 1);
});

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

function createFakeQuery(messages) {
  const iterator = (async function* () {
    for (const message of messages) {
      yield message;
    }
  })();

  iterator.close = () => {};
  return iterator;
}

function createDelayedFakeQuery(messages, delayMs) {
  const iterator = (async function* () {
    for (const message of messages) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      yield message;
    }
  })();

  iterator.close = () => {};
  return iterator;
}
