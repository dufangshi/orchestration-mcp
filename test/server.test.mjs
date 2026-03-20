import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../dist/server.js';

async function withServer(fn, options = {}) {
  const server = createServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.1.0' }, { capabilities: {} });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test('server registers all orchestration tools', async () => {
  await withServer(async (client) => {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        'cancel_run',
        'continue_run',
        'fetch_agent_messages',
        'get_event_artifact',
        'get_run',
        'list_agents',
        'list_runs',
        'poll_events',
        'send_agent_message',
        'spawn_run',
      ],
    );
  });
});

test('spawn_run rejects relative cwd values', async () => {
  await withServer(async (client) => {
    const result = await client.callTool({
      name: 'spawn_run',
      arguments: {
        backend: 'codex',
        role: 'worker',
        prompt: 'hello',
        cwd: 'relative/path',
        session_mode: 'new',
      },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /absolute path/i);
  });
});

test('get_event_artifact returns structured tool errors for missing fields', async () => {
  const manager = {
    async getEventArtifact() {
      throw new Error('No artifact for field_path /missing. Available field paths: /stdout');
    },
  };

  await withServer(
    async (client) => {
      const result = await client.callTool({
        name: 'get_event_artifact',
        arguments: {
          run_id: 'run-1',
          seq: 2,
          field_path: '/missing',
        },
      });

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Available field paths: \/stdout/);
    },
    { manager },
  );
});

test('get_run tool accepts agent_name references', async () => {
  const manager = {
    async getRun(input) {
      assert.equal(input.agent_name, 'worker1');
      assert.equal(input.cwd, '/tmp/project');
      return {
        run_id: 'run-1',
        backend: 'codex',
        role: 'worker',
        session_id: 'session-1',
        agent_name: 'worker1',
        status: 'running',
        started_at: '2026-03-19T00:00:00.000Z',
        updated_at: '2026-03-19T00:00:01.000Z',
        summary: 'Running',
        last_seq: 1,
        cwd: '/tmp/project',
        metadata: {},
        remote_ref: null,
      };
    },
  };

  await withServer(
    async (client) => {
      const result = await client.callTool({
        name: 'get_run',
        arguments: {
          agent_name: 'worker1',
          cwd: '/tmp/project',
        },
      });

      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /worker1/);
    },
    { manager },
  );
});

test('run-targeted tools reject missing run references', async () => {
  await withServer(async (client) => {
    const result = await client.callTool({
      name: 'continue_run',
      arguments: {
        input_message: {
          role: 'user',
          parts: [{ type: 'text', text: 'continue' }],
        },
      },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Provide exactly one of run_id or agent_name/);
  });
});
