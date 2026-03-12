#!/usr/bin/env node

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { startClaudeA2ATestAgent, startCodexA2ATestAgent } from './local-a2a-agent.js';

type AgentChoice = 'codex' | 'claude_code';

async function main(): Promise<void> {
  const rl = createInterface({
    input: stdin,
    output: stdout,
  });

  try {
    const agent = await promptForAgent(rl);
    const started = agent === 'codex' ? await startCodexA2ATestAgent() : await startClaudeA2ATestAgent();

    const shutdown = async (signal: string): Promise<void> => {
      stdout.write(`\nReceived ${signal}, shutting down ${agent} A2A wrapper...\n`);
      await started.close();
      process.exit(0);
    };

    process.once('SIGINT', () => {
      void shutdown('SIGINT');
    });
    process.once('SIGTERM', () => {
      void shutdown('SIGTERM');
    });

    stdout.write('\nA2A wrapper started successfully.\n');
    stdout.write(`Agent: ${agent}\n`);
    stdout.write('Backend working directory: provided dynamically by spawn_run.cwd\n');
    stdout.write(`Base URL: ${started.url}\n`);
    stdout.write(`JSON-RPC URL: ${started.url}/a2a/jsonrpc\n`);
    stdout.write(`Agent Card: ${started.url}/.well-known/agent-card.json\n`);
    stdout.write('\nUse this MCP payload:\n');
    stdout.write(
      `${JSON.stringify(
        {
          backend: 'remote_a2a',
          role: 'worker',
          prompt: `Ask ${agent} to perform a task`,
          cwd: '/abs/path/to/working/tree',
          session_mode: 'new',
          backend_config: {
            agent_url: started.url,
          },
        },
        null,
        2,
      )}\n`,
    );
    stdout.write('\nPress Ctrl+C to stop the wrapper.\n');

    await new Promise(() => {});
  } finally {
    rl.close();
  }
}

async function promptForAgent(rl: ReturnType<typeof createInterface>): Promise<AgentChoice> {
  for (;;) {
    const answer = (await rl.question(
      'Choose backend to wrap (`1`/`codex` or `2`/`claude_code`): ',
    ))
      .trim()
      .toLowerCase();

    if (answer === '1' || answer === 'codex') {
      return 'codex';
    }
    if (answer === '2' || answer === 'claude_code' || answer === 'claude' || answer === 'claudecode') {
      return 'claude_code';
    }
    stdout.write('Invalid choice. Enter `1`, `codex`, `2`, or `claude_code`.\n');
  }
}

main().catch((error) => {
  console.error('Failed to start A2A wrapper:', error);
  process.exit(1);
});
