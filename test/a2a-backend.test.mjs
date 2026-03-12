import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';

import express from 'express';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { UserBuilder, agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express';

import { RemoteA2AAdapter } from '../dist/backends/remote-a2a.js';
import { RunManager } from '../dist/core/run-manager.js';
import { startLocalA2ATestAgent } from '../dist/test-agents/local-a2a-agent.js';

test('RunManager can drive remote A2A tasks through input_required and continue_run', async () => {
  const a2aServer = await startInteractiveA2AServer();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-a2a-'));
  const manager = new RunManager([new RemoteA2AAdapter()]);

  try {
    const spawned = await manager.spawnRun({
      backend: 'remote_a2a',
      role: 'worker',
      prompt: 'Start the task',
      cwd,
      session_mode: 'new',
      backend_config: {
        agent_url: a2aServer.url,
      },
    });

    await waitFor(async () => {
      const run = await manager.getRun({ run_id: spawned.run_id });
      assert.equal(run.status, 'input_required');
      assert.equal(run.remote_ref?.agent_url, `${a2aServer.url}/a2a/jsonrpc`);
    });

    const firstPoll = await manager.pollEvents({
      run_id: spawned.run_id,
      after_seq: 0,
      limit: 20,
      wait_ms: 0,
    });
    assert.equal(
      firstPoll.events.some(
        (event) =>
          event.type === 'input_required' ||
          (event.type === 'status_changed' && event.data.status === 'input_required'),
      ),
      true,
    );

    await manager.continueRun({
      run_id: spawned.run_id,
      input_message: {
        role: 'user',
        parts: [{ type: 'text', text: 'Use the approved implementation.' }],
      },
    });

    await waitFor(async () => {
      const run = await manager.getRun({ run_id: spawned.run_id });
      assert.equal(run.status, 'completed');
    });

    const finalPoll = await manager.pollEvents({
      run_id: spawned.run_id,
      after_seq: 0,
      limit: 50,
      wait_ms: 0,
    });
    assert.equal(finalPoll.events.some((event) => event.type === 'artifact_added'), true);
    assert.equal(finalPoll.events.some((event) => event.type === 'run_completed'), true);

    const artifactEvent = finalPoll.events.find((event) => event.type === 'artifact_added');
    assert.equal(artifactEvent.data.text, 'Processed: Use the approved implementation.');

    const completed = finalPoll.events.find((event) => event.type === 'run_completed');
    assert.equal(completed.data.final_response, 'Processed: Use the approved implementation.');
    assert.deepEqual(completed.data.structured_output, { accepted: true });
  } finally {
    await a2aServer.close();
  }
});

test('local A2A wrapper uses spawn_run.cwd as backend working directory', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-a2a-wrapper-'));
  const backend = new RecordingBackend();
  const agentCard = {
    name: 'Recording Test Agent',
    description: 'Records the cwd passed into the wrapped backend.',
    protocolVersion: '0.3.0',
    version: '0.1.0',
    url: '',
    preferredTransport: 'JSONRPC',
    skills: [
      {
        id: 'record-cwd',
        name: 'Record CWD',
        description: 'Captures the effective cwd for verification.',
        tags: ['test'],
      },
    ],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
  };
  const a2aServer = await startLocalA2ATestAgent({
    agentCard,
    backend,
  });
  agentCard.url = `${a2aServer.url}/a2a/jsonrpc`;
  const manager = new RunManager([new RemoteA2AAdapter()]);

  try {
    const spawned = await manager.spawnRun({
      backend: 'remote_a2a',
      role: 'worker',
      prompt: 'Run with dynamic cwd',
      cwd,
      session_mode: 'new',
      backend_config: {
        agent_url: a2aServer.url,
      },
    });

    await waitFor(async () => {
      const run = await manager.getRun({ run_id: spawned.run_id });
      assert.equal(run.status, 'completed');
    });

    assert.equal(backend.spawnCalls.length, 1);
    assert.equal(backend.spawnCalls[0].cwd, cwd);

    const events = await manager.pollEvents({
      run_id: spawned.run_id,
      after_seq: 0,
      limit: 50,
      wait_ms: 0,
    });
    const completed = events.events.find((event) => event.type === 'run_completed');
    assert.equal(completed.data.final_response, `cwd:${cwd}`);
  } finally {
    await a2aServer.close();
  }
});

async function startInteractiveA2AServer() {
  class InteractiveExecutor {
    async execute(requestContext, eventBus) {
      const userText = requestContext.userMessage.parts
        .filter((part) => part.kind === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim();

      if (!requestContext.task) {
        eventBus.publish({
          kind: 'task',
          id: requestContext.taskId,
          contextId: requestContext.contextId,
          status: {
            state: 'submitted',
            timestamp: new Date().toISOString(),
          },
          history: [requestContext.userMessage],
        });
        eventBus.publish({
          kind: 'status-update',
          taskId: requestContext.taskId,
          contextId: requestContext.contextId,
          status: {
            state: 'input-required',
            timestamp: new Date().toISOString(),
            message: {
              kind: 'message',
              messageId: `${requestContext.taskId}-input`,
              role: 'agent',
              taskId: requestContext.taskId,
              contextId: requestContext.contextId,
              parts: [{ kind: 'text', text: `Need more input after: ${userText}` }],
            },
          },
          final: false,
        });
        eventBus.finished();
        return;
      }

      eventBus.publish({
        kind: 'status-update',
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        status: {
          state: 'working',
          timestamp: new Date().toISOString(),
        },
        final: false,
      });
      eventBus.publish({
        kind: 'artifact-update',
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        artifact: {
          artifactId: 'final-response',
          name: 'final-response',
          parts: [
            { kind: 'text', text: `Processed: ${userText}` },
            { kind: 'data', data: { accepted: true } },
          ],
        },
      });
      eventBus.publish({
        kind: 'status-update',
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        status: {
          state: 'completed',
          timestamp: new Date().toISOString(),
        },
        final: true,
      });
      eventBus.finished();
    }

    async cancelTask(taskId, eventBus) {
      eventBus.publish({
        kind: 'status-update',
        taskId,
        contextId: taskId,
        status: {
          state: 'canceled',
          timestamp: new Date().toISOString(),
        },
        final: true,
      });
      eventBus.finished();
    }
  }

  const card = {
    name: 'Interactive Test Agent',
    description: 'A local interactive A2A test agent.',
    protocolVersion: '0.3.0',
    version: '0.1.0',
    url: '',
    preferredTransport: 'JSONRPC',
    skills: [
      {
        id: 'interactive-test',
        name: 'Interactive Test',
        description: 'Requests more input, then completes.',
        tags: ['test'],
      },
    ],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
  };

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new InteractiveExecutor());
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
  app.use('/a2a/jsonrpc', jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  const server = createServer(app);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind A2A test server');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  card.url = `${baseUrl}/a2a/jsonrpc`;

  return {
    url: baseUrl,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

class RecordingBackend {
  constructor() {
    this.backend = 'codex';
    this.spawnCalls = [];
  }

  async spawn(params) {
    this.spawnCalls.push(params);
    const finalResponse = `cwd:${params.cwd}`;
    return {
      sessionId: params.session.sessionId,
      eventStream: streamEvents([
        {
          seq: 0,
          ts: new Date().toISOString(),
          run_id: '',
          session_id: params.session.sessionId,
          backend: this.backend,
          type: 'agent_message',
          data: {
            text: finalResponse,
          },
        },
        {
          seq: 0,
          ts: new Date().toISOString(),
          run_id: '',
          session_id: params.session.sessionId,
          backend: this.backend,
          type: 'run_completed',
          data: {
            final_response: finalResponse,
          },
        },
      ]),
      async run() {},
      getSummary() {
        return 'completed';
      },
      getResult() {
        return {
          finalResponse,
        };
      },
    };
  }

  async cancel() {}
}

async function* streamEvents(events) {
  for (const event of events) {
    yield event;
  }
}

async function waitFor(assertion, timeoutMs = 5000) {
  const startedAt = Date.now();
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt > timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
