import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  PebbleStore,
  ZERO_TOKENS,
  buildHqOverview,
  loadOrg,
  orgFingerprint,
  parseChangelog,
  placeSession,
  readOrg,
  resolveOrgRoot,
  rollupSubagents,
  sortAttention,
} from '../dist/index.js';

// ---------------------------------------------------------------------------
// Fixture: a small org on disk, in a temp dir. Never the real one.
// ---------------------------------------------------------------------------

async function put(root, rel, content) {
  const path = join(root, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

const note = (fields, body = '') =>
  ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', '', body].join('\n');

const dept = (sub, id, name, agent = id) => ({ id, name, path: `${sub}/01 Departments/${name}`, agent, created: '2026-10-01' });

async function makeOrg() {
  const root = await mkdtemp(join(tmpdir(), 'pebble-org-'));
  const org = {
    version: 1,
    holding: { name: 'Cates Holdings', hq: 'HQ' },
    subsidiaries: [
      {
        id: 'consulting',
        name: 'Consulting LLC',
        type: 'consulting',
        status: 'active',
        path: 'consulting',
        vault: 'consulting',
        created: '2026-10-01',
        departments: [dept('consulting', 'sales', 'Sales'), dept('consulting', 'legal', 'Legal & Compliance', 'legal')],
      },
      {
        id: 'ghost',
        name: 'Ghost Co',
        type: 'other',
        status: 'planning',
        path: 'ghost',
        vault: 'ghost',
        created: '2026-10-01',
        departments: [dept('ghost', 'ops', 'Ops')],
      },
      {
        id: 'fiverr',
        name: 'Fiverr Shop',
        type: 'marketplace',
        status: 'archived',
        path: '_archive/fiverr',
        vault: '_archive/fiverr',
        created: '2026-10-01',
        archived: '2026-10-02',
        departments: [dept('_archive/fiverr', 'sales', 'Sales')],
      },
      { name: 'no id, should be skipped' },
    ],
    tooling: [{ id: 'pebble', path: 'pebble', role: 'dashboard' }],
    updated: '2026-10-02',
  };
  await put(root, 'org.json', JSON.stringify(org, null, 2));

  // HQ
  await put(root, 'HQ/00 Inbox/Loose idea.md', note({ title: 'Loose idea', created: '2026-10-01' }));
  await put(root, 'HQ/00 Inbox/00 Inbox-INDEX.md', note({ title: 'index' }));
  await put(root, 'HQ/05 Decisions/Decision 001.md', note({ title: 'Decision 001', created: '2026-09-01' }));
  await put(root, 'HQ/05 Decisions/Decision 002.md', note({ title: 'Decision 002', created: '2026-09-15' }));
  await put(root, 'HQ/06 Self Improvements/Do better.md', note({ title: 'Do better', status: 'proposed      # proposed → applied' }));
  await put(root, 'HQ/06 Self Improvements/Done already.md', note({ title: 'Done already', status: 'applied' }));
  await put(
    root,
    'HQ/07 System/Logs/CHANGELOG.md',
    note({ title: 'HQ Changelog' }, ['- 2026-10-02 — claude — retired fiverr', '- 2026-10-01 — hq — scaffolded', 'not an entry'].join('\n')),
  );

  // consulting: a working vault with a bit of everything.
  const c = 'consulting';
  await put(root, `${c}/Charter.md`, note({ title: 'Consulting Charter' }, '> [!todo] Connor to fill in. Agents may draft.'));
  await put(root, `${c}/00 Inbox/.gitkeep`, '');
  await put(root, `${c}/00 Inbox/Lead list.md`, note({ title: 'Lead list', summary: 'Ten leads' }));
  await put(root, `${c}/00 Inbox/00 Inbox-INDEX.md`, note({ title: 'index' }));
  await put(root, `${c}/06 Self Improvements/Faster intake.md`, note({ title: 'Faster intake', status: 'proposed' }));
  await put(
    root,
    `${c}/07 System/Approvals/Send proposal.md`,
    [
      '---',
      'title: "Send proposal to Acme"',
      'created: 2026-10-01',
      'status: pending      # pending → approved | denied → done',
      'department: sales',
      'requested_by: sales        # agent name',
      'tier: 1',
      'action: send      # publish | send | spend | commit | account | deploy | other',
      'amount_usd:          # for spend',
      'due: 2026-10-03                 # when a decision is needed by',
      'decided: ',
      '---',
      '',
      '# Send proposal',
    ].join('\n'),
  );
  await put(
    root,
    `${c}/07 System/Approvals/Buy ads.md`,
    note({ title: 'Buy ads', created: '2026-09-20', status: 'pending', department: '"[[Sales Charter|Sales]]"', action: 'spend', amount_usd: '$1,200', due: '2026-09-25' }),
  );
  await put(root, `${c}/07 System/Approvals/Old one.md`, note({ title: 'Old one', status: 'done' }));
  await put(root, `${c}/07 System/Logs/CHANGELOG.md`, '- 2026-10-01 — hq — scaffolded\n');
  await put(root, `${c}/08 Reviews/2026-W38 Weekly Review.md`, note({ title: '2026-W38 Weekly Review', created: '2026-09-18', updated: '2026-10-02' }));
  await put(
    root,
    `${c}/01 Departments/Sales/Sales Scorecard.md`,
    note(
      { title: 'Sales Scorecard' },
      [
        '| KPI | Target | Baseline | Red if | Latest | Source / date | Verified |',
        '|---|---|---|---|---|---|---|',
        '| Pipeline value | $10k | unknown | < $2k | $4k | CRM 2026-10-01 | provisional |',
        '| Win rate |  | unknown |  |  |  | provisional |',
        '',
        'Back to [[Sales Charter]]',
      ].join('\n'),
    ),
  );
  await put(root, `${c}/.claude/agents/sales.md`, note({ name: 'sales' }));
  // Legal has neither a folder nor an agent; _HQ was never synced.

  // fiverr: archived, otherwise in a state that would raise plenty.
  const f = '_archive/fiverr';
  await put(root, `${f}/Charter.md`, note({ title: 'Fiverr Charter' }, 'Connor to fill in'));
  await put(root, `${f}/00 Inbox/Stale.md`, note({ title: 'Stale' }));
  await put(root, `${f}/07 System/Approvals/Refund.md`, note({ title: 'Refund buyer', status: 'pending', created: '2026-09-30' }));

  // ghost: listed in org.json, no vault on disk.
  return { root, org };
}

// ---------------------------------------------------------------------------

test('reads the org from a fixture tree', async () => {
  const { root } = await makeOrg();
  const org = await readOrg(root);

  assert.equal(org.name, 'Cates Holdings');
  assert.deepEqual(org.subsidiaries.map((s) => s.id), ['consulting', 'ghost', 'fiverr']);
  assert.ok(org.issues.some((i) => i.code === 'org.subsidiary-malformed'), 'an entry without an id is reported, not thrown');
  assert.deepEqual(org.tooling, [{ id: 'pebble', path: join(root, 'pebble'), role: 'dashboard' }]);

  assert.deepEqual(org.hq.inbox.map((n) => n.title), ['Loose idea'], 'index files are not inbox notes');
  assert.deepEqual(org.hq.proposals.map((n) => n.title), ['Do better'], 'status with a trailing comment still reads as proposed');
  assert.deepEqual(org.hq.decisions.map((n) => n.title), ['Decision 002', 'Decision 001']);
  assert.equal(org.hq.changelog.length, 2);
  assert.deepEqual(org.hq.changelog[0], { date: '2026-10-02', actor: 'claude', text: 'retired fiverr', unit: 'hq' });

  const consulting = org.subsidiaries[0];
  assert.equal(consulting.exists, true);
  assert.equal(consulting.charter.filled, false);
  assert.deepEqual(consulting.inbox.map((n) => n.title), ['Lead list'], '.gitkeep and the index are skipped');
  assert.deepEqual(consulting.proposals.map((n) => n.title), ['Faster intake']);
  assert.equal(consulting.lastReview.title, '2026-W38 Weekly Review');

  const send = consulting.approvals.find((a) => a.title === 'Send proposal to Acme');
  assert.equal(send.status, 'pending');
  assert.equal(send.requestedBy, 'sales');
  assert.equal(send.action, 'send');
  assert.equal(send.tier, 1);
  assert.equal(send.amountUsd, null, 'a comment-only value is empty, not the comment');
  assert.equal(send.due, '2026-10-03');
  assert.equal(send.decided, null);
  const ads = consulting.approvals.find((a) => a.title === 'Buy ads');
  assert.equal(ads.amountUsd, 1200);
  assert.equal(ads.department, 'Sales', 'a wikilink department reads as its alias');

  const sales = consulting.departments.find((d) => d.id === 'sales');
  assert.equal(sales.folderExists, true);
  assert.equal(sales.agentDefined, true);
  assert.equal(sales.scorecard.kpis.length, 2);
  assert.deepEqual(sales.scorecard.kpis[0], {
    name: 'Pipeline value',
    target: '$10k',
    baseline: 'unknown',
    redIf: '< $2k',
    latest: '$4k',
    source: 'CRM 2026-10-01',
    verified: 'provisional',
  });
  assert.equal(sales.scorecard.kpis[1].target, null);

  assert.deepEqual(consulting.drift.map((d) => d.message).sort(), ['_HQ never synced', 'no agent for Legal & Compliance', 'no folder for Legal & Compliance']);

  const ghost = org.subsidiaries[1];
  assert.equal(ghost.exists, false);
  assert.deepEqual(ghost.drift.map((d) => d.message), ['vault missing']);
  assert.equal(ghost.charter, null);
  assert.deepEqual(ghost.approvals, []);
});

test('a malformed org.json is an issue on the snapshot, never a throw', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pebble-org-bad-'));
  await put(root, 'org.json', '{ "subsidiaries": [ { "id": "x", ');
  const org = await readOrg(root);
  assert.deepEqual(org.subsidiaries, []);
  assert.ok(org.issues.some((i) => i.code === 'org.file-malformed' && i.level === 'error'));

  await put(root, 'org.json', '[1, 2, 3]');
  assert.ok((await readOrg(root)).issues.some((i) => i.code === 'org.file-malformed'));

  await put(root, 'org.json', '{"subsidiaries": "nope", "tooling": [42]}');
  const odd = await readOrg(root);
  assert.deepEqual(odd.subsidiaries, []);
  assert.deepEqual(odd.tooling, []);
});

test('no org.json means no snapshot, with the reason', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pebble-org-none-'));
  const load = await loadOrg({ root, source: 'flag' });
  assert.equal(load.org, null);
  assert.match(load.reason, /No org\.json/);

  const store = new PebbleStore(':memory:');
  const overview = buildHqOverview(store, null, Date.now(), load);
  assert.equal(overview.org, null);
  assert.equal(overview.orgError, load.reason);
  assert.deepEqual(overview.units, []);
  store.close();
});

test('resolveOrgRoot: flag, then env, then discovery, then the default', async () => {
  const { root } = await makeOrg();
  const deep = join(root, 'consulting', '01 Departments', 'Sales');
  assert.deepEqual(resolveOrgRoot({ flag: '/somewhere', env: '/else', cwd: deep }), { root: '/somewhere', source: 'flag' });
  assert.deepEqual(resolveOrgRoot({ flag: `${root}/org.json`, env: null }), { root, source: 'flag' });
  assert.deepEqual(resolveOrgRoot({ env: '/else', cwd: deep }), { root: '/else', source: 'env' });
  assert.deepEqual(resolveOrgRoot({ env: null, cwd: deep }), { root, source: 'discovered' });
  const lost = await mkdtemp(join(tmpdir(), 'pebble-org-lost-'));
  assert.deepEqual(resolveOrgRoot({ env: null, cwd: lost, fallback: '/fallback' }), { root: '/fallback', source: 'default' });
});

test('changelog lines tolerate hand-typed separators and keep hyphenated actors whole', () => {
  const entries = parseChangelog(
    ['- 2026-10-01 -- pebble-core -- did a thing', '- 2026-10-03 — hq — newest', '* 2026-10-02 - claude - middle', '- not a date — x — y'].join('\n'),
    'hq',
  );
  assert.deepEqual(entries.map((e) => [e.date, e.actor]), [['2026-10-03', 'hq'], ['2026-10-02', 'claude'], ['2026-10-01', 'pebble-core']]);
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

test('placement: longest prefix on a segment boundary', async () => {
  const { root } = await makeOrg();
  const org = await readOrg(root);
  const at = (p, hints) => placeSession(p, org, hints);

  assert.deepEqual(at(root), { scope: 'hq', unit: 'hq', department: null }, 'the root itself is HQ');
  assert.deepEqual(at(`${root}/`), { scope: 'hq', unit: 'hq', department: null }, 'a trailing slash changes nothing');
  assert.deepEqual(at(join(root, 'HQ', '05 Decisions')), { scope: 'hq', unit: 'hq', department: null });
  assert.deepEqual(at(join(root, 'consulting')), { scope: 'subsidiary', unit: 'consulting', department: null });
  assert.deepEqual(at(join(root, 'consulting', '01 Departments', 'Sales')).unit, 'consulting');
  assert.equal(at(join(root, 'consulting-old')).scope, 'outside', '/x/consulting-old is not /x/consulting');
  assert.equal(at(join(root, 'HQ-scratch')).scope, 'outside');
  assert.equal(at(join(root, 'some-other-repo')).scope, 'outside', 'beside the vaults is not HQ');
  assert.deepEqual(at(join(root, '_archive', 'fiverr', 'x')), { scope: 'subsidiary', unit: 'fiverr', department: null });
  assert.deepEqual(at(join(root, 'pebble', 'packages', 'core')), { scope: 'tooling', unit: 'pebble', department: null });
  assert.equal(at('/').scope, 'outside');
  assert.equal(at('').scope, 'outside');
});

test('placement: department from the agent the session ran as, else a sub-agent it spawned', async () => {
  const { root } = await makeOrg();
  const org = await readOrg(root);
  const vault = join(root, 'consulting');
  assert.equal(placeSession(vault, org, { title: 'sales', titleSource: 'agent' }).department, 'sales');
  assert.equal(placeSession(vault, org, { title: 'sales', titleSource: 'prompt' }).department, null, 'a prompt that says "sales" is not the agent');
  assert.equal(placeSession(vault, org, { subagentTypes: [null, 'general-purpose', 'legal', 'sales'] }).department, 'legal');
  assert.equal(placeSession(join(root, 'HQ'), org, { title: 'sales', titleSource: 'agent' }).department, null, 'HQ has no departments');
});

// ---------------------------------------------------------------------------
// Overview and attention
// ---------------------------------------------------------------------------

const session = (overrides = {}) => ({
  id: 's',
  adapter: 'test',
  title: 'A session',
  titleSource: 'prompt',
  projectPath: '/nowhere',
  projectLabel: 'x',
  gitBranch: null,
  entrypoint: 'cli',
  cliVersion: null,
  models: [],
  startedAt: '2026-10-02T09:00:00.000Z',
  lastActivityAt: '2026-10-02T11:00:00.000Z',
  status: 'done',
  userTurns: 1,
  assistantTurns: 1,
  toolCalls: 0,
  pendingToolCalls: 0,
  tokens: ZERO_TOKENS,
  cost: { usd: 1, basis: 'exact', unpricedModels: [] },
  subagentCount: 0,
  subagentTokens: ZERO_TOKENS,
  subagentCost: { usd: 0, basis: 'exact', unpricedModels: [] },
  errorCount: 0,
  transcriptPath: '/t.jsonl',
  transcriptBytes: 1,
  linesAdded: null,
  linesRemoved: null,
  apiDurationMs: null,
  permissionMode: null,
  issues: [],
  ...overrides,
});
const write = (store, s, subagents = []) => store.upsertSession(s, { promptPreview: null, toolHistogram: {}, sourceMtimeMs: 1, subagents });

test('the overview joins sessions to units and departments', async () => {
  const { root } = await makeOrg();
  const org = await readOrg(root);
  const now = Date.parse('2026-10-02T12:00:00.000Z');
  const store = new PebbleStore(':memory:');
  const vault = join(root, 'consulting');

  write(store, session({ id: 'agent-run', projectPath: vault, title: 'sales', titleSource: 'agent', status: 'active', cost: { usd: 2, basis: 'reported', unpricedModels: [] } }));
  write(store, session({ id: 'spawner', projectPath: vault, title: 'Plan the week', cost: { usd: 3, basis: 'estimated', unpricedModels: ['x'] } }), [
    {
      id: 'sub-1',
      parentSessionId: 'spawner',
      agentType: 'legal',
      title: 'Review the NDA',
      models: [],
      startedAt: '2026-10-02T10:00:00.000Z',
      lastActivityAt: '2026-10-02T10:30:00.000Z',
      status: 'done',
      pendingToolCalls: 0,
      toolCalls: 1,
      tokens: ZERO_TOKENS,
      cost: { usd: 0.5, basis: 'exact', unpricedModels: [] },
      errorCount: 0,
      transcriptPath: '/s.jsonl',
      transcriptBytes: 1,
    },
  ]);
  write(store, session({ id: 'old', projectPath: vault, lastActivityAt: '2026-09-01T00:00:00.000Z' }));
  write(store, session({ id: 'hq', projectPath: root }));
  write(store, session({ id: 'tool', projectPath: join(root, 'pebble') }));
  write(store, session({ id: 'away', projectPath: '/elsewhere' }));
  write(store, session({ id: 'beside', projectPath: join(root, 'consulting-old') }));

  const overview = buildHqOverview(store, org, now, { root, source: 'discovered' });
  assert.equal(overview.orgRootSource, 'discovered');
  assert.deepEqual(overview.units.map((u) => `${u.kind}:${u.id}`), ['hq:hq', 'subsidiary:consulting', 'subsidiary:ghost', 'subsidiary:fiverr', 'tooling:pebble']);

  const c = overview.units.find((u) => u.id === 'consulting');
  assert.equal(c.sessions7d, 2);
  assert.deepEqual(c.cost7d, { usd: 5, approximate: true }, 'own cost only; an estimate makes the sum approximate');
  assert.deepEqual(c.live.map((s) => s.id), ['agent-run']);
  assert.equal(c.recent.length, 3);
  assert.equal(c.recent.find((s) => s.id === 'spawner').placement.department, 'legal');
  assert.equal(c.lastActivityAt, '2026-10-02T11:00:00.000Z');

  const sales = c.departments.find((d) => d.department === 'sales');
  assert.equal(sales.runs7d, 1);
  assert.equal(sales.status, 'active');
  assert.deepEqual(sales.lastSession, { adapter: 'test', id: 'agent-run' });
  const legal = c.departments.find((d) => d.department === 'legal');
  assert.equal(legal.lastTitle, 'Review the NDA');
  assert.deepEqual(legal.lastSession, { adapter: 'test', id: 'spawner' }, 'a sub-agent run points at its parent session');

  const ghost = overview.units.find((u) => u.id === 'ghost');
  assert.deepEqual(ghost.departments.map((d) => [d.department, d.runs7d, d.lastActivityAt]), [['ops', 0, null]], 'every department appears, even idle');

  assert.equal(overview.units.find((u) => u.id === 'hq').sessions7d, 1);
  assert.equal(overview.units.find((u) => u.id === 'pebble').sessions7d, 1);
  assert.equal(overview.outside7d, 2, '/elsewhere and the look-alike consulting-old');
  store.close();
});

const subRun = (overrides = {}) => ({
  id: 'sub',
  parentSessionId: 's',
  agentType: null,
  title: 'A sub-agent',
  models: [],
  startedAt: '2026-10-02T10:00:00.000Z',
  lastActivityAt: '2026-10-02T11:00:00.000Z',
  status: 'done',
  pendingToolCalls: 0,
  toolCalls: 1,
  tokens: ZERO_TOKENS,
  cost: { usd: 0, basis: 'exact', unpricedModels: [] },
  errorCount: 0,
  transcriptPath: '/s.jsonl',
  transcriptBytes: 1,
  ...overrides,
});

test('live sessions carry their live sub-agents, and a quiet parent with one stays on the floor', async () => {
  const { root } = await makeOrg();
  const org = await readOrg(root);
  const now = Date.parse('2026-10-02T12:00:00.000Z');
  const store = new PebbleStore(':memory:');
  const vault = join(root, 'consulting');

  write(store, session({ id: 'busy', projectPath: vault, status: 'active', lastActivityAt: '2026-10-02T11:50:00.000Z' }), [
    subRun({ id: 'late', parentSessionId: 'busy', agentType: 'legal', status: 'waiting', startedAt: '2026-10-02T11:30:00.000Z', errorCount: 2 }),
    subRun({ id: 'finished', parentSessionId: 'busy', status: 'done', startedAt: '2026-10-02T10:00:00.000Z' }),
    subRun({ id: 'early', parentSessionId: 'busy', status: 'active', startedAt: '2026-10-02T11:00:00.000Z' }),
  ]);
  write(store, session({ id: 'quiet', projectPath: vault, status: 'done', lastActivityAt: '2026-10-02T11:40:00.000Z' }), [
    subRun({ id: 'background', parentSessionId: 'quiet', status: 'idle', title: 'Background sweep' }),
  ]);
  write(store, session({ id: 'gone', projectPath: vault, status: 'done', lastActivityAt: '2026-10-02T11:45:00.000Z' }), [
    subRun({ id: 'over', parentSessionId: 'gone', status: 'done' }),
  ]);

  const c = buildHqOverview(store, org, now, { root, source: 'flag' }).units.find((u) => u.id === 'consulting');
  assert.deepEqual(c.live.map((s) => s.id), ['busy', 'quiet'], 'newest first; a done parent with only done sub-agents is not live');

  const busy = c.live.find((s) => s.id === 'busy');
  assert.deepEqual(busy.liveSubagents.map((r) => r.id), ['early', 'late'], 'live runs only, oldest first');
  assert.deepEqual(busy.liveSubagents[1], {
    id: 'late',
    agentType: 'legal',
    title: 'A sub-agent',
    status: 'waiting',
    startedAt: '2026-10-02T11:30:00.000Z',
    lastActivityAt: '2026-10-02T11:00:00.000Z',
    errorCount: 2,
  });

  const quiet = c.live.find((s) => s.id === 'quiet');
  assert.equal(quiet.status, 'done', "the parent's own status is left as measured");
  assert.deepEqual(quiet.liveSubagents.map((r) => r.id), ['background']);

  assert.deepEqual(c.recent.map((s) => s.id), ['busy', 'gone', 'quiet'], 'recent is unchanged');
  assert.ok(c.recent.every((s) => !('liveSubagents' in s)));
  store.close();
});

test('attention: most urgent first, and archived units only raise approvals', async () => {
  const { root } = await makeOrg();
  const org = await readOrg(root);
  const now = Date.parse('2026-10-02T12:00:00.000Z');
  const store = new PebbleStore(':memory:');
  write(store, session({ id: 'wait', projectPath: join(root, 'consulting'), status: 'waiting', pendingToolCalls: 1 }));
  write(store, session({ id: 'err', projectPath: join(root, 'pebble'), errorCount: 2 }));
  write(store, session({ id: 'err-old', projectPath: join(root, 'pebble'), errorCount: 2, lastActivityAt: '2026-09-29T00:00:00.000Z' }));
  write(store, session({ id: 'arch-wait', projectPath: join(root, '_archive', 'fiverr'), status: 'waiting', pendingToolCalls: 1 }));
  write(store, session({ id: 'out-wait', projectPath: '/elsewhere', status: 'waiting', pendingToolCalls: 1 }));

  const { attention } = buildHqOverview(store, org, now, { root, source: 'flag' });
  const summary = attention.map((a) => `${a.level}:${a.kind}:${a.unit}:${a.title}`);

  assert.deepEqual(summary.slice(0, 4), [
    'error:approval:consulting:Buy ads', // past due outranks everything
    'warn:approval:fiverr:Refund buyer', // undated: ordered by when it was filed (09-30)…
    'warn:approval:consulting:Send proposal to Acme', // …ahead of a deadline on 10-03
    'warn:waiting-session:consulting:A session',
  ]);

  // Levels never interleave, and within a level the kinds keep their order.
  const LEVEL = { error: 0, warn: 1, info: 2 };
  const KIND = ['approval', 'waiting-session', 'session-errors', 'drift', 'inbox', 'proposal', 'charter', 'review-overdue', 'org-issue'];
  for (let i = 1; i < attention.length; i += 1) {
    const [a, b] = [attention[i - 1], attention[i]];
    assert.ok(LEVEL[a.level] < LEVEL[b.level] || (LEVEL[a.level] === LEVEL[b.level] && KIND.indexOf(a.kind) <= KIND.indexOf(b.kind)), `${a.id} before ${b.id}`);
  }

  assert.equal(attention[0].kind, 'approval');
  assert.equal(attention[0].level, 'error');
  assert.equal(attention[0].department, 'sales', 'a department written as its name maps to its id');
  assert.ok(attention.some((a) => a.kind === 'approval' && a.unit === 'fiverr'), 'an archived unit still raises its pending approval');
  assert.ok(!attention.some((a) => a.unit === 'fiverr' && a.kind !== 'approval'), 'and nothing else');
  assert.ok(!attention.some((a) => a.session?.id === 'arch-wait' || a.session?.id === 'out-wait'));
  assert.ok(!attention.some((a) => a.title === 'Old one'), 'a decided approval is not attention');

  const kinds = new Set(attention.map((a) => a.kind));
  for (const kind of ['waiting-session', 'session-errors', 'drift', 'inbox', 'proposal', 'charter', 'review-overdue', 'org-issue']) {
    assert.ok(kinds.has(kind), `expected a ${kind} item`);
  }
  assert.deepEqual(attention.filter((a) => a.kind === 'session-errors').map((a) => a.session.id), ['err'], 'only the last 24h');
  const review = attention.find((a) => a.kind === 'review-overdue');
  assert.equal(review.unit, 'consulting', 'an active subsidiary whose last review was created 2 weeks ago, even if touched since');
  assert.equal(new Set(attention.map((a) => a.id)).size, attention.length, 'ids are unique');
  store.close();
});

test('sortAttention: level first, then kind, then deadline for approvals and recency otherwise', () => {
  const item = (id, level, kind, at) => ({ id, level, kind, at, title: id, unit: null, department: null, detail: null, path: null, session: null });
  const sorted = sortAttention([
    item('inbox-old', 'info', 'inbox', '2026-09-01'),
    item('inbox-new', 'info', 'inbox', '2026-10-01'),
    item('drift', 'warn', 'drift', null),
    item('approval-later', 'warn', 'approval', '2026-10-10'),
    item('approval-sooner', 'warn', 'approval', '2026-10-05'),
    item('approval-undated', 'warn', 'approval', null),
    item('org-error', 'error', 'org-issue', null),
    item('waiting', 'warn', 'waiting-session', '2026-10-02T10:00:00Z'),
  ]);
  assert.deepEqual(sorted.map((i) => i.id), [
    'org-error',
    'approval-sooner',
    'approval-later',
    'approval-undated',
    'waiting',
    'drift',
    'inbox-new',
    'inbox-old',
  ]);
});

test('the org fingerprint moves on an in-place edit and holds still otherwise', async () => {
  const { root } = await makeOrg();
  const before = await orgFingerprint(root);
  assert.equal(await orgFingerprint(root), before);
  // Same name, new content and a different size: the directory mtime may not move.
  await put(root, 'consulting/07 System/Approvals/Old one.md', note({ title: 'Old one', status: 'done', decided: '2026-10-02' }));
  assert.notEqual(await orgFingerprint(root), before);
  const missing = await mkdtemp(join(tmpdir(), 'pebble-org-fp-'));
  assert.equal(typeof (await orgFingerprint(missing)), 'string', 'no org.json is a fingerprint, not a throw');
});

// ---------------------------------------------------------------------------
// Sub-agent agentType, from Claude Code's meta.json
// ---------------------------------------------------------------------------

test('sub-agent agentType comes from meta.json, and a bad or missing one is null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pebble-sub-'));
  const parent = join(dir, 'sess-1.jsonl');
  await writeFile(parent, '');
  const subdir = join(dir, 'sess-1', 'subagents');
  const transcript = (prompt) =>
    [
      { type: 'user', uuid: 'u1', timestamp: '2026-10-02T12:00:00.000Z', isSidechain: true, cwd: '/w', message: { role: 'user', content: prompt } },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-10-02T12:00:05.000Z',
        isSidechain: true,
        cwd: '/w',
        message: { id: 'm1', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }] },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n';

  await put(subdir, 'agent-typed.jsonl', transcript('Draft the pipeline report'));
  await put(subdir, 'agent-typed.meta.json', JSON.stringify({ agentType: 'sales', description: 'Pipeline', toolUseId: 't', spawnDepth: 1 }));
  await put(subdir, 'agent-broken.jsonl', transcript('Something'));
  await put(subdir, 'agent-broken.meta.json', '{"agentType": "sal');
  await put(subdir, 'agent-wrongtype.jsonl', transcript('Something else'));
  await put(subdir, 'agent-wrongtype.meta.json', JSON.stringify({ agentType: 42 }));
  await put(subdir, 'agent-bare.jsonl', transcript('No meta at all'));

  const rollup = await rollupSubagents(parent, 'sess-1');
  const byId = Object.fromEntries(rollup.subagents.map((s) => [s.id, s.agentType]));
  assert.deepEqual(byId, { typed: 'sales', broken: null, wrongtype: null, bare: null });
  assert.equal(rollup.count, 4, 'a bad meta.json never costs a run its row');
});
