#!/usr/bin/env node

import { access, constants, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createOrchestratorApp, type OrchestratorApp } from '../app/orchestrator-app.js';
import { DetachedOrchestratorClient } from '../app/orchestrator-client.js';
import type {
  AgentMessage,
  BackendKind,
  CancelRunResult,
  ContinueRunResult,
  GetRunResult,
  NormalizedEvent,
  RunResult,
  RunRole,
  RunStatus,
  SpawnRunInput,
  SpawnRunResult,
} from '../core/types.js';
import type { DaemonStartResult, DaemonStatus, DaemonStopResult } from '../daemon/types.js';

interface OrchestratorCliIo {
  env: NodeJS.ProcessEnv;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  cwd: string;
  stdinIsTTY: boolean;
  readStdin(): Promise<string>;
  sleep(ms: number): Promise<void>;
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

interface OrchestratorCliDeps {
  createApp(): OrchestratorApp;
  createDetachedClient(): DetachedCliClient;
}

interface ForegroundRunPayload {
  spawn: {
    run_id: string;
    backend: BackendKind;
    role: RunRole;
    session_id: string;
    agent_name: string;
    status: RunStatus;
  };
  run: GetRunResult;
  result: RunResult | null;
}

interface EventTailPayload {
  run: GetRunResult;
  events: NormalizedEvent[];
  next_after_seq: number;
}

interface DetachedCliClient {
  daemonStart(): Promise<DaemonStartResult>;
  daemonStatus(): Promise<DaemonStatus>;
  daemonStop(): Promise<DaemonStopResult>;
  spawnRun(input: SpawnRunInput): Promise<SpawnRunResult>;
  continueRun(input: { run_id: string; input_message: AgentMessage }): Promise<ContinueRunResult>;
  cancelRun(input: { run_id: string }): Promise<CancelRunResult>;
}

const EXIT_SUCCESS = 0;
const EXIT_USAGE = 2;
const EXIT_RUN_FAILED = 5;
const EXIT_RUN_CANCELLED = 6;
const EXIT_RUN_NEEDS_INPUT = 7;
const EXIT_INTERNAL = 8;

const DEFAULT_BACKEND: BackendKind = 'codex';
const DEFAULT_EVENT_LIMIT = 100;
const DEFAULT_TAIL_IDLE_TIMEOUT_MS = 30000;
const TAIL_POLL_INTERVAL_MS = 200;

export async function runOrchestratorCli(
  argv: string[],
  io: OrchestratorCliIo = defaultCliIo(),
  deps: OrchestratorCliDeps = defaultCliDeps(),
): Promise<number> {
  const parsed = parseArgs(argv);

  try {
    const command = parsed.positionals[0];
    switch (command) {
      case 'ask':
        return await handleForegroundCommand('planner', parsed, io, deps);
      case 'run':
        return await handleForegroundCommand('worker', parsed, io, deps);
      case 'review':
        return await handleForegroundCommand('reviewer', parsed, io, deps);
      case 'runs':
        return await handleRunsCommand(parsed, io, deps);
      case 'events':
        return await handleEventsCommand(parsed, io, deps);
      case 'artifacts':
        return await handleArtifactsCommand(parsed, io, deps);
      case 'daemon':
        return await handleDaemonCommand(parsed, io, deps);
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        printUsage(io.stderr);
        return command ? EXIT_SUCCESS : EXIT_USAGE;
      default:
        throw new CliUsageError(`Unknown command: ${command}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n`);
    return error instanceof CliError ? error.exitCode : EXIT_INTERNAL;
  }
}

async function handleForegroundCommand(
  role: RunRole,
  parsed: ParsedArgs,
  io: OrchestratorCliIo,
  deps: OrchestratorCliDeps,
): Promise<number> {
  if (hasBooleanFlag(parsed, 'detach')) {
    return handleDetachedForegroundCommand(role, parsed, io, deps);
  }

  const output = getOutputFormat(parsed, ['text', 'json', 'jsonl']);
  const cwd = getCommandCwd(parsed, io);
  const prompt = getOptionalStringFlag(parsed, 'prompt') ?? joinPromptPositionals(parsed.positionals.slice(1));
  const stdinText = await readOptionalStdin(io);
  const inputMessage = buildInputMessage(prompt, stdinText);
  const profile = getOptionalStringFlag(parsed, 'profile') ?? (await resolveDefaultProfile(role, cwd));
  const backend = getBackend(parsed);
  const resumeSessionId = getOptionalStringFlag(parsed, 'resume');
  const schemaPath = getOptionalStringFlag(parsed, 'schema');
  const nickname = getOptionalStringFlag(parsed, 'name');
  const agentUrl = getOptionalStringFlag(parsed, 'agent-url');
  const metadata = parseMetadata(parsed);
  const app = deps.createApp();

  try {
    const spawnInput: SpawnRunInput = {
      backend,
      role,
      nickname,
      cwd,
      session_mode: resumeSessionId ? 'resume' : 'new',
      session_id: resumeSessionId,
      profile,
      output_schema: schemaPath ? await readJsonFile(schemaPath, cwd) : undefined,
      metadata,
      backend_config: agentUrl ? { agent_url: agentUrl } : undefined,
      ...(inputMessage ? { input_message: inputMessage } : {}),
    };

    const spawn = await app.manager.spawnRun(spawnInput);
    const payload = await waitForForegroundRun(app, spawn.run_id, output, io);
    const finalized = await finalizeForegroundPayload(payload, app, io);

    if (output === 'json') {
      io.stdout.write(`${JSON.stringify(finalized.payload, null, 2)}\n`);
    } else if (output === 'jsonl') {
      io.stdout.write(`${JSON.stringify({ type: 'run_summary', payload: finalized.payload })}\n`);
    }

    return finalized.exitCode;
  } finally {
    await app.shutdown(1000);
  }
}

async function handleDetachedForegroundCommand(
  role: RunRole,
  parsed: ParsedArgs,
  io: OrchestratorCliIo,
  deps: OrchestratorCliDeps,
): Promise<number> {
  const output = getOutputFormat(parsed, ['text', 'json', 'jsonl']);
  const cwd = getCommandCwd(parsed, io);
  const prompt = getOptionalStringFlag(parsed, 'prompt') ?? joinPromptPositionals(parsed.positionals.slice(1));
  const stdinText = await readOptionalStdin(io);
  const inputMessage = buildInputMessage(prompt, stdinText);
  const profile = getOptionalStringFlag(parsed, 'profile') ?? (await resolveDefaultProfile(role, cwd));
  const backend = getBackend(parsed);
  const resumeSessionId = getOptionalStringFlag(parsed, 'resume');
  const schemaPath = getOptionalStringFlag(parsed, 'schema');
  const nickname = getOptionalStringFlag(parsed, 'name');
  const agentUrl = getOptionalStringFlag(parsed, 'agent-url');
  const metadata = parseMetadata(parsed);
  const client = deps.createDetachedClient();

  const spawn = await client.spawnRun({
    backend,
    role,
    nickname,
    cwd,
    session_mode: resumeSessionId ? 'resume' : 'new',
    session_id: resumeSessionId,
    profile,
    output_schema: schemaPath ? await readJsonFile(schemaPath, cwd) : undefined,
    metadata,
    backend_config: agentUrl ? { agent_url: agentUrl } : undefined,
    ...(inputMessage ? { input_message: inputMessage } : {}),
  });

  if (output === 'json') {
    io.stdout.write(`${JSON.stringify(spawn, null, 2)}\n`);
  } else if (output === 'jsonl') {
    io.stdout.write(`${JSON.stringify({ type: 'spawn', payload: spawn })}\n`);
  } else {
    io.stdout.write(formatSpawnRunText(spawn));
  }

  return EXIT_SUCCESS;
}

async function waitForForegroundRun(
  app: OrchestratorApp,
  runId: string,
  output: OutputFormat,
  io: OrchestratorCliIo,
): Promise<ForegroundRunPayload> {
  let afterSeq = 0;
  const renderedAgentMessages = new Set<number>();
  let eventDerivedResult: RunResult | null = null;

  for (;;) {
    const polled = await app.manager.pollEvents({
      run_id: runId,
      after_seq: afterSeq,
      limit: DEFAULT_EVENT_LIMIT,
      wait_ms: 200,
    });
    afterSeq = polled.next_after_seq;

    if (output === 'jsonl') {
      for (const event of polled.events) {
        io.stdout.write(`${JSON.stringify(event)}\n`);
      }
    } else if (output === 'text') {
      for (const event of polled.events) {
        const line = formatEventText(event, renderedAgentMessages);
        if (line) {
          io.stdout.write(`${line}\n`);
        }
      }
    }
    eventDerivedResult = updateEventDerivedResult(eventDerivedResult, polled.events);

    const run = await app.manager.getRun({ run_id: runId });
    if (isCliStopStatus(run.status)) {
      const result = (await readTerminalRunResult(app, runId, run.status, io)) ?? eventDerivedResult;
      const payload: ForegroundRunPayload = {
        spawn: {
          run_id: run.run_id,
          backend: run.backend,
          role: run.role,
          session_id: run.session_id,
          agent_name: run.agent_name,
          status: run.status,
        },
        run,
        result,
      };
      return payload;
    }
  }
}

async function readTerminalRunResult(
  app: OrchestratorApp,
  runId: string,
  status: RunStatus,
  io: OrchestratorCliIo,
): Promise<RunResult | null> {
  if (status === 'input_required' || status === 'auth_required') {
    return null;
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await app.storage.readResultById(runId);
    if (result !== null) {
      return result;
    }
    const persisted = await app.storage.readRunRecordById(runId);
    if (persisted?.result) {
      return persisted.result;
    }
    await io.sleep(20);
  }

  return null;
}

async function finalizeForegroundPayload(
  payload: ForegroundRunPayload,
  app: OrchestratorApp,
  io: OrchestratorCliIo,
): Promise<{ payload: ForegroundRunPayload; exitCode: number }> {
  if (payload.run.status !== 'input_required' && payload.run.status !== 'auth_required') {
    return {
      payload,
      exitCode: exitCodeForRunStatus(payload.run.status),
    };
  }

  await app.manager.cancelRun({ run_id: payload.run.run_id });
  const cancelledRun = await app.manager.getRun({ run_id: payload.run.run_id });
  io.stderr.write(
    'Foreground CLI cannot keep a run waiting for additional input after process exit; the run was cancelled.\n',
  );

  return {
    payload: {
      ...payload,
      spawn: {
        ...payload.spawn,
        status: cancelledRun.status,
      },
      run: cancelledRun,
      result: await readTerminalRunResult(app, payload.run.run_id, cancelledRun.status, io),
    },
    exitCode: EXIT_RUN_NEEDS_INPUT,
  };
}

function updateEventDerivedResult(current: RunResult | null, events: NormalizedEvent[]): RunResult | null {
  let next = current;
  for (const event of events) {
    if (event.type !== 'run_completed') {
      continue;
    }
    next = {
      finalResponse: stringOrNull(event.data.final_response),
      structuredOutput: event.data.structured_output,
      usage: event.data.usage,
      artifacts: Array.isArray(event.data.artifacts) ? event.data.artifacts : undefined,
    };
  }
  return next;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

async function handleRunsCommand(
  parsed: ParsedArgs,
  io: OrchestratorCliIo,
  deps: OrchestratorCliDeps,
): Promise<number> {
  const subcommand = parsed.positionals[1];
  if (subcommand === 'list') {
    const output = getOutputFormat(parsed, ['text', 'json']) as 'text' | 'json';
    const app = deps.createApp();
    try {
      const result = await app.manager.listRuns({
        cwd: getOptionalCwd(parsed, io),
        backend: getOptionalBackend(parsed),
        status: getOptionalRunStatus(parsed),
      });
      if (output === 'json') {
        io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        const text = result.runs.length
          ? result.runs
              .map((run) => `${run.run_id}\t${run.status}\t${run.role}\t${run.backend}\t${run.agent_name}\t${run.summary}`)
              .join('\n')
          : 'no runs';
        io.stdout.write(`${text}\n`);
      }
      return EXIT_SUCCESS;
    } finally {
      await app.shutdown(0);
    }
  }

  if (subcommand === 'show') {
    const runId = requirePositional(parsed.positionals[2], 'Usage: orchestrator runs show <run-id> [--output text|json]');
    const output = getOutputFormat(parsed, ['text', 'json']) as 'text' | 'json';
    const app = deps.createApp();
    try {
      const run = await app.manager.getRun({ run_id: runId });
      if (output === 'json') {
        io.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
      } else {
        io.stdout.write(formatRunSummaryText(run));
      }
      return EXIT_SUCCESS;
    } finally {
      await app.shutdown(0);
    }
  }

  if (subcommand === 'continue') {
    const runId = requirePositional(
      parsed.positionals[2],
      'Usage: orchestrator runs continue <run-id> <prompt> [--output text|json]',
    );
    const output = getOutputFormat(parsed, ['text', 'json']) as 'text' | 'json';
    const prompt = getOptionalStringFlag(parsed, 'prompt') ?? joinPromptPositionals(parsed.positionals.slice(3));
    const stdinText = await readOptionalStdin(io);
    const inputMessage = buildInputMessage(prompt, stdinText);
    const client = deps.createDetachedClient();
    const result = await client.continueRun({
      run_id: runId,
      input_message: inputMessage,
    });
    writeJsonOrText(io.stdout, output, result, formatContinueRunText(result));
    return EXIT_SUCCESS;
  }

  if (subcommand === 'cancel') {
    const runId = requirePositional(parsed.positionals[2], 'Usage: orchestrator runs cancel <run-id> [--output text|json]');
    const output = getOutputFormat(parsed, ['text', 'json']) as 'text' | 'json';
    const client = deps.createDetachedClient();
    const result = await client.cancelRun({ run_id: runId });
    writeJsonOrText(io.stdout, output, result, formatCancelRunText(result));
    return EXIT_SUCCESS;
  }

  throw new CliUsageError('Usage: orchestrator runs <list|show|continue|cancel> [args]');
}

async function handleDaemonCommand(
  parsed: ParsedArgs,
  io: OrchestratorCliIo,
  deps: OrchestratorCliDeps,
): Promise<number> {
  const subcommand = parsed.positionals[1];
  const output = getOutputFormat(parsed, ['text', 'json']) as 'text' | 'json';
  const client = deps.createDetachedClient();

  if (subcommand === 'start') {
    const result = await client.daemonStart();
    writeJsonOrText(io.stdout, output, result, formatDaemonStatusText(result));
    return EXIT_SUCCESS;
  }

  if (subcommand === 'status') {
    const result = await client.daemonStatus();
    writeJsonOrText(io.stdout, output, result, formatDaemonStatusText(result));
    return result.status === 'running' ? EXIT_SUCCESS : EXIT_RUN_FAILED;
  }

  if (subcommand === 'stop') {
    const result = await client.daemonStop();
    writeJsonOrText(io.stdout, output, result, formatDaemonStopText(result));
    return EXIT_SUCCESS;
  }

  throw new CliUsageError('Usage: orchestrator daemon <start|status|stop> [--output text|json]');
}

async function handleEventsCommand(
  parsed: ParsedArgs,
  io: OrchestratorCliIo,
  deps: OrchestratorCliDeps,
): Promise<number> {
  const subcommand = parsed.positionals[1];
  if (subcommand !== 'tail') {
    throw new CliUsageError('Usage: orchestrator events tail <run-id> [--after SEQ] [--limit N] [--output text|json|jsonl]');
  }

  const runId = requirePositional(
    parsed.positionals[2],
    'Usage: orchestrator events tail <run-id> [--after SEQ] [--limit N] [--output text|json|jsonl]',
  );
  const output = getOutputFormat(parsed, ['text', 'json', 'jsonl']);
  const afterStart = getOptionalNumberFlag(parsed, 'after') ?? 0;
  const limit = getOptionalNumberFlag(parsed, 'limit') ?? DEFAULT_EVENT_LIMIT;
  const idleTimeoutMs = getOptionalNumberFlag(parsed, 'timeout') ?? DEFAULT_TAIL_IDLE_TIMEOUT_MS;
  const renderedAgentMessages = new Set<number>();
  const app = deps.createApp();

  try {
    let afterSeq = afterStart;
    let idleStartedAt = Date.now();
    const allEvents: NormalizedEvent[] = [];

    for (;;) {
      const polled = await app.manager.pollEvents({
        run_id: runId,
        after_seq: afterSeq,
        limit,
        wait_ms: 0,
      });
      afterSeq = polled.next_after_seq;

      if (polled.events.length > 0) {
        idleStartedAt = Date.now();
        allEvents.push(...polled.events);

        if (output === 'jsonl') {
          for (const event of polled.events) {
            io.stdout.write(`${JSON.stringify(event)}\n`);
          }
        } else if (output === 'text') {
          for (const event of polled.events) {
            const line = formatEventText(event, renderedAgentMessages);
            if (line) {
              io.stdout.write(`${line}\n`);
            }
          }
        }
      }

      const run = await app.manager.getRun({ run_id: runId });
      if (isCliStopStatus(run.status)) {
        if (output === 'json') {
          const payload: EventTailPayload = {
            run,
            events: allEvents,
            next_after_seq: afterSeq,
          };
          io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        } else if (output === 'jsonl') {
          io.stdout.write(`${JSON.stringify({ type: 'run_summary', run, next_after_seq: afterSeq })}\n`);
        }
        return exitCodeForRunStatus(run.status);
      }

      if (Date.now() - idleStartedAt >= idleTimeoutMs) {
        if (output === 'json') {
          const payload: EventTailPayload = {
            run,
            events: allEvents,
            next_after_seq: afterSeq,
          };
          io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        } else if (output === 'jsonl') {
          io.stdout.write(`${JSON.stringify({ type: 'run_summary', run, next_after_seq: afterSeq })}\n`);
        }
        return EXIT_SUCCESS;
      }

      await io.sleep(TAIL_POLL_INTERVAL_MS);
    }
  } finally {
    await app.shutdown(0);
  }
}

async function handleArtifactsCommand(
  parsed: ParsedArgs,
  io: OrchestratorCliIo,
  deps: OrchestratorCliDeps,
): Promise<number> {
  const subcommand = parsed.positionals[1];
  if (subcommand !== 'get') {
    throw new CliUsageError(
      'Usage: orchestrator artifacts get <run-id> <seq> <field-path> [--offset N] [--limit N] [--output text|json]',
    );
  }

  const runId = requirePositional(parsed.positionals[2], 'Usage: orchestrator artifacts get <run-id> <seq> <field-path>');
  const seq = getRequiredNumber(parsed.positionals[3], 'Usage: orchestrator artifacts get <run-id> <seq> <field-path>');
  const fieldPath = requirePositional(
    parsed.positionals[4],
    'Usage: orchestrator artifacts get <run-id> <seq> <field-path>',
  );
  const output = getOutputFormat(parsed, ['text', 'json']);
  const outputFile = getOptionalStringFlag(parsed, 'output-file');
  const app = deps.createApp();

  try {
    const artifact = await app.manager.getEventArtifact({
      run_id: runId,
      seq,
      field_path: fieldPath,
      offset: getOptionalNumberFlag(parsed, 'offset'),
      limit: getOptionalNumberFlag(parsed, 'limit'),
    });
    if (outputFile) {
      const target = path.isAbsolute(outputFile) ? outputFile : path.resolve(io.cwd, outputFile);
      await writeFile(target, artifact.content, 'utf8');
    }

    if (output === 'json') {
      io.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
    } else {
      io.stdout.write(artifact.content);
      if (!artifact.content.endsWith('\n')) {
        io.stdout.write('\n');
      }
    }
    return EXIT_SUCCESS;
  } finally {
    await app.shutdown(0);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  const shortFlags = new Map<string, string>([
    ['p', 'prompt'],
    ['o', 'output'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith('--')) {
      const trimmed = token.slice(2);
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex >= 0) {
        flags.set(trimmed.slice(0, eqIndex), trimmed.slice(eqIndex + 1));
        continue;
      }
      const next = argv[index + 1];
      if (next && !next.startsWith('-')) {
        flags.set(trimmed, next);
        index += 1;
        continue;
      }
      flags.set(trimmed, true);
      continue;
    }
    if (token.startsWith('-') && token.length === 2) {
      const expanded = shortFlags.get(token.slice(1));
      if (!expanded) {
        throw new CliUsageError(`Unknown flag: ${token}`);
      }
      const next = argv[index + 1];
      if (!next || next.startsWith('-')) {
        throw new CliUsageError(`Flag requires a value: ${token}`);
      }
      flags.set(expanded, next);
      index += 1;
      continue;
    }
    positionals.push(token);
  }

  if (flags.get('json') === true && !flags.has('output')) {
    flags.set('output', 'json');
  }

  return { positionals, flags };
}

function getOutputFormat(parsed: ParsedArgs, allowed: OutputFormat[]): OutputFormat {
  const value = getOptionalStringFlag(parsed, 'output') ?? 'text';
  if (!allowed.includes(value as OutputFormat)) {
    throw new CliUsageError(`Unsupported output format: ${value}`);
  }
  return value as OutputFormat;
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
    throw new CliUsageError(`Invalid value for --${name}: ${value}`);
  }
  return parsedValue;
}

function getRequiredNumber(value: string | undefined, usage: string): number {
  const normalized = normalizeString(value);
  if (!normalized) {
    throw new CliUsageError(usage);
  }
  const parsedValue = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    throw new CliUsageError(`Invalid numeric value: ${normalized}`);
  }
  return parsedValue;
}

function hasBooleanFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true;
}

function getBackend(parsed: ParsedArgs): BackendKind {
  return getOptionalBackend(parsed) ?? DEFAULT_BACKEND;
}

function getOptionalBackend(parsed: ParsedArgs): BackendKind | undefined {
  const value = getOptionalStringFlag(parsed, 'backend');
  if (!value) {
    return undefined;
  }
  if (value === 'codex' || value === 'claude_code' || value === 'remote_a2a') {
    return value;
  }
  throw new CliUsageError(`Unsupported backend: ${value}`);
}

function getOptionalRunStatus(parsed: ParsedArgs): RunStatus | undefined {
  const value = getOptionalStringFlag(parsed, 'status');
  if (!value) {
    return undefined;
  }
  if (
    value === 'queued' ||
    value === 'running' ||
    value === 'input_required' ||
    value === 'auth_required' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'rejected'
  ) {
    return value;
  }
  throw new CliUsageError(`Unsupported status: ${value}`);
}

function getOptionalCwd(parsed: ParsedArgs, io: OrchestratorCliIo): string | undefined {
  return getOptionalStringFlag(parsed, 'cwd') ?? normalizeString(io.env.ORCHESTRATOR_CWD);
}

function getCommandCwd(parsed: ParsedArgs, io: OrchestratorCliIo): string {
  const cwd = getOptionalCwd(parsed, io) ?? io.cwd;
  return path.isAbsolute(cwd) ? cwd : path.resolve(io.cwd, cwd);
}

function joinPromptPositionals(positionals: string[]): string | undefined {
  const joined = positionals.join(' ').trim();
  return joined.length > 0 ? joined : undefined;
}

async function readOptionalStdin(io: OrchestratorCliIo): Promise<string | undefined> {
  if (io.stdinIsTTY) {
    return undefined;
  }
  const text = normalizeString(await io.readStdin());
  return text;
}

function buildInputMessage(prompt: string | undefined, stdinText: string | undefined): AgentMessage {
  const parts = [];
  if (prompt) {
    parts.push({ type: 'text' as const, text: prompt });
  }
  if (stdinText) {
    parts.push({ type: 'text' as const, text: stdinText });
  }
  if (parts.length === 0) {
    throw new CliUsageError('A prompt is required. Pass text positionally, use --prompt, or pipe stdin.');
  }
  return {
    role: 'user',
    parts,
  };
}

async function resolveDefaultProfile(role: RunRole, cwd: string): Promise<string | undefined> {
  if (role !== 'reviewer') {
    return undefined;
  }

  const relativePath = path.join('profile', 'reviewer-remediator.md');
  const absolutePath = path.join(cwd, relativePath);
  try {
    await access(absolutePath, constants.R_OK);
    return absolutePath;
  } catch {
    return undefined;
  }
}

async function readJsonFile(filePath: string, cwd: string): Promise<Record<string, unknown>> {
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  const raw = await readFile(resolvedPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliUsageError(`JSON schema must be an object: ${resolvedPath}`);
  }
  return parsed as Record<string, unknown>;
}

function parseMetadata(parsed: ParsedArgs): Record<string, unknown> | undefined {
  const raw = getOptionalStringFlag(parsed, 'metadata');
  if (!raw) {
    return undefined;
  }

  const metadata: Record<string, unknown> = {};
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) {
      continue;
    }
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) {
      throw new CliUsageError(`Invalid --metadata entry: ${trimmed}`);
    }
    metadata[trimmed.slice(0, eqIndex)] = trimmed.slice(eqIndex + 1);
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function requirePositional(value: string | undefined, usage: string): string {
  const normalized = normalizeString(value);
  if (!normalized) {
    throw new CliUsageError(usage);
  }
  return normalized;
}

function normalizeString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function isCliStopStatus(status: RunStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'rejected' ||
    status === 'input_required' ||
    status === 'auth_required'
  );
}

function exitCodeForRunStatus(status: RunStatus): number {
  switch (status) {
    case 'completed':
      return EXIT_SUCCESS;
    case 'cancelled':
      return EXIT_RUN_CANCELLED;
    case 'input_required':
    case 'auth_required':
      return EXIT_RUN_NEEDS_INPUT;
    case 'failed':
    case 'rejected':
      return EXIT_RUN_FAILED;
    default:
      return EXIT_SUCCESS;
  }
}

function formatRunSummaryText(run: GetRunResult): string {
  return [
    `run_id: ${run.run_id}`,
    `status: ${run.status}`,
    `role: ${run.role}`,
    `backend: ${run.backend}`,
    `agent_name: ${run.agent_name}`,
    `session_id: ${run.session_id}`,
    `cwd: ${run.cwd}`,
    `started_at: ${run.started_at}`,
    `updated_at: ${run.updated_at}`,
    `last_seq: ${run.last_seq}`,
    `summary: ${run.summary}`,
    `metadata: ${JSON.stringify(run.metadata)}`,
  ].join('\n') + '\n';
}

function formatSpawnRunText(spawn: SpawnRunResult): string {
  return [
    `run_id: ${spawn.run_id}`,
    `status: ${spawn.status}`,
    `role: ${spawn.role}`,
    `backend: ${spawn.backend}`,
    `agent_name: ${spawn.agent_name}`,
    `session_id: ${spawn.session_id}`,
  ].join('\n') + '\n';
}

function formatContinueRunText(result: ContinueRunResult): string {
  return [
    `run_id: ${result.run_id}`,
    `status: ${result.status}`,
    `session_id: ${result.session_id ?? ''}`,
    `agent_name: ${result.agent_name ?? ''}`,
    `mode: ${result.mode ?? ''}`,
    `resumed_from_run_id: ${result.resumed_from_run_id ?? ''}`,
  ].join('\n') + '\n';
}

function formatCancelRunText(result: CancelRunResult): string {
  return [
    `run_id: ${result.run_id}`,
    `status: ${result.status}`,
    `cancelled_at: ${result.cancelled_at}`,
  ].join('\n') + '\n';
}

function formatDaemonStatusText(result: DaemonStatus | DaemonStartResult): string {
  const lines = [`status: ${result.status}`];
  if ('created' in result) {
    lines.push(`created: ${String(result.created)}`);
  }
  if (result.daemon) {
    lines.push(`pid: ${result.daemon.pid}`);
    lines.push(`socket_path: ${result.daemon.socket_path}`);
    lines.push(`started_at: ${result.daemon.started_at}`);
  }
  if (result.reason) {
    lines.push(`reason: ${result.reason}`);
  }
  return `${lines.join('\n')}\n`;
}

function formatDaemonStopText(result: DaemonStopResult): string {
  return [
    `stopped: ${String(result.stopped)}`,
    `previously_running: ${String(result.previously_running)}`,
  ].join('\n') + '\n';
}

function writeJsonOrText(
  stdout: Pick<NodeJS.WriteStream, 'write'>,
  output: Exclude<OutputFormat, 'jsonl'>,
  payload: unknown,
  text: string,
): void {
  if (output === 'json') {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  stdout.write(text);
}

function formatEventText(event: NormalizedEvent, renderedAgentMessages: Set<number>): string | null {
  const text = extractEventText(event);
  switch (event.type) {
    case 'run_started':
      return `Run started (${event.backend})`;
    case 'status_changed':
      return `[${String(event.data.status ?? 'updated')}] ${text ?? 'status updated'}`;
    case 'agent_message':
      renderedAgentMessages.add(event.seq);
      return text ?? 'Agent sent a message';
    case 'message_added':
      return renderedAgentMessages.has(event.seq) ? null : text;
    case 'reasoning':
      return text ? `Thinking: ${text}` : 'Thinking...';
    case 'command_started':
      return `Running: ${String(event.data.command ?? 'command')}`;
    case 'command_updated':
      return null;
    case 'command_finished': {
      const command = String(event.data.command ?? 'command');
      const exitCode = typeof event.data.exit_code === 'number' ? ` (exit ${event.data.exit_code})` : '';
      return `Command finished: ${command}${exitCode}`;
    }
    case 'file_changed': {
      const count = Array.isArray(event.data.changes) ? event.data.changes.length : undefined;
      return count !== undefined ? `Updated ${count} file(s)` : 'Files changed';
    }
    case 'tool_started':
      return `Calling tool: ${String(event.data.tool ?? 'tool')}`;
    case 'tool_finished':
      return `Tool finished: ${String(event.data.tool ?? 'tool')}`;
    case 'artifact_added':
      return `Artifact added: ${String(event.data.name ?? event.data.artifact_id ?? 'artifact')}`;
    case 'todo_updated':
      return text ?? 'Updated task checklist';
    case 'input_required':
      return `Input required: ${text ?? 'awaiting additional input'}`;
    case 'auth_required':
      return `Auth required: ${text ?? 'authentication required'}`;
    case 'rejected':
      return `Run rejected: ${text ?? 'request rejected'}`;
    case 'run_completed':
      return text ?? 'Run completed';
    case 'run_failed':
      return `Run failed: ${text ?? 'unexpected error'}`;
    default:
      return text ?? event.type;
  }
}

function extractEventText(event: NormalizedEvent): string | null {
  const candidates: unknown[] = [
    event.data.text,
    event.data.message,
    event.data.final_response,
    event.data.summary,
    event.data.description,
    event.data.output,
  ];
  for (const candidate of candidates) {
    const text = renderUnknownText(candidate);
    if (text) {
      return text;
    }
  }
  return null;
}

function renderUnknownText(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }
  if (Array.isArray(value)) {
    const parts = value.map(renderUnknownText).filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(' ') : null;
  }
  if (value && typeof value === 'object') {
    const maybeParts = (value as { parts?: unknown }).parts;
    if (Array.isArray(maybeParts)) {
      const parts = maybeParts
        .map((part) => {
          if (!part || typeof part !== 'object') {
            return null;
          }
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text.trim() : null;
        })
        .filter((part): part is string => Boolean(part));
      return parts.length > 0 ? parts.join(' ') : null;
    }
  }
  return null;
}

function printUsage(stderr: Pick<NodeJS.WriteStream, 'write'>): void {
  stderr.write(`Usage:
  orchestrator ask <prompt> [--backend BACKEND] [--cwd CWD] [--name AGENT_NAME] [--resume SESSION_ID] [--profile PATH] [--schema PATH] [--detach] [--output text|json|jsonl]
  orchestrator run <prompt> [--backend BACKEND] [--cwd CWD] [--name AGENT_NAME] [--resume SESSION_ID] [--profile PATH] [--schema PATH] [--detach] [--output text|json|jsonl]
  orchestrator review <prompt> [--backend BACKEND] [--cwd CWD] [--name AGENT_NAME] [--resume SESSION_ID] [--profile PATH] [--schema PATH] [--detach] [--output text|json|jsonl]
  orchestrator runs list [--cwd CWD] [--backend BACKEND] [--status STATUS] [--output text|json]
  orchestrator runs show <run-id> [--output text|json]
  orchestrator runs continue <run-id> <prompt> [--output text|json]
  orchestrator runs cancel <run-id> [--output text|json]
  orchestrator events tail <run-id> [--after SEQ] [--limit N] [--timeout MS] [--output text|json|jsonl]
  orchestrator artifacts get <run-id> <seq> <field-path> [--offset N] [--limit N] [--output-file PATH] [--output text|json]
  orchestrator daemon <start|status|stop> [--output text|json]
`);
}

function defaultCliDeps(): OrchestratorCliDeps {
  return {
    createApp: () => createOrchestratorApp(),
    createDetachedClient: () => new DetachedOrchestratorClient(),
  };
}

function defaultCliIo(): OrchestratorCliIo {
  return {
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: process.cwd(),
    stdinIsTTY: process.stdin.isTTY ?? false,
    readStdin: () => readProcessStdin(process.stdin),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

async function readProcessStdin(stream: NodeJS.ReadStream): Promise<string> {
  const chunks: string[] = [];
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks.join('');
}

type OutputFormat = 'text' | 'json' | 'jsonl';

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

class CliUsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT_USAGE);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const exitCode = await runOrchestratorCli(argv);
  process.exitCode = exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
