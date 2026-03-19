#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { RunManager } from '../core/run-manager.js';
import type { AgentDirectoryEntry, AgentMessage, FetchAgentMessagesResult } from '../core/types.js';

interface PeerCliIo {
  env: NodeJS.ProcessEnv;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  cwd: string;
  sleep: (ms: number) => Promise<void>;
}

interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

const DEFAULT_WAIT_TIMEOUT_MS = 30000;
const DEFAULT_FETCH_LIMIT = 100;
const WAIT_POLL_INTERVAL_MS = 500;

export async function runPeerCli(
  argv: string[],
  io: PeerCliIo = defaultCliIo(),
): Promise<number> {
  const parsed = parseArgs(argv);
  const manager = new RunManager([]);

  try {
    switch (parsed.command) {
      case 'whoami':
        return await handleWhoAmI(manager, parsed, io);
      case 'list':
        return await handleList(manager, parsed, io);
      case 'send':
        return await handleSend(manager, parsed, io);
      case 'inbox':
        return await handleInbox(manager, parsed, io);
      case 'wait':
        return await handleWait(manager, parsed, io);
      default:
        printUsage(io.stderr);
        return parsed.command ? 1 : 2;
    }
  } catch (error) {
    io.stderr.write(`${String(error)}\n`);
    return 1;
  }
}

async function handleWhoAmI(manager: RunManager, parsed: ParsedArgs, io: PeerCliIo): Promise<number> {
  const identity = await resolveCurrentIdentity(manager, parsed, io);
  return printResult(
    {
      agent_name: identity.agent.agent_name,
      session_id: identity.agent.session_id,
      cwd: identity.agent.cwd,
      role: identity.agent.role,
      status: identity.agent.status,
      last_run_id: identity.agent.last_run_id,
    },
    parsed,
    io,
    (result) => `${result.agent_name}\t${result.status}\t${result.cwd}`,
  );
}

async function handleList(manager: RunManager, parsed: ParsedArgs, io: PeerCliIo): Promise<number> {
  const cwd = getOptionalCwd(parsed, io);
  const result = await manager.listAgents({ cwd });
  return printResult(result, parsed, io, (payload) =>
    payload.agents.map((agent) => `${agent.agent_name}\t${agent.role ?? '-'}\t${agent.status}`).join('\n'),
  );
}

async function handleSend(manager: RunManager, parsed: ParsedArgs, io: PeerCliIo): Promise<number> {
  if (parsed.positionals.length < 2) {
    throw new Error('Usage: peer send <to> <text> [--kind KIND] [--reply-to MESSAGE_ID] [--json]');
  }
  const sender = resolveAgentName(parsed, io, false);
  const cwd = getOptionalCwd(parsed, io);
  const to = parsed.positionals[0];
  const text = parsed.positionals.slice(1).join(' ').trim();
  if (!text) {
    throw new Error('Message text is required');
  }

  const metadata: Record<string, unknown> = {};
  const kind = getOptionalStringFlag(parsed, 'kind');
  if (kind) {
    metadata.kind = kind;
  }
  const replyTo = getOptionalStringFlag(parsed, 'reply-to');
  if (replyTo) {
    metadata.reply_to = replyTo;
  }

  const message: AgentMessage = {
    role: 'user',
    parts: [{ type: 'text', text }],
  };

  const result = await manager.sendAgentMessage({
    cwd,
    from_agent_name: sender,
    to_agent_name: to,
    message,
    metadata,
  });
  return printResult(result, parsed, io, (payload) => `sent ${payload.message_id} -> ${payload.to_agent_name} (#${payload.seq})`);
}

async function handleInbox(manager: RunManager, parsed: ParsedArgs, io: PeerCliIo): Promise<number> {
  const identity = await resolveCurrentIdentity(manager, parsed, io);
  const afterSeq = getOptionalNumberFlag(parsed, 'after') ?? 0;
  const limit = getOptionalNumberFlag(parsed, 'limit') ?? DEFAULT_FETCH_LIMIT;
  const result = await manager.fetchAgentMessages({
    agent_name: identity.agent.agent_name,
    cwd: identity.agent.cwd,
    after_seq: afterSeq,
    limit,
  });
  return printResult(result, parsed, io, formatInboxPlainText);
}

async function handleWait(manager: RunManager, parsed: ParsedArgs, io: PeerCliIo): Promise<number> {
  const identity = await resolveCurrentIdentity(manager, parsed, io);
  const explicitAfter = getOptionalNumberFlag(parsed, 'after');
  const limit = getOptionalNumberFlag(parsed, 'limit') ?? DEFAULT_FETCH_LIMIT;
  const timeoutMs = getOptionalNumberFlag(parsed, 'timeout') ?? DEFAULT_WAIT_TIMEOUT_MS;
  const useCursor = explicitAfter === undefined;
  const cursorPath = getCursorPath(identity.agent.cwd, identity.agent.agent_name);
  let afterSeq = explicitAfter ?? (useCursor ? await readCursor(cursorPath) : 0);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const result = await manager.fetchAgentMessages({
      agent_name: identity.agent.agent_name,
      cwd: identity.agent.cwd,
      after_seq: afterSeq,
      limit,
    });
    if (result.messages.length > 0) {
      if (useCursor) {
        await writeCursor(cursorPath, result.next_after_seq);
      }
      return printResult(result, parsed, io, formatInboxPlainText);
    }
    if (Date.now() >= deadline) {
      const empty: FetchAgentMessagesResult = {
        ...result,
        messages: [],
        next_after_seq: afterSeq,
      };
      return printResult(empty, parsed, io, formatInboxPlainText);
    }
    await io.sleep(WAIT_POLL_INTERVAL_MS);
    afterSeq = explicitAfter ?? (useCursor ? await readCursor(cursorPath) : afterSeq);
  }
}

async function resolveCurrentIdentity(
  manager: RunManager,
  parsed: ParsedArgs,
  io: PeerCliIo,
): Promise<{ agent: AgentDirectoryEntry }> {
  const agentName = resolveAgentName(parsed, io, true);
  const cwd = getOptionalCwd(parsed, io);
  const agents = await manager.listAgents({ cwd });
  const matches = agents.agents.filter((agent) => agent.agent_name === agentName);
  if (matches.length === 0) {
    throw new Error(cwd ? `Unknown agent_name in cwd ${cwd}: ${agentName}` : `Unknown agent_name: ${agentName}`);
  }
  if (matches.length > 1) {
    throw new Error(`agent_name is ambiguous across multiple cwd values: ${agentName}`);
  }
  return { agent: matches[0] };
}

function resolveAgentName(parsed: ParsedArgs, io: PeerCliIo, required: boolean): string | undefined {
  const explicit = getOptionalStringFlag(parsed, 'as');
  const fromEnv = normalizeString(io.env.PEER_NAME);
  const agentName = explicit ?? fromEnv;
  if (!agentName && required) {
    throw new Error('Current agent identity is unknown. Set PEER_NAME or pass --as <agent_name>.');
  }
  return agentName;
}

function getOptionalCwd(parsed: ParsedArgs, io: PeerCliIo): string | undefined {
  return getOptionalStringFlag(parsed, 'cwd') ?? normalizeString(io.env.PEER_CWD) ?? io.cwd;
}

function getCursorPath(cwd: string, agentName: string): string {
  return path.join(cwd, '.nanobot-orchestrator', 'agents', `${agentName}.cursor`);
}

async function readCursor(filePath: string): Promise<number> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

async function writeCursor(filePath: string, nextAfterSeq: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${nextAfterSeq}\n`, 'utf8');
}

function printResult<T>(
  result: T,
  parsed: ParsedArgs,
  io: PeerCliIo,
  formatPlain: (result: T) => string,
): number {
  if (parsed.flags.get('json') === true) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  const text = formatPlain(result);
  if (text) {
    io.stdout.write(`${text}\n`);
  }
  return 0;
}

function formatInboxPlainText(result: FetchAgentMessagesResult): string {
  if (result.messages.length === 0) {
    return 'no messages';
  }
  return result.messages
    .map((message) => {
      const text = message.body.parts
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join(' ')
        .trim();
      return `[${message.seq}] ${message.from_agent_name ?? 'system'}: ${text}`;
    })
    .join('\n');
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  let command: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!command && !token.startsWith('--')) {
      command = token;
      continue;
    }
    if (token.startsWith('--')) {
      const trimmed = token.slice(2);
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex >= 0) {
        flags.set(trimmed.slice(0, eqIndex), trimmed.slice(eqIndex + 1));
        continue;
      }
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        flags.set(trimmed, next);
        index += 1;
        continue;
      }
      flags.set(trimmed, true);
      continue;
    }
    positionals.push(token);
  }

  return { command, positionals, flags };
}

function getOptionalStringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === 'string' ? normalizeString(value) : undefined;
}

function getOptionalNumberFlag(parsed: ParsedArgs, name: string): number | undefined {
  const value = getOptionalStringFlag(parsed, name);
  if (!value) {
    return undefined;
  }
  const parsedValue = Number.parseInt(value, 10);
  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    throw new Error(`Invalid value for --${name}: ${value}`);
  }
  return parsedValue;
}

function normalizeString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function printUsage(stderr: Pick<NodeJS.WriteStream, 'write'>): void {
  stderr.write(`Usage:
  peer whoami [--as AGENT_NAME] [--cwd CWD] [--json]
  peer list [--cwd CWD] [--json]
  peer send <to> <text> [--as AGENT_NAME] [--cwd CWD] [--kind KIND] [--reply-to MESSAGE_ID] [--json]
  peer inbox [--as AGENT_NAME] [--cwd CWD] [--after SEQ] [--limit N] [--json]
  peer wait [--as AGENT_NAME] [--cwd CWD] [--after SEQ] [--limit N] [--timeout MS] [--json]
`);
}

function defaultCliIo(): PeerCliIo {
  return {
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: process.cwd(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const exitCode = await runPeerCli(argv);
  process.exitCode = exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
