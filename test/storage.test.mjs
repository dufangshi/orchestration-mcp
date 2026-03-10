import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';

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
