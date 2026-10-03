import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseTranscript } from '../dist/index.js';

const jsonl = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';

async function writeTranscript(records, name = 'sess-1.jsonl') {
  const dir = await mkdtemp(join(tmpdir(), 'pebble-test-'));
  const path = join(dir, name);
  await writeFile(path, typeof records === 'string' ? records : jsonl(records));
  return { dir, path };
}

const assistant = (overrides = {}) => ({
  type: 'assistant',
  uuid: overrides.uuid ?? 'a1',
  timestamp: '2026-10-02T12:00:00.000Z',
  sessionId: 'sess-1',
  cwd: '/Users/me/work/thing',
  requestId: overrides.requestId ?? 'req_1',
  message: {
    id: overrides.messageId ?? 'msg_1',
    role: 'assistant',
    model: overrides.model ?? 'claude-opus-5',
    content: overrides.content ?? [{ type: 'text', text: 'ok' }],
    usage: overrides.usage,
  },
  ...('isSidechain' in overrides ? { isSidechain: overrides.isSidechain } : {}),
});

// Output-only on purpose, so the expected dollar figures below are exact and a
// test failure means the cost logic changed, not that the fixture drifted.
const USAGE = {
  input_tokens: 0,
  output_tokens: 1_000_000,
  cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
};

test('usage repeated across records of one API response is counted once', async () => {
  // Claude Code writes one record per content block, each carrying an identical
  // copy of `usage`. Summing them all inflates cost by the number of blocks.
  const { path } = await writeTranscript([
    assistant({ uuid: 'a1', messageId: 'msg_1', usage: USAGE }),
    assistant({ uuid: 'a2', messageId: 'msg_1', usage: USAGE }),
    assistant({ uuid: 'a3', messageId: 'msg_1', usage: USAGE }),
  ]);
  const parsed = await parseTranscript(path);
  assert.equal(parsed.summary.tokens.output, 1_000_000, 'three copies of one usage block must count once');
  assert.equal(parsed.summary.assistantTurns, 1);
  assert.equal(parsed.summary.cost.usd, 25, 'Opus 5 output at $25/MTok');
});

test('distinct API responses are each counted', async () => {
  const { path } = await writeTranscript([
    assistant({ uuid: 'a1', messageId: 'msg_1', usage: USAGE }),
    assistant({ uuid: 'a2', messageId: 'msg_2', usage: USAGE }),
  ]);
  const parsed = await parseTranscript(path);
  assert.equal(parsed.summary.tokens.output, 2_000_000);
  assert.equal(parsed.summary.assistantTurns, 2);
});

test('tool calls are paired with their results, and unpaired ones are pending', async () => {
  const { path } = await writeTranscript([
    assistant({
      uuid: 'a1',
      messageId: 'msg_1',
      usage: USAGE,
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } },
        { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/tmp/x' } },
      ],
    }),
    {
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-10-02T12:00:01.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'total 0' }] },
    },
  ]);
  const parsed = await parseTranscript(path, { withEvents: true });
  assert.equal(parsed.summary.toolCalls, 2);
  assert.equal(parsed.summary.pendingToolCalls, 1, 'toolu_2 never got a result');
  assert.deepEqual(parsed.toolHistogram, { Bash: 1, Read: 1 });
  const result = parsed.events.find((event) => event.kind === 'tool-result');
  assert.equal(result.toolName, 'Bash', 'a result must be attributed to the tool that was called');
  assert.equal(result.toolStatus, 'ok');
});

test('a failed tool result counts as an error', async () => {
  const { path } = await writeTranscript([
    assistant({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'false' } }] }),
    {
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-10-02T12:00:01.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'boom' }] },
    },
  ]);
  const parsed = await parseTranscript(path);
  assert.equal(parsed.summary.errorCount, 1);
  assert.equal(parsed.summary.pendingToolCalls, 0);
});

test('injected text never becomes the session title', async () => {
  const { path } = await writeTranscript([
    {
      type: 'user',
      uuid: 'u0',
      timestamp: '2026-10-02T11:59:00.000Z',
      message: { role: 'user', content: '<system-reminder>do not use this as a title</system-reminder>' },
    },
    {
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-10-02T11:59:30.000Z',
      message: { role: 'user', content: 'Add pagination to the sessions list' },
    },
    assistant({ usage: USAGE }),
  ]);
  const parsed = await parseTranscript(path);
  assert.equal(parsed.summary.title, 'Add pagination to the sessions list');
  assert.equal(parsed.summary.titleSource, 'prompt');
  assert.equal(parsed.summary.userTurns, 1, 'the injected reminder is not a turn');
});

test('an explicit title beats a generated one, which beats the first prompt', async () => {
  const base = [
    { type: 'user', uuid: 'u1', timestamp: '2026-10-02T12:00:00.000Z', message: { role: 'user', content: 'first prompt' } },
  ];
  const fromPrompt = await parseTranscript((await writeTranscript(base)).path);
  assert.equal(fromPrompt.summary.titleSource, 'prompt');

  const withAi = await parseTranscript((await writeTranscript([...base, { type: 'ai-title', aiTitle: 'Generated name' }])).path);
  assert.equal(withAi.summary.title, 'Generated name');
  assert.equal(withAi.summary.titleSource, 'ai');

  const withCustom = await parseTranscript(
    (await writeTranscript([...base, { type: 'ai-title', aiTitle: 'Generated name' }, { type: 'custom-title', customTitle: 'Mine' }]))
      .path,
  );
  assert.equal(withCustom.summary.title, 'Mine');
  assert.equal(withCustom.summary.titleSource, 'custom');
});

test('a last-prompt record names a session whose opening turn was all injected text', async () => {
  const { path } = await writeTranscript([
    { type: 'user', uuid: 'u1', timestamp: '2026-10-02T12:00:00.000Z', message: { role: 'user', content: '<command-name>/goal</command-name>' } },
    { type: 'last-prompt', lastPrompt: 'Build the dashboard', sessionId: 'sess-1' },
  ]);
  const parsed = await parseTranscript(path);
  assert.equal(parsed.summary.title, 'Build the dashboard');
});

test("a reported cost wins, and a disagreement is surfaced rather than reconciled", async () => {
  const { path } = await writeTranscript([
    assistant({ usage: USAGE }), // computes to $25
    { type: 'cost-state', sessionId: 'sess-1', totalCostUSD: 30, modelUsage: {} },
  ]);
  const parsed = await parseTranscript(path);
  assert.equal(parsed.summary.cost.usd, 30, 'the host tool is the billing-side truth');
  assert.equal(parsed.summary.cost.basis, 'reported');
  assert.deepEqual(parsed.summary.cost.conflict, { reportedUsd: 30, computedUsd: 25 });
  assert.ok(
    parsed.summary.issues.some((issue) => issue.code === 'cost.disagreement'),
    'a gap between the two figures must be raised, not hidden',
  );
});

test('a reported cost that agrees with ours raises nothing', async () => {
  const { path } = await writeTranscript([
    assistant({ usage: USAGE }),
    { type: 'cost-state', sessionId: 'sess-1', totalCostUSD: 25.1, modelUsage: {} },
  ]);
  const parsed = await parseTranscript(path);
  assert.equal(parsed.summary.cost.basis, 'reported');
  assert.equal(parsed.summary.cost.conflict, undefined);
  assert.equal(parsed.summary.issues.filter((issue) => issue.code === 'cost.disagreement').length, 0);
});

test('a half-written final line is tolerated, because a live session always has one', async () => {
  const good = jsonl([assistant({ usage: USAGE })]);
  const { path } = await writeTranscript(`${good}{"type":"assistant","message":{"id":"msg_2"`);
  const parsed = await parseTranscript(path);
  assert.equal(parsed.summary.tokens.output, 1_000_000, 'the complete records still parse');
  assert.ok(parsed.summary.issues.some((issue) => issue.code === 'transcript.partial-lines'));
});

test('the working directory comes from the records, not the directory name', async () => {
  const { path } = await writeTranscript([assistant({ usage: USAGE })]);
  const parsed = await parseTranscript(path, { projectDirName: '-Users-me-work-thing' });
  assert.equal(parsed.summary.projectPath, '/Users/me/work/thing');
  assert.equal(parsed.summary.projectLabel, 'thing');
});

test('with no recorded cwd, the decoded directory name is used and flagged as a guess', async () => {
  const { path } = await writeTranscript([{ type: 'custom-title', customTitle: 'x', sessionId: 'sess-1' }]);
  const parsed = await parseTranscript(path, { projectDirName: '-Users-me-connor-cates-site' });
  // The encoding is lossy for any path containing a hyphen, so this is wrong —
  // and Pebble says so rather than presenting it as fact.
  assert.equal(parsed.summary.projectPath, '/Users/me/connor/cates/site');
  assert.ok(parsed.summary.issues.some((issue) => issue.code === 'transcript.cwd-inferred'));
});

test('a relocated session reports where it ended up', async () => {
  const { path } = await writeTranscript([
    assistant({ usage: USAGE }),
    { type: 'relocated', relocatedCwd: '/Users/me/elsewhere', sessionId: 'sess-1' },
  ]);
  const parsed = await parseTranscript(path);
  assert.equal(parsed.summary.projectPath, '/Users/me/elsewhere');
});

test('sub-agent counting prefers Task calls over a bare sidechain flag', async () => {
  const { path } = await writeTranscript([
    assistant({
      usage: USAGE,
      content: [
        { type: 'tool_use', id: 't1', name: 'Task', input: { description: 'review' } },
        { type: 'tool_use', id: 't2', name: 'Agent', input: { prompt: 'go' } },
      ],
    }),
  ]);
  const parsed = await parseTranscript(path);
  assert.equal(parsed.summary.subagentCount, 2);
});

test('a missing or unreadable file returns null rather than throwing', async () => {
  assert.equal(await parseTranscript('/definitely/not/here.jsonl'), null);
});

test('an empty transcript still produces a usable summary', async () => {
  const { path } = await writeTranscript('');
  const parsed = await parseTranscript(path);
  assert.equal(parsed.summary.userTurns, 0);
  assert.equal(parsed.summary.cost.usd, 0);
  assert.equal(parsed.summary.titleSource, 'fallback');
  assert.equal(parsed.summary.status, 'active', 'a file touched this instant reads as active');
});

test('events carry a readable gist of each tool call', async () => {
  const { path } = await writeTranscript([
    assistant({
      usage: USAGE,
      content: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm build', description: 'build it' } },
        { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/src/app.ts', old_string: 'a', new_string: 'b' } },
        { type: 'tool_use', id: 't3', name: 'Weird', input: { alpha: 1, beta: 2 } },
      ],
    }),
  ]);
  const parsed = await parseTranscript(path, { withEvents: true });
  const calls = parsed.events.filter((event) => event.kind === 'tool-call');
  assert.equal(calls[0].text, 'pnpm build', 'a command is the most useful thing to show');
  assert.equal(calls[1].text, '/src/app.ts');
  assert.equal(calls[2].text, 'Weird(alpha, beta)', 'an unknown tool falls back to its argument names');
});

test('hook and error records become events without inflating turn counts', async () => {
  const { path } = await writeTranscript([
    assistant({ usage: USAGE }),
    {
      type: 'system',
      subtype: 'stop_hook_summary',
      uuid: 's1',
      timestamp: '2026-10-02T12:00:02.000Z',
      hookCount: 2,
      hookInfos: [{ command: './scripts/on-stop.sh' }],
      preventedContinuation: true,
    },
    { type: 'system', subtype: 'api_error', level: 'error', uuid: 's2', timestamp: '2026-10-02T12:00:03.000Z' },
  ]);
  const parsed = await parseTranscript(path, { withEvents: true });
  assert.equal(parsed.summary.errorCount, 1);
  assert.equal(parsed.summary.userTurns, 0);
  const hook = parsed.events.find((event) => event.kind === 'hook');
  assert.match(hook.text, /2 stop hooks \(blocked continuation\): \.\/scripts\/on-stop\.sh/);
});

test('indexing mode does not build the event list', async () => {
  const { path } = await writeTranscript([assistant({ usage: USAGE })]);
  const forIndex = await parseTranscript(path);
  const forDetail = await parseTranscript(path, { withEvents: true });
  assert.equal(forIndex.events.length, 0);
  assert.ok(forDetail.events.length > 0);
  assert.deepEqual(forIndex.summary.tokens, forDetail.summary.tokens, 'both modes must agree on the numbers');
});
