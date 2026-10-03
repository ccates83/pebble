import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PebbleStore, SCHEMA_VERSION, ZERO_TOKENS } from '../dist/index.js';

const session = (overrides = {}) => ({
  id: 'sess-1',
  adapter: 'claude-code',
  title: 'A session',
  titleSource: 'prompt',
  projectPath: '/Users/me/work/alpha',
  projectLabel: 'alpha',
  gitBranch: 'main',
  entrypoint: 'cli',
  cliVersion: '2.1.0',
  models: ['claude-opus-5'],
  startedAt: '2026-10-01T10:00:00.000Z',
  lastActivityAt: '2026-10-01T11:00:00.000Z',
  status: 'done',
  userTurns: 3,
  assistantTurns: 9,
  toolCalls: 12,
  pendingToolCalls: 0,
  tokens: { ...ZERO_TOKENS, input: 100, output: 2_000 },
  cost: { usd: 1.5, basis: 'exact', unpricedModels: [] },
  subagentCount: 0,
  subagentTokens: ZERO_TOKENS,
  subagentCost: { usd: 0, basis: 'exact', unpricedModels: [] },
  errorCount: 0,
  transcriptPath: '/Users/me/.claude/projects/x/sess-1.jsonl',
  transcriptBytes: 4_096,
  linesAdded: 10,
  linesRemoved: 2,
  apiDurationMs: 30_000,
  permissionMode: 'auto',
  issues: [],
  ...overrides,
});

const extras = (mtime = 1_000) => ({ promptPreview: 'do the thing', toolHistogram: { Bash: 10, Read: 2 }, sourceMtimeMs: mtime });

test('a session round-trips through the store unchanged', () => {
  const store = new PebbleStore(':memory:');
  const original = session();
  store.upsertSession(original, extras());
  const [loaded] = store.listSessions();
  assert.equal(loaded.id, original.id);
  assert.deepEqual(loaded.tokens, original.tokens);
  assert.deepEqual(loaded.cost, original.cost);
  assert.deepEqual(loaded.models, original.models);
  assert.equal(loaded.linesAdded, 10);
  assert.equal(loaded.permissionMode, 'auto');
  store.close();
});

test('a cost conflict survives the round trip', () => {
  const store = new PebbleStore(':memory:');
  store.upsertSession(
    session({ cost: { usd: 30, basis: 'reported', unpricedModels: [], conflict: { reportedUsd: 30, computedUsd: 25 } } }),
    extras(),
  );
  const [loaded] = store.listSessions();
  assert.deepEqual(loaded.cost.conflict, { reportedUsd: 30, computedUsd: 25 });
  store.close();
});

test('writing the same session twice replaces it rather than accumulating', () => {
  const store = new PebbleStore(':memory:');
  store.upsertSession(session({ toolCalls: 5 }), extras());
  store.upsertSession(session({ toolCalls: 7 }), extras(2_000));
  assert.equal(store.listSessions().length, 1);
  assert.equal(store.listSessions()[0].toolCalls, 7);
  // Child rows are replaced too, so a tool that disappears from a re-read is gone.
  store.upsertSession(session(), { ...extras(3_000), toolHistogram: { Write: 1 } });
  assert.deepEqual(
    store.toolRollup().map((row) => row.tool),
    ['Write'],
  );
  store.close();
});

test('freshness is keyed on both size and mtime', () => {
  const store = new PebbleStore(':memory:');
  store.upsertSession(session({ transcriptBytes: 4_096 }), extras(1_000));
  assert.equal(store.isFresh('claude-code', 'sess-1', 4_096, 1_000), true);
  assert.equal(store.isFresh('claude-code', 'sess-1', 4_097, 1_000), false, 'grew by a byte');
  assert.equal(store.isFresh('claude-code', 'sess-1', 4_096, 1_001), false, 'touched');
  assert.equal(store.isFresh('claude-code', 'nope', 4_096, 1_000), false, 'never seen');
  store.close();
});

test('pruning drops sessions whose transcripts are gone and nothing else', () => {
  const store = new PebbleStore(':memory:');
  store.upsertSession(session({ id: 'a' }), extras());
  store.upsertSession(session({ id: 'b' }), extras());
  store.upsertSession(session({ id: 'c' }), extras());
  const pruned = store.pruneMissing('claude-code', new Set(['a', 'c']));
  assert.equal(pruned, 1);
  assert.deepEqual(
    store.listSessions().map((s) => s.id).sort(),
    ['a', 'c'],
  );
  store.close();
});

test('filters compose, and list and count always agree', () => {
  const store = new PebbleStore(':memory:');
  store.upsertSession(session({ id: 'a', status: 'active', projectPath: '/p/one', projectLabel: 'one' }), extras());
  store.upsertSession(session({ id: 'b', status: 'done', projectPath: '/p/one', projectLabel: 'one' }), extras());
  store.upsertSession(
    session({ id: 'c', status: 'done', projectPath: '/p/two', projectLabel: 'two', models: ['claude-sonnet-5'] }),
    extras(),
  );

  for (const filter of [
    {},
    { status: ['done'] },
    { project: '/p/one' },
    { model: 'claude-sonnet-5' },
    { status: ['done'], project: '/p/one' },
    { search: 'A session' },
    { search: 'nothing matches this' },
  ]) {
    assert.equal(
      store.listSessions({ ...filter, limit: 2000 }).length,
      store.countSessions(filter),
      `list and count disagree for ${JSON.stringify(filter)}`,
    );
  }

  assert.equal(store.listSessions({ model: 'claude-sonnet-5' })[0].id, 'c');
  store.close();
});

test('search looks at the prompt preview, not just the title', () => {
  const store = new PebbleStore(':memory:');
  store.upsertSession(session({ id: 'a', title: 'Untitled' }), { ...extras(), promptPreview: 'fix the flaky migration test' });
  assert.equal(store.listSessions({ search: 'flaky migration' }).length, 1);
  store.close();
});

test('status is recomputed against the clock, not left as indexed', () => {
  const store = new PebbleStore(':memory:');
  const now = Date.parse('2026-10-02T12:00:00.000Z');
  store.upsertSession(session({ id: 'fresh', status: 'done', lastActivityAt: new Date(now - 5_000).toISOString() }), extras());
  store.upsertSession(
    session({ id: 'stuck', status: 'active', lastActivityAt: new Date(now - 300_000).toISOString(), pendingToolCalls: 1 }),
    extras(),
  );
  store.upsertSession(session({ id: 'old', status: 'active', lastActivityAt: new Date(now - 86_400_000).toISOString() }), extras());

  store.refreshStatuses(now, 90_000, 30 * 60_000);
  const byId = new Map(store.listSessions().map((s) => [s.id, s.status]));
  assert.equal(byId.get('fresh'), 'active');
  assert.equal(byId.get('stuck'), 'waiting');
  assert.equal(byId.get('old'), 'done');
  store.close();
});

test('rollups aggregate per project, model and tool', () => {
  const store = new PebbleStore(':memory:');
  store.upsertSession(
    session({ id: 'a', projectPath: '/p/one', projectLabel: 'one', cost: { usd: 2, basis: 'exact', unpricedModels: [] } }),
    extras(),
  );
  store.upsertSession(
    session({ id: 'b', projectPath: '/p/one', projectLabel: 'one', cost: { usd: 3, basis: 'exact', unpricedModels: [] }, status: 'active' }),
    extras(),
  );
  store.upsertSession(
    session({ id: 'c', projectPath: '/p/two', projectLabel: 'two', models: ['claude-sonnet-5'] }),
    extras(),
  );

  const projects = store.projectRollup();
  const one = projects.find((row) => row.projectPath === '/p/one');
  assert.equal(one.sessions, 2);
  assert.equal(one.costUsd, 5);
  assert.equal(one.activeSessions, 1);

  assert.deepEqual(
    store.modelRollup().map((row) => [row.model, row.sessions]).sort(),
    [['claude-opus-5', 2], ['claude-sonnet-5', 1]],
  );

  const tools = store.toolRollup();
  const bash = tools.find((row) => row.tool === 'Bash');
  assert.equal(bash.calls, 30, '10 calls in each of three sessions');
  assert.equal(bash.sessions, 3);

  assert.deepEqual(store.projectPaths().sort(), ['/p/one', '/p/two']);
  store.close();
});

test('a project rollup is flagged approximate when any session in it is', () => {
  const store = new PebbleStore(':memory:');
  store.upsertSession(session({ id: 'a', projectPath: '/p/one', projectLabel: 'one' }), extras());
  store.upsertSession(session({ id: 'b', projectPath: '/p/two', projectLabel: 'two' }), extras());
  store.upsertSession(
    session({
      id: 'c',
      projectPath: '/p/two',
      projectLabel: 'two',
      cost: { usd: 1, basis: 'estimated', unpricedModels: ['claude-opus-5-5'] },
    }),
    extras(),
  );
  const byPath = new Map(store.projectRollup().map((row) => [row.projectPath, row]));
  assert.equal(byPath.get('/p/one').approximate, false);
  assert.equal(
    byPath.get('/p/two').approximate,
    true,
    'a total built from an estimate must not look as certain as one built from measurements',
  );
  store.close();
});

test('stats count sessions whose cost is less than certain', () => {
  const store = new PebbleStore(':memory:');
  store.upsertSession(session({ id: 'a' }), extras());
  store.upsertSession(session({ id: 'b', cost: { usd: 1, basis: 'estimated', unpricedModels: ['claude-opus-5-5'] } }), extras());
  store.upsertSession(
    session({ id: 'c', cost: { usd: 1, basis: 'reported', unpricedModels: [], conflict: { reportedUsd: 1, computedUsd: 2 } } }),
    extras(),
  );
  const stats = store.stats();
  assert.equal(stats.sessions, 3);
  assert.equal(stats.approximateSessions, 2, 'an estimate and a disagreement both count as less than certain');
  store.close();
});

test('daily cost buckets by day and flags days containing an estimate', () => {
  const store = new PebbleStore(':memory:');
  const today = new Date().toISOString().slice(0, 10);
  store.upsertSession(session({ id: 'a', lastActivityAt: `${today}T09:00:00.000Z`, cost: { usd: 1, basis: 'exact', unpricedModels: [] } }), extras());
  store.upsertSession(session({ id: 'b', lastActivityAt: `${today}T10:00:00.000Z`, cost: { usd: 2, basis: 'estimated', unpricedModels: ['x'] } }), extras());
  const [day] = store.dailyCost(7).filter((row) => row.day === today);
  assert.equal(day.sessions, 2);
  assert.equal(day.costUsd, 3);
  assert.equal(day.approximate, true);
  store.close();
});

test('the schema version is recorded so a future migration can detect it', () => {
  const store = new PebbleStore(':memory:');
  assert.ok(Number(store.getMeta('schema_version')) >= 1);
  store.close();
});

const subagent = (overrides = {}) => ({
  id: 'agent-1',
  parentSessionId: 'sess-1',
  agentType: 'sales',
  title: 'Draft the pipeline report',
  models: ['claude-opus-5'],
  startedAt: '2026-10-01T10:10:00.000Z',
  lastActivityAt: '2026-10-01T10:20:00.000Z',
  status: 'done',
  pendingToolCalls: 0,
  toolCalls: 4,
  tokens: ZERO_TOKENS,
  cost: { usd: 0.2, basis: 'exact', unpricedModels: [] },
  errorCount: 0,
  transcriptPath: '/x/agent-1.jsonl',
  transcriptBytes: 10,
  ...overrides,
});

test('sub-agent runs are replaced with their parent, never merged', () => {
  const store = new PebbleStore(':memory:');
  store.upsertSession(session(), { ...extras(), subagents: [subagent(), subagent({ id: 'agent-2', agentType: null })] });
  assert.equal(store.listSubagentRunsUnder('/Users/me/work').length, 2);

  // A re-read that finds one sub-agent leaves exactly one, not three.
  store.upsertSession(session(), { ...extras(2_000), subagents: [subagent({ id: 'agent-3', agentType: 'finance' })] });
  const runs = store.listSubagentRunsUnder('/Users/me/work');
  assert.deepEqual(runs.map((r) => r.id), ['agent-3']);
  assert.equal(runs[0].agentType, 'finance');
  assert.equal(runs[0].parentProjectPath, '/Users/me/work/alpha');

  store.pruneMissing('claude-code', new Set());
  assert.equal(store.listSubagentRunsUnder('/Users/me/work').length, 0, 'pruning a session drops its runs');
  store.close();
});

test('prefix queries match on segment boundaries and treat _ literally', () => {
  const store = new PebbleStore(':memory:');
  store.upsertSession(session({ id: 'a', projectPath: '/x/_archive/fiverr' }), extras());
  store.upsertSession(session({ id: 'b', projectPath: '/x/Xarchive/fiverr' }), extras());
  store.upsertSession(session({ id: 'c', projectPath: '/x/_archive' }), extras());
  store.upsertSession(session({ id: 'd', projectPath: '/x/_archive-old' }), extras());
  assert.deepEqual(store.listSessionsUnder('/x/_archive').map((s) => s.id).sort(), ['a', 'c']);
  store.close();
});

test('an index from an older schema is dropped and rebuilt, not half-migrated', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const path = join(await mkdtemp(join(tmpdir(), 'pebble-store-')), 'old.db');

  const first = new PebbleStore(path);
  first.upsertSession(session(), extras());
  first.close();

  const raw = new DatabaseSync(path);
  raw.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
  raw.close();

  const reopened = new PebbleStore(path);
  assert.equal(reopened.listSessions().length, 0, 'rows from the old schema are gone; the next index pass refills them');
  assert.equal(reopened.getMeta('schema_version'), String(SCHEMA_VERSION));
  assert.equal(reopened.isFresh('claude-code', 'sess-1', 4_096, 1_000), false);
  reopened.close();
});
