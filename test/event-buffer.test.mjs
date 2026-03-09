import test from 'node:test';
import assert from 'node:assert/strict';

import { EventBuffer } from '../dist/core/event-buffer.js';

test('EventBuffer returns immediately when events already exist', async () => {
  const buffer = new EventBuffer();
  buffer.append({
    seq: 1,
    ts: new Date().toISOString(),
    run_id: 'run-1',
    session_id: 'session-1',
    backend: 'codex',
    type: 'run_started',
    data: {},
  });

  const events = await buffer.waitForAfter(0, 100, 1000);
  assert.equal(events.length, 1);
  assert.equal(events[0].seq, 1);
});

test('EventBuffer long-poll resolves when a later event arrives', async () => {
  const buffer = new EventBuffer();
  const pending = buffer.waitForAfter(0, 100, 1000);

  setTimeout(() => {
    buffer.append({
      seq: 1,
      ts: new Date().toISOString(),
      run_id: 'run-1',
      session_id: 'session-1',
      backend: 'codex',
      type: 'status_changed',
      data: { status: 'running' },
    });
  }, 20);

  const events = await pending;
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'status_changed');
});
