import { mkdir, appendFile, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

import type {
  AgentInboxMessage,
  ArtifactRef,
  ArtifactWriteInstruction,
  GetEventArtifactResult,
  NormalizedEvent,
  RunRecord,
  RunResult,
  SessionRecord,
} from './types.js';

const ROOT_DIR = '.nanobot-orchestrator';
const ARTIFACT_CHUNK_BYTES = 64 * 1024;
const REGISTRY_LOCK_RETRY_MS = 25;
const REGISTRY_LOCK_TIMEOUT_MS = 5000;
const REGISTRY_LOCK_STALE_MS = 30000;

interface ArtifactChunkRecord {
  file: string;
  bytes: number;
}

interface ArtifactManifestField {
  field_path: string;
  relpath: string;
  mime: string;
  encoding: string;
  total_bytes: number;
  total_chars?: number;
  chunk_count: number;
  truncated: boolean;
  chunks: ArtifactChunkRecord[];
}

interface ArtifactManifest {
  seq: number;
  event_type: string;
  fields: Record<string, ArtifactManifestField>;
}

interface RunRegistryEntry {
  cwd: string;
  updated_at: string;
}

interface RunRegistry {
  runs: Record<string, RunRegistryEntry>;
}

export class Storage {
  getRootDir(cwd: string): string {
    return path.join(cwd, ROOT_DIR);
  }

  getRunsDir(cwd: string): string {
    return path.join(this.getRootDir(cwd), 'runs');
  }

  getRunDir(cwd: string, runId: string): string {
    return path.join(this.getRunsDir(cwd), runId);
  }

  getArtifactsDir(cwd: string, runId: string): string {
    return path.join(this.getRunDir(cwd, runId), 'artifacts');
  }

  getSessionsDir(cwd: string): string {
    return path.join(this.getRootDir(cwd), 'sessions');
  }

  getSessionPath(cwd: string, sessionId: string): string {
    return path.join(this.getSessionsDir(cwd), `${sessionId}.json`);
  }

  getSessionInboxPath(cwd: string, sessionId: string): string {
    return path.join(this.getSessionsDir(cwd), `${sessionId}.inbox.jsonl`);
  }

  getRegistryPath(): string {
    return path.join(homedir(), ROOT_DIR, 'registry.json');
  }

  async validateCwd(cwd: string): Promise<void> {
    const info = await stat(cwd);
    if (!info.isDirectory()) {
      throw new Error(`cwd is not a directory: ${cwd}`);
    }
  }

  async writeRunRecord(record: RunRecord): Promise<void> {
    await this.registerRun(record.cwd, record.runId);
    const runDir = this.getRunDir(record.cwd, record.runId);
    await mkdir(runDir, { recursive: true });
    await writeJson(path.join(runDir, 'run.json'), record);
  }

  async readRunRecord(cwd: string, runId: string): Promise<RunRecord | null> {
    try {
      const raw = await readFile(path.join(this.getRunDir(cwd, runId), 'run.json'), 'utf8');
      return JSON.parse(raw) as RunRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async readRunRecordById(runId: string): Promise<RunRecord | null> {
    const cwd = await this.resolveRunCwd(runId);
    if (!cwd) {
      return null;
    }
    return this.readRunRecord(cwd, runId);
  }

  async listRunRecords(filters: {
    cwd?: string;
    backend?: RunRecord['backend'];
    status?: RunRecord['status'];
  } = {}): Promise<RunRecord[]> {
    const registry = await this.readRegistry();
    const records: RunRecord[] = [];

    for (const [runId, entry] of Object.entries(registry.runs)) {
      if (filters.cwd && entry.cwd !== filters.cwd) {
        continue;
      }
      const record = await this.readRunRecord(entry.cwd, runId);
      if (!record) {
        continue;
      }
      if (filters.backend && record.backend !== filters.backend) {
        continue;
      }
      if (filters.status && record.status !== filters.status) {
        continue;
      }
      records.push(record);
    }

    records.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    return records;
  }

  async appendEvent(cwd: string, runId: string, event: NormalizedEvent): Promise<void> {
    await this.registerRun(cwd, runId);
    const runDir = this.getRunDir(cwd, runId);
    await mkdir(runDir, { recursive: true });
    await appendFile(path.join(runDir, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
  }

  async readEvents(
    cwd: string,
    runId: string,
    afterSeq: number,
    limit: number,
  ): Promise<NormalizedEvent[]> {
    try {
      const raw = await readFile(path.join(this.getRunDir(cwd, runId), 'events.jsonl'), 'utf8');
      return raw.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as NormalizedEvent).filter((event) => event.seq > afterSeq).slice(0, limit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async readEventsById(runId: string, afterSeq: number, limit: number): Promise<NormalizedEvent[]> {
    const cwd = await this.resolveRunCwd(runId);
    if (!cwd) {
      return [];
    }
    return this.readEvents(cwd, runId, afterSeq, limit);
  }

  async writeArtifacts(
    cwd: string,
    runId: string,
    event: Pick<NormalizedEvent, 'seq' | 'type'>,
    artifacts: ArtifactWriteInstruction[],
  ): Promise<Record<string, ArtifactRef>> {
    if (artifacts.length === 0) {
      return {};
    }

    await this.registerRun(cwd, runId);
    const eventDirSegment = eventDirName(event.seq, event.type);
    const eventDir = path.join(this.getArtifactsDir(cwd, runId), eventDirSegment);
    await mkdir(eventDir, { recursive: true });

    const relManifestPath = path.join('artifacts', eventDirSegment, 'manifest.json');
    const manifest: ArtifactManifest = {
      seq: event.seq,
      event_type: event.type,
      fields: {},
    };

    const refs: Record<string, ArtifactRef> = {};
    for (const artifact of artifacts) {
      const buffer = Buffer.from(artifact.content, 'utf8');
      const fieldBase = sanitizeArtifactName(artifact.field_path.replace(/^\//, '').replaceAll('/', '.'));
      const chunks: ArtifactChunkRecord[] = [];
      for (let index = 0; index < Math.max(1, Math.ceil(buffer.length / ARTIFACT_CHUNK_BYTES)); index += 1) {
        const start = index * ARTIFACT_CHUNK_BYTES;
        const slice = buffer.subarray(start, start + ARTIFACT_CHUNK_BYTES);
        const extension = artifact.mime === 'application/json' ? 'json' : 'txt';
        const file = `${fieldBase}.${String(index + 1).padStart(4, '0')}.${extension}`;
        await writeFile(path.join(eventDir, file), slice);
        chunks.push({ file, bytes: slice.length });
      }

      const field: ArtifactManifestField = {
        field_path: artifact.field_path,
        relpath: relManifestPath,
        mime: artifact.mime,
        encoding: artifact.encoding,
        total_bytes: buffer.length,
        total_chars: artifact.total_chars,
        chunk_count: chunks.length,
        truncated: artifact.truncated,
        chunks,
      };
      manifest.fields[artifact.field_path] = field;
      refs[artifact.field_path] = {
        field_path: field.field_path,
        relpath: field.relpath,
        mime: field.mime,
        encoding: field.encoding,
        total_bytes: field.total_bytes,
        total_chars: field.total_chars,
        chunk_count: field.chunk_count,
        truncated: field.truncated,
      };
    }

    await writeJson(path.join(eventDir, 'manifest.json'), manifest);
    return refs;
  }

  async readEventArtifact(
    cwd: string,
    runId: string,
    seq: number,
    fieldPath: string,
    offset: number,
    limit: number,
  ): Promise<GetEventArtifactResult> {
    const manifest = await this.readArtifactManifest(cwd, runId, seq);
    const field = manifest.fields[fieldPath];
    if (!field) {
      throw new Error(
        `No artifact for field_path ${fieldPath}. Available field paths: ${Object.keys(manifest.fields).join(', ') || '(none)'}`,
      );
    }

    const eventDir = path.join(this.getArtifactsDir(cwd, runId), eventDirName(seq, manifest.event_type));
    const buffer = await readFieldBuffer(eventDir, field, offset, limit);
    return {
      run_id: runId,
      seq,
      field_path: fieldPath,
      mime: field.mime,
      encoding: field.encoding,
      relpath: field.relpath,
      total_bytes: field.total_bytes,
      offset,
      returned_bytes: buffer.length,
      has_more: offset + buffer.length < field.total_bytes,
      content: buffer.toString('utf8'),
    };
  }

  async readEventArtifactById(
    runId: string,
    seq: number,
    fieldPath: string,
    offset: number,
    limit: number,
  ): Promise<GetEventArtifactResult> {
    const cwd = await this.resolveRunCwd(runId);
    if (!cwd) {
      throw new Error(`Unknown run_id: ${runId}`);
    }
    return this.readEventArtifact(cwd, runId, seq, fieldPath, offset, limit);
  }

  async writeResult(cwd: string, runId: string, result: RunResult | null): Promise<void> {
    await this.registerRun(cwd, runId);
    const runDir = this.getRunDir(cwd, runId);
    await mkdir(runDir, { recursive: true });
    await writeJson(path.join(runDir, 'result.json'), result);
  }

  async writeSessionRecord(record: SessionRecord): Promise<void> {
    const sessionsDir = this.getSessionsDir(record.cwd);
    await mkdir(sessionsDir, { recursive: true });
    await writeJson(this.getSessionPath(record.cwd, record.sessionId), record);
  }

  async readSessionRecord(cwd: string, sessionId: string): Promise<SessionRecord | null> {
    try {
      const raw = await readFile(this.getSessionPath(cwd, sessionId), 'utf8');
      return JSON.parse(raw) as SessionRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async listSessionRecords(cwd?: string): Promise<SessionRecord[]> {
    const allCwds = cwd ? [cwd] : await this.listKnownCwds();
    const records: SessionRecord[] = [];
    for (const itemCwd of allCwds) {
      records.push(...(await this.readSessionRecordsForCwd(itemCwd)));
    }
    records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return records;
  }

  async appendInboxMessage(cwd: string, sessionId: string, message: Omit<AgentInboxMessage, 'seq'>): Promise<AgentInboxMessage> {
    const sessionsDir = this.getSessionsDir(cwd);
    await mkdir(sessionsDir, { recursive: true });
    const inboxPath = this.getSessionInboxPath(cwd, sessionId);
    const seq = await this.getNextInboxSeq(inboxPath);
    const fullMessage: AgentInboxMessage = {
      ...message,
      seq,
    };
    await appendFile(inboxPath, `${JSON.stringify(fullMessage)}\n`, 'utf8');
    return fullMessage;
  }

  async readInboxMessages(
    cwd: string,
    sessionId: string,
    afterSeq: number,
    limit: number,
  ): Promise<AgentInboxMessage[]> {
    try {
      const raw = await readFile(this.getSessionInboxPath(cwd, sessionId), 'utf8');
      return raw
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as AgentInboxMessage)
        .filter((message) => message.seq > afterSeq)
        .slice(0, limit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async resolveRunCwd(runId: string): Promise<string | null> {
    const registry = await this.readRegistry();
    return registry.runs[runId]?.cwd ?? null;
  }

  private async listKnownCwds(): Promise<string[]> {
    const registry = await this.readRegistry();
    return [...new Set(Object.values(registry.runs).map((entry) => entry.cwd))].sort();
  }

  private async readSessionRecordsForCwd(cwd: string): Promise<SessionRecord[]> {
    try {
      const entries = await readdir(this.getSessionsDir(cwd), { withFileTypes: true });
      const records = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.inbox.jsonl'))
          .map(async (entry) => {
            const raw = await readFile(path.join(this.getSessionsDir(cwd), entry.name), 'utf8');
            return JSON.parse(raw) as SessionRecord;
          }),
      );
      records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async getNextInboxSeq(inboxPath: string): Promise<number> {
    try {
      const raw = await readFile(inboxPath, 'utf8');
      const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
      if (lines.length === 0) {
        return 1;
      }
      const last = JSON.parse(lines.at(-1) ?? '{}') as Partial<AgentInboxMessage>;
      return typeof last.seq === 'number' ? last.seq + 1 : 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 1;
      }
      throw error;
    }
  }

  private async registerRun(cwd: string, runId: string): Promise<void> {
    await this.updateRegistry((registry) => {
      registry.runs[runId] = {
        cwd,
        updated_at: new Date().toISOString(),
      };
      return registry;
    });
  }

  private async readRegistry(): Promise<RunRegistry> {
    const registryPath = this.getRegistryPath();
    try {
      const raw = await readFile(registryPath, 'utf8');
      const parsed = parseRegistryText(raw);
      if (parsed.recovered) {
        await this.writeRegistry(parsed.registry);
      }
      return parsed.registry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { runs: {} };
      }
      throw error;
    }
  }

  private async writeRegistry(registry: RunRegistry): Promise<void> {
    const registryPath = this.getRegistryPath();
    await mkdir(path.dirname(registryPath), { recursive: true });
    await writeJsonAtomic(registryPath, registry);
  }

  private async updateRegistry(
    updater: (registry: RunRegistry) => RunRegistry | Promise<RunRegistry>,
  ): Promise<void> {
    await this.withRegistryLock(async () => {
      const registry = await this.readRegistry();
      const nextRegistry = await updater(registry);
      await this.writeRegistry(nextRegistry);
    });
  }

  private async withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.getRegistryPath()}.lock`;
    const startedAt = Date.now();
    await mkdir(path.dirname(lockPath), { recursive: true });

    while (true) {
      try {
        await mkdir(lockPath);
        break;
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        if (errno.code !== 'EEXIST') {
          throw error;
        }

        const lockInfo = await stat(lockPath).catch(() => null);
        if (lockInfo && Date.now() - lockInfo.mtimeMs > REGISTRY_LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }

        if (Date.now() - startedAt > REGISTRY_LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out acquiring registry lock: ${lockPath}`);
        }

        await sleep(REGISTRY_LOCK_RETRY_MS);
      }
    }

    try {
      return await fn();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  private async readArtifactManifest(cwd: string, runId: string, seq: number): Promise<ArtifactManifest> {
    const artifactsDir = this.getArtifactsDir(cwd, runId);
    const prefix = `${String(seq).padStart(6, '0')}-`;
    let entries: string[];
    try {
      entries = await readdir(artifactsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`No artifacts found for seq ${seq}`);
      }
      throw error;
    }

    const matches = entries.filter((entry) => entry.startsWith(prefix)).sort();
    if (matches.length === 0) {
      throw new Error(`No artifacts found for seq ${seq}`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple artifact directories found for seq ${seq}: ${matches.join(', ')}`);
    }

    const raw = await readFile(path.join(artifactsDir, matches[0], 'manifest.json'), 'utf8');
    return JSON.parse(raw) as ArtifactManifest;
  }
}

async function readFieldBuffer(
  eventDir: string,
  field: ArtifactManifestField,
  offset: number,
  limit: number,
): Promise<Buffer> {
  if (offset >= field.total_bytes) {
    return Buffer.alloc(0);
  }

  const targetEnd = Math.min(field.total_bytes, offset + limit);
  let cursor = 0;
  const buffers: Buffer[] = [];

  for (const chunk of field.chunks) {
    const chunkStart = cursor;
    const chunkEnd = cursor + chunk.bytes;
    cursor = chunkEnd;

    if (chunkEnd <= offset || chunkStart >= targetEnd) {
      continue;
    }

    const raw = await readFile(path.join(eventDir, chunk.file));
    const sliceStart = Math.max(0, offset - chunkStart);
    const sliceEnd = Math.min(raw.length, targetEnd - chunkStart);
    buffers.push(raw.subarray(sliceStart, sliceEnd));
  }

  return Buffer.concat(buffers);
}

function eventDirName(seq: number, eventType: string): string {
  return `${String(seq).padStart(6, '0')}-${sanitizeArtifactName(eventType)}`;
}

function sanitizeArtifactName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized || 'artifact';
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}
`, 'utf8');
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeJson(tempPath, value);
  await rename(tempPath, filePath);
}

function parseRegistryText(raw: string): { registry: RunRegistry; recovered: boolean } {
  const normalized = raw.trim();
  if (!normalized) {
    return {
      registry: { runs: {} },
      recovered: false,
    };
  }

  try {
    return {
      registry: normalizeRegistry(JSON.parse(normalized) as Partial<RunRegistry>),
      recovered: false,
    };
  } catch (error) {
    const recovered = extractFirstJsonObject(normalized);
    if (!recovered) {
      throw error;
    }
    return {
      registry: normalizeRegistry(JSON.parse(recovered) as Partial<RunRegistry>),
      recovered: true,
    };
  }
}

function normalizeRegistry(parsed: Partial<RunRegistry>): RunRegistry {
  return {
    runs: parsed.runs ?? {},
  };
}

function extractFirstJsonObject(raw: string): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (!started) {
      if (/\s/.test(char)) {
        continue;
      }
      if (char !== '{') {
        return null;
      }
      started = true;
      depth = 1;
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(0, index + 1);
      }
    }
  }

  return null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
