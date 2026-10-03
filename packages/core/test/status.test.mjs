import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveStatus, DEFAULT_WINDOWS } from '../dist/index.js';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

test('a session that just wrote is active', () => {
  assert.equal(deriveStatus({ lastActivityAt: ago(5_000), pendingToolCalls: 0, now: NOW }), 'active');
});

test('a quiet session with an unanswered tool call is waiting on a human', () => {
  assert.equal(deriveStatus({ lastActivityAt: ago(5 * 60_000), pendingToolCalls: 1, now: NOW }), 'waiting');
});

test('waiting outranks idle, because it is the state worth interrupting someone for', () => {
  const quiet = ago(5 * 60_000);
  assert.equal(deriveStatus({ lastActivityAt: quiet, pendingToolCalls: 0, now: NOW }), 'idle');
  assert.equal(deriveStatus({ lastActivityAt: quiet, pendingToolCalls: 2, now: NOW }), 'waiting');
});

test('an unanswered tool call does not keep a long-dead session "waiting" forever', () => {
  assert.equal(deriveStatus({ lastActivityAt: ago(5 * 86_400_000), pendingToolCalls: 3, now: NOW }), 'done');
});

test('activity inside the active window beats a pending call', () => {
  assert.equal(deriveStatus({ lastActivityAt: ago(1_000), pendingToolCalls: 9, now: NOW }), 'active');
});

test('an unparseable timestamp is treated as long gone, not as now', () => {
  assert.equal(deriveStatus({ lastActivityAt: 'not a date', pendingToolCalls: 0, now: NOW }), 'done');
});

test('the windows are configurable', () => {
  const tight = { activeMs: 1_000, idleMs: 2_000 };
  assert.equal(deriveStatus({ lastActivityAt: ago(1_500), pendingToolCalls: 0, now: NOW, windows: tight }), 'idle');
  assert.equal(deriveStatus({ lastActivityAt: ago(1_500), pendingToolCalls: 0, now: NOW, windows: DEFAULT_WINDOWS }), 'active');
});
