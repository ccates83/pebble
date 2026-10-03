import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanClaudeConfig, findShadowed, decodeProjectDirName, encodeProjectPath } from '../dist/index.js';

/**
 * Builds a throwaway ~/.claude tree plus a project, and points the scanner at it
 * through PEBBLE_CLAUDE_DIR. Nothing in these tests touches the real one.
 */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'pebble-cfg-'));
  const claude = join(home, '.claude');
  const project = join(home, 'work', 'alpha');

  await mkdir(join(claude, 'agents'), { recursive: true });
  await mkdir(join(claude, 'commands'), { recursive: true });
  await mkdir(join(claude, 'skills', 'good'), { recursive: true });
  await mkdir(join(claude, 'skills', 'orphan-dir'), { recursive: true });
  await mkdir(join(claude, 'skills', 'synced', 'bucket-1', 'shared'), { recursive: true });
  await mkdir(join(project, '.claude', 'agents'), { recursive: true });

  await writeFile(join(claude, 'CLAUDE.md'), '# global memory\n');
  await writeFile(
    join(claude, 'settings.json'),
    JSON.stringify({
      model: 'opus',
      enabledPlugins: { 'thing@market': true },
      hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: './on-stop.sh', timeout: 5 }] }] },
      mcpServers: { local: { command: 'node', args: ['server.js'] } },
    }),
  );
  await writeFile(join(claude, 'settings.local.json'), '{ this is not json');
  await writeFile(join(claude, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews code\ntools: [Read, Grep]\n---\nReview it.\n');
  await writeFile(join(claude, 'agents', 'nameless.md'), '# no frontmatter at all\n');
  await writeFile(join(claude, 'commands', 'ship.md'), '---\ndescription: Ship a release\n---\nShip.\n');
  await writeFile(join(claude, 'skills', 'good', 'SKILL.md'), '---\nname: good\ndescription: Does a thing\n---\nSteps.\n');
  await writeFile(join(claude, 'skills', 'synced', 'bucket-1', 'shared', 'SKILL.md'), '---\nname: shared\ndescription: Synced\n---\nx.\n');
  await writeFile(join(project, 'CLAUDE.md'), '# project memory\n');
  await writeFile(join(project, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: [] } }));
  await writeFile(join(project, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash'] } }));
  await writeFile(join(project, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Project reviewer\n---\nReview.\n');
  await writeFile(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { remote: { url: 'https://example.test/mcp', type: 'http' } } }));
  await symlink(join(home, 'nowhere.md'), join(claude, 'commands', 'broken.md'));

  return { home, claude, project };
}

async function scan(project) {
  const surface = await scanClaudeConfig({ projectPaths: [project] });
  const find = (kind, name, scope) =>
    surface.items.find((item) => item.kind === kind && item.name === name && (scope ? item.scope === scope : true));
  return { surface, find };
}

test('scans every scope and kind of config', async (t) => {
  const { claude, project } = await fixture();
  process.env.PEBBLE_CLAUDE_DIR = claude;
  t.after(() => delete process.env.PEBBLE_CLAUDE_DIR);

  const { surface, find } = await scan(project);
  assert.equal(surface.root, claude);

  assert.ok(find('memory', 'CLAUDE.md', 'user'), 'global CLAUDE.md');
  assert.ok(find('memory', 'CLAUDE.md', 'project'), 'project CLAUDE.md');
  assert.ok(find('agent', 'reviewer', 'user'), 'global agent');
  assert.ok(find('agent', 'reviewer', 'project'), 'project agent');
  assert.ok(find('command', 'ship', 'user'), 'global command');
  assert.ok(find('skill', 'good', 'user'), 'global skill');
  assert.ok(find('hook', 'Stop[0.0]', 'user'), 'hook from settings');
  assert.ok(find('mcp-server', 'local', 'user'), 'stdio MCP server');
  assert.ok(find('mcp-server', 'remote', 'project'), 'http MCP server from .mcp.json');
  assert.ok(find('plugin', 'thing@market', 'user'), 'enabled plugin');
});

test('frontmatter becomes searchable metadata', async (t) => {
  const { claude, project } = await fixture();
  process.env.PEBBLE_CLAUDE_DIR = claude;
  t.after(() => delete process.env.PEBBLE_CLAUDE_DIR);

  const { find } = await scan(project);
  const agent = find('agent', 'reviewer', 'user');
  assert.equal(agent.description, 'Reviews code');
  assert.equal(agent.meta.tools, 'Read, Grep');
  assert.ok(agent.meta.bodyChars > 0);
});

test('a definition with no description is reported, because the model selects on it', async (t) => {
  const { claude, project } = await fixture();
  process.env.PEBBLE_CLAUDE_DIR = claude;
  t.after(() => delete process.env.PEBBLE_CLAUDE_DIR);

  const { find } = await scan(project);
  const nameless = find('agent', 'nameless', 'user');
  assert.ok(nameless.issues.some((issue) => issue.code === 'definition.no-frontmatter'));
});

test('invalid JSON in a settings file is an error, not a silent skip', async (t) => {
  const { claude, project } = await fixture();
  process.env.PEBBLE_CLAUDE_DIR = claude;
  t.after(() => delete process.env.PEBBLE_CLAUDE_DIR);

  const { find } = await scan(project);
  const broken = find('settings', 'settings.local.json', 'user');
  assert.ok(broken.issues.some((issue) => issue.code === 'settings.invalid-json' && issue.level === 'error'));
});

test('a symlink with no target is an error, since the tool sees nothing there', async (t) => {
  const { claude, project } = await fixture();
  process.env.PEBBLE_CLAUDE_DIR = claude;
  t.after(() => delete process.env.PEBBLE_CLAUDE_DIR);

  const { find } = await scan(project);
  const broken = find('command', 'broken', 'user');
  assert.equal(broken.exists, false);
  assert.ok(broken.issues.some((issue) => issue.code === 'path.broken-symlink'));
});

test('a directory under skills/ with no SKILL.md is flagged as invisible', async (t) => {
  const { claude, project } = await fixture();
  process.env.PEBBLE_CLAUDE_DIR = claude;
  t.after(() => delete process.env.PEBBLE_CLAUDE_DIR);

  const { find } = await scan(project);
  const orphan = find('skill', 'orphan-dir', 'user');
  assert.ok(orphan.issues.some((issue) => issue.code === 'skill.missing-manifest'));
});

test('an account-synced skill keeps its full path as its name and is not a collision', async (t) => {
  const { claude, project } = await fixture();
  process.env.PEBBLE_CLAUDE_DIR = claude;
  t.after(() => delete process.env.PEBBLE_CLAUDE_DIR);

  const { surface, find } = await scan(project);
  const synced = find('skill', 'synced/bucket-1/shared', 'user');
  assert.ok(synced, 'a nested skill is named by its path, so it cannot collide with a top-level one');
  assert.equal(synced.meta.synced, true);
  assert.equal(synced.issues.length, 0, 'the synced bucket is a known location, not an anomaly');
  assert.equal(surface.shadowed.filter((entry) => entry.name === 'shared').length, 0);
});

test('the local scope does not list the project definitions a second time', async (t) => {
  const { claude, project } = await fixture();
  process.env.PEBBLE_CLAUDE_DIR = claude;
  t.after(() => delete process.env.PEBBLE_CLAUDE_DIR);

  const { surface } = await scan(project);
  const reviewers = surface.items.filter((item) => item.kind === 'agent' && item.name === 'reviewer');
  assert.deepEqual(
    reviewers.map((item) => item.scope).sort(),
    ['project', 'user'],
    'settings.local.json shares a directory with the project definitions; they must not be counted twice',
  );
  assert.ok(surface.items.some((item) => item.kind === 'settings' && item.scope === 'local'));
});

test('a definition at two scopes is reported as shadowed, with the narrower one winning', async (t) => {
  const { claude, project } = await fixture();
  process.env.PEBBLE_CLAUDE_DIR = claude;
  t.after(() => delete process.env.PEBBLE_CLAUDE_DIR);

  const { surface } = await scan(project);
  const entry = surface.shadowed.find((row) => row.kind === 'agent' && row.name === 'reviewer');
  assert.ok(entry, 'reviewer is defined globally and in the project');
  assert.match(entry.winner, /:project:/);
  assert.equal(entry.shadowed.length, 1);
  assert.match(entry.shadowed[0], /:user:/);
});

test('a project Claude Code remembers but that no longer exists is reported, not scanned', async (t) => {
  const { claude } = await fixture();
  process.env.PEBBLE_CLAUDE_DIR = claude;
  t.after(() => delete process.env.PEBBLE_CLAUDE_DIR);

  const surface = await scanClaudeConfig({ projectPaths: ['/definitely/not/a/real/project'] });
  assert.ok(surface.issues.some((issue) => issue.code === 'project.missing'));
});

test('a missing config root is a warning with a usable instruction, not a failure', async (t) => {
  process.env.PEBBLE_CLAUDE_DIR = '/definitely/not/here/.claude';
  t.after(() => delete process.env.PEBBLE_CLAUDE_DIR);

  const surface = await scanClaudeConfig();
  const issue = surface.issues.find((row) => row.code === 'adapter.root-missing');
  assert.ok(issue);
  assert.match(issue.message, /CLAUDE_CONFIG_DIR/);
  // Having nothing to watch must not make `pebble doctor` exit non-zero.
  assert.equal(issue.level, 'warn');
});

test('one file reached by two routes is not an override of itself', () => {
  const item = (id, scope, realPath) => ({
    id,
    adapter: 'claude-code',
    kind: 'skill',
    scope,
    name: 'thing',
    path: `/a/${scope}/thing/SKILL.md`,
    realPath,
    exists: true,
    sizeBytes: 1,
    modifiedAt: null,
    project: null,
    description: null,
    meta: {},
    issues: [],
  });
  // Both entries resolve to the same file on disk — a symlinked config.
  assert.deepEqual(findShadowed([item('a', 'user', '/real/thing/SKILL.md'), item('b', 'project', '/real/thing/SKILL.md')]), []);
  // Two genuinely different files is a real override.
  assert.equal(findShadowed([item('a', 'user', '/real/one/SKILL.md'), item('b', 'project', '/real/two/SKILL.md')]).length, 1);
});

test('project directory names round-trip for paths without hyphens, and lossily for ones with', () => {
  assert.equal(encodeProjectPath('/Users/me/work/alpha'), '-Users-me-work-alpha');
  assert.equal(decodeProjectDirName('-Users-me-work-alpha'), '/Users/me/work/alpha');
  // Documented limitation, asserted so nobody "fixes" the decoder into lying.
  assert.equal(decodeProjectDirName('-Users-me-connor-cates-site'), '/Users/me/connor/cates/site');
});
