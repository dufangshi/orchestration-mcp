import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';

import { Storage } from '../dist/core/storage.js';

test('Storage writes artifact manifests and splits large content into 64 KiB chunks', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-storage-'));
  const storage = new Storage();
  const payload = 'X'.repeat(150_000);

  const refs = await storage.writeArtifacts(
    cwd,
    'run-1',
    { seq: 8, type: 'command_finished' },
    [
      {
        field_path: '/stdout',
        mime: 'text/plain',
        encoding: 'utf-8',
        content: payload,
        total_chars: payload.length,
        truncated: true,
      },
    ],
  );

  assert.equal(refs['/stdout'].chunk_count, 3);
  assert.equal(refs['/stdout'].total_bytes, payload.length);

  const manifestPath = path.join(
    cwd,
    '.nanobot-orchestrator',
    'runs',
    'run-1',
    'artifacts',
    '000008-command_finished',
    'manifest.json',
  );
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  assert.equal(manifest.seq, 8);
  assert.equal(manifest.event_type, 'command_finished');
  assert.equal(manifest.fields['/stdout'].chunk_count, 3);
  assert.equal(manifest.fields['/stdout'].chunks.length, 3);
  assert.equal(manifest.fields['/stdout'].mime, 'text/plain');
});

test('Storage readEventArtifact reconstructs paged text slices from chunk files', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-storage-read-'));
  const storage = new Storage();
  const payload = '0123456789'.repeat(10_000);

  await storage.writeArtifacts(
    cwd,
    'run-1',
    { seq: 11, type: 'tool_finished' },
    [
      {
        field_path: '/stdout',
        mime: 'text/plain',
        encoding: 'utf-8',
        content: payload,
        total_chars: payload.length,
        truncated: true,
      },
    ],
  );

  const slice = await storage.readEventArtifact(cwd, 'run-1', 11, '/stdout', 1234, 4096);
  assert.equal(slice.content, payload.slice(1234, 1234 + 4096));
  assert.equal(slice.offset, 1234);
  assert.equal(slice.returned_bytes, 4096);
  assert.equal(slice.has_more, true);
});

test('Storage readEventArtifact returns compact JSON text for structured artifacts', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-storage-json-'));
  const storage = new Storage();
  const value = { changes: Array.from({ length: 200 }, (_, index) => ({ file: `src/${index}.ts` })) };
  const payload = JSON.stringify(value);

  await storage.writeArtifacts(
    cwd,
    'run-1',
    { seq: 12, type: 'tool_finished' },
    [
      {
        field_path: '/raw_tool_use_result',
        mime: 'application/json',
        encoding: 'utf-8',
        content: payload,
        truncated: true,
      },
    ],
  );

  const result = await storage.readEventArtifact(
    cwd,
    'run-1',
    12,
    '/raw_tool_use_result',
    0,
    65_536,
  );

  assert.equal(result.mime, 'application/json');
  assert.deepEqual(JSON.parse(result.content), value);
  assert.equal(result.has_more, false);
});

test('Storage can resolve runs and events by run_id through the global registry', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-storage-registry-'));
  const storage = new Storage();
  const runRecord = {
    runId: `run-${Date.now()}`,
    backend: 'codex',
    role: 'worker',
    sessionId: 'session-1',
    status: 'completed',
    cwd,
    prompt: 'hello',
    metadata: {},
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    lastSeq: 1,
    summary: 'done',
    result: { finalResponse: 'done' },
    error: null,
  };
  const event = {
    seq: 1,
    ts: new Date().toISOString(),
    run_id: runRecord.runId,
    session_id: 'session-1',
    backend: 'codex',
    type: 'run_completed',
    data: { final_response: 'done' },
  };

  await storage.writeRunRecord(runRecord);
  await storage.appendEvent(cwd, runRecord.runId, event);

  assert.equal(await storage.resolveRunCwd(runRecord.runId), cwd);

  const loadedRecord = await storage.readRunRecordById(runRecord.runId);
  assert.equal(loadedRecord?.runId, runRecord.runId);

  const loadedEvents = await storage.readEventsById(runRecord.runId, 0, 10);
  assert.equal(loadedEvents.length, 1);
  assert.equal(loadedEvents[0].seq, 1);

  const listed = await storage.listRunRecords({ cwd });
  assert.equal(listed.some((record) => record.runId === runRecord.runId), true);
});

test('Storage recovers from a malformed concatenated registry file', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-storage-home-'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-storage-recover-'));
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    const registryDir = path.join(homeDir, '.nanobot-orchestrator');
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      path.join(registryDir, 'registry.json'),
      `{
  "runs": {
    "good-run": {
      "cwd": "${cwd}",
      "updated_at": "2026-03-13T00:00:00.000Z"
    }
  }
}
garbage-tail`,
      'utf8',
    );

    const storage = new Storage();
    assert.equal(await storage.resolveRunCwd('good-run'), cwd);

    const healed = JSON.parse(await readFile(path.join(registryDir, 'registry.json'), 'utf8'));
    assert.equal(healed.runs['good-run'].cwd, cwd);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});
