import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeEvent } from '../dist/core/event-sanitizer.js';

function makeEvent(type, data) {
  return {
    seq: 1,
    ts: new Date().toISOString(),
    run_id: 'run-1',
    session_id: 'session-1',
    backend: 'codex',
    type,
    data,
  };
}

test('sanitizeEvent moves large stdout into an artifact and keeps a preview inline', () => {
  const stdout = 'A'.repeat(5000);
  const { event, artifacts } = sanitizeEvent(
    makeEvent('command_finished', {
      command: 'npm test',
      stdout,
      exit_code: 0,
    }),
  );

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].field_path, '/stdout');
  assert.equal(artifacts[0].content, stdout);
  assert.match(event.data.stdout, /truncated, see artifact_refs/);
  assert.equal(event.data.command, 'npm test');
  assert.equal(event.data.exit_code, 0);
});

test('sanitizeEvent moves large Read results into a JSON artifact summary', () => {
  const rawToolUseResult = {
    content: 'B'.repeat(7000),
    file_path: '/tmp/project/README.md',
    kind: 'read_result',
  };
  const { event, artifacts } = sanitizeEvent(
    makeEvent('tool_finished', {
      tool: 'Read',
      raw_tool_use_result: rawToolUseResult,
    }),
  );

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].field_path, '/raw_tool_use_result');
  assert.equal(artifacts[0].mime, 'application/json');
  assert.deepEqual(event.data.raw_tool_use_result, {
    artifact_summary: {
      original_type: 'object',
      key_count: 3,
      preview_keys: ['content', 'file_path', 'kind'],
    },
  });
});

test('sanitizeEvent moves large Write input content into a text artifact', () => {
  const content = 'C'.repeat(3000);
  const { event, artifacts } = sanitizeEvent(
    makeEvent('tool_started', {
      tool: 'Write',
      input: {
        file_path: '/tmp/project/src/app.ts',
        content,
      },
    }),
  );

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].field_path, '/input/content');
  assert.equal(artifacts[0].content, content);
  assert.match(event.data.input.content, /truncated, see artifact_refs/);
  assert.equal(event.data.input.file_path, '/tmp/project/src/app.ts');
});

test('sanitizeEvent keeps small payloads inline', () => {
  const { event, artifacts } = sanitizeEvent(
    makeEvent('agent_message', {
      text: 'short update',
      status: 'running',
    }),
  );

  assert.equal(artifacts.length, 0);
  assert.equal(event.data.text, 'short update');
  assert.equal(event.data.artifact_refs, undefined);
});
