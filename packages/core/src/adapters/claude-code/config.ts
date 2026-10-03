import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { ConfigItem, ConfigKind, ConfigScanOptions, ConfigScope, ConfigSurface, Issue } from '../../types.ts';
import { asString, parseFrontmatter } from '../../frontmatter.ts';
import { claudeRoot } from './paths.ts';
import { ADAPTER_ID } from './transcript.ts';

/** A CLAUDE.md past this size is quietly taxing every request in the project. */
const MEMORY_SIZE_WARN_BYTES = 40_000;

interface FileFacts {
  exists: boolean;
  isSymlink: boolean;
  realPath: string | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
  /** Set when the path is a symlink whose target is missing. */
  brokenLink: boolean;
}

async function inspect(path: string): Promise<FileFacts> {
  let linkStat;
  try {
    linkStat = await lstat(path);
  } catch {
    return { exists: false, isSymlink: false, realPath: null, sizeBytes: null, modifiedAt: null, brokenLink: false };
  }
  const isSymlink = linkStat.isSymbolicLink();
  let real: string | null = null;
  let target = linkStat;
  let brokenLink = false;
  if (isSymlink) {
    try {
      real = await realpath(path);
      target = await stat(path);
    } catch {
      brokenLink = true;
    }
  }
  return {
    exists: !brokenLink,
    isSymlink,
    realPath: real,
    sizeBytes: brokenLink ? null : target.size,
    modifiedAt: brokenLink ? null : new Date(target.mtimeMs).toISOString(),
    brokenLink,
  };
}

async function readJson(path: string): Promise<{ value: unknown; issue: Issue | null }> {
  try {
    const text = await readFile(path, 'utf8');
    try {
      return { value: JSON.parse(text), issue: null };
    } catch (error) {
      return {
        value: null,
        issue: {
          level: 'error',
          code: 'settings.invalid-json',
          message: `Not valid JSON — Claude Code will ignore this file. ${(error as Error).message}`,
          path,
        },
      };
    }
  } catch {
    return { value: null, issue: null };
  }
}

async function listFiles(dir: string, extension: string, recursive: boolean): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) found.push(...(await listFiles(full, extension, true)));
      continue;
    }
    if (entry.name.endsWith(extension)) found.push(full);
  }
  return found;
}

function itemId(kind: ConfigKind, scope: ConfigScope, name: string, project: string | null): string {
  return `${ADAPTER_ID}:${kind}:${scope}:${name}@${project ?? 'global'}`;
}

async function baseItem(
  kind: ConfigKind,
  scope: ConfigScope,
  name: string,
  path: string,
  project: string | null,
): Promise<ConfigItem> {
  const facts = await inspect(path);
  const issues: Issue[] = [];
  if (facts.brokenLink) {
    issues.push({
      level: 'error',
      code: 'path.broken-symlink',
      message: 'This is a symlink and its target does not exist, so Claude Code sees nothing here.',
      path,
    });
  }
  return {
    id: itemId(kind, scope, name, project),
    adapter: ADAPTER_ID,
    kind,
    scope,
    name,
    path,
    realPath: facts.realPath,
    exists: facts.exists,
    sizeBytes: facts.sizeBytes,
    modifiedAt: facts.modifiedAt,
    project,
    description: null,
    meta: {},
    issues,
  };
}

/** agents/*.md, skills/<name>/SKILL.md, commands/**\/*.md all carry frontmatter. */
async function definitionItem(
  kind: Extract<ConfigKind, 'agent' | 'skill' | 'command'>,
  scope: ConfigScope,
  path: string,
  project: string | null,
  rootDir: string,
): Promise<ConfigItem> {
  // A skill is named by its directory relative to `skills/`, not just the leaf.
  // Account-synced skills live at `skills/synced/<bucket>/<name>/SKILL.md`, so a
  // leaf-only name would collide with a top-level skill of the same name — and
  // reporting two different files under one name is how an inventory starts lying.
  const nameFromPath =
    kind === 'skill'
      ? relative(rootDir, dirname(path)).split(sep).join('/') || basename(dirname(path))
      : relative(rootDir, path).replace(/\.md$/, '').split(sep).join(':');
  const item = await baseItem(kind, scope, nameFromPath, path, project);
  if (!item.exists) return item;

  let content = '';
  try {
    content = await readFile(path, 'utf8');
  } catch {
    item.issues.push({ level: 'error', code: 'file.unreadable', message: 'Could not be read.', path });
    return item;
  }

  const fm = parseFrontmatter(content);
  const declaredName = asString(fm.data.name);
  const description = asString(fm.data.description);
  item.description = description;
  item.meta = {
    declaredName: declaredName ?? null,
    model: asString(fm.data.model),
    tools: asString(fm.data.tools),
    allowedTools: asString(fm.data['allowed-tools']),
    argumentHint: asString(fm.data['argument-hint']),
    bodyChars: fm.body.trim().length,
  };

  if (!fm.present) {
    item.issues.push({
      level: kind === 'command' ? 'info' : 'warn',
      code: 'definition.no-frontmatter',
      message:
        kind === 'command'
          ? 'No frontmatter. Commands work without it, but a description makes the command list readable.'
          : 'No frontmatter block, so this has no description for the model to select on.',
      path,
    });
  } else if (!description) {
    item.issues.push({
      level: kind === 'skill' ? 'error' : 'warn',
      code: 'definition.no-description',
      message:
        kind === 'skill'
          ? 'A skill with no `description` can never be selected — that field is how the model decides to load it.'
          : 'No `description` in frontmatter, so the model has little to go on when choosing this.',
      path,
    });
  }

  const leafName = kind === 'skill' ? basename(dirname(path)) : nameFromPath;
  if (declaredName && kind === 'skill' && declaredName !== leafName) {
    item.issues.push({
      level: 'warn',
      code: 'definition.name-mismatch',
      message: `Frontmatter says \`name: ${declaredName}\` but the directory is \`${leafName}\`. The directory wins.`,
      path,
    });
  }

  if (fm.body.trim().length === 0) {
    item.issues.push({ level: 'warn', code: 'definition.empty-body', message: 'Frontmatter but no instructions below it.', path });
  }

  return item;
}

function hookItems(settings: unknown, scope: ConfigScope, path: string, project: string | null): ConfigItem[] {
  if (typeof settings !== 'object' || settings === null) return [];
  const hooks = (settings as { hooks?: unknown }).hooks;
  if (typeof hooks !== 'object' || hooks === null) return [];
  const items: ConfigItem[] = [];

  for (const [event, value] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    value.forEach((matcherEntry, matcherIndex) => {
      if (typeof matcherEntry !== 'object' || matcherEntry === null) return;
      const matcher = (matcherEntry as { matcher?: unknown }).matcher;
      const list = (matcherEntry as { hooks?: unknown }).hooks;
      if (!Array.isArray(list)) return;
      list.forEach((hook, hookIndex) => {
        if (typeof hook !== 'object' || hook === null) return;
        const command = (hook as { command?: unknown }).command;
        const type = (hook as { type?: unknown }).type;
        const name = `${event}[${matcherIndex}.${hookIndex}]`;
        items.push({
          id: itemId('hook', scope, name, project),
          adapter: ADAPTER_ID,
          kind: 'hook',
          scope,
          name,
          path,
          realPath: null,
          exists: true,
          sizeBytes: null,
          modifiedAt: null,
          project,
          description: typeof command === 'string' ? command : null,
          meta: {
            event,
            matcher: typeof matcher === 'string' ? matcher : null,
            type: typeof type === 'string' ? type : 'command',
            timeout: typeof (hook as { timeout?: unknown }).timeout === 'number' ? (hook as { timeout: number }).timeout : null,
          },
          issues: [],
        });
      });
    });
  }
  return items;
}

function mcpItems(source: unknown, scope: ConfigScope, path: string, project: string | null): ConfigItem[] {
  if (typeof source !== 'object' || source === null) return [];
  const servers = (source as { mcpServers?: unknown }).mcpServers;
  if (typeof servers !== 'object' || servers === null) return [];
  return Object.entries(servers as Record<string, unknown>).map(([name, config]) => {
    const c = (typeof config === 'object' && config !== null ? config : {}) as Record<string, unknown>;
    const transport = typeof c.url === 'string' ? (typeof c.type === 'string' ? c.type : 'http') : 'stdio';
    const target = typeof c.url === 'string' ? c.url : typeof c.command === 'string' ? c.command : null;
    const args = Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === 'string') : [];
    return {
      id: itemId('mcp-server', scope, name, project),
      adapter: ADAPTER_ID,
      kind: 'mcp-server' as ConfigKind,
      scope,
      name,
      path,
      realPath: null,
      exists: true,
      sizeBytes: null,
      modifiedAt: null,
      project,
      description: target ? [target, ...args].join(' ') : null,
      meta: { transport, target, argCount: args.length },
      issues: [],
    };
  });
}

interface ScopeDirs {
  claudeDir: string;
  memoryFiles: string[];
  settingsFiles: string[];
  mcpJson: string | null;
  /**
   * Whether to scan agents/, commands/ and skills/ under `claudeDir`.
   *
   * Off for the `local` scope: `settings.local.json` lives in the same `.claude`
   * directory as the project's definitions, so scanning them again would list
   * every agent and command twice, once per scope, and invent a shadowing
   * conflict between a file and itself.
   */
  definitions: boolean;
}

/** Scans one scope rooted at a `.claude`-style directory. */
async function scanScope(scope: ConfigScope, dirs: ScopeDirs, project: string | null): Promise<ConfigItem[]> {
  const items: ConfigItem[] = [];

  for (const file of dirs.memoryFiles) {
    const facts = await inspect(file);
    if (!facts.exists && !facts.brokenLink) continue;
    const item = await baseItem('memory', scope, basename(file), file, project);
    item.meta = { chars: item.sizeBytes ?? 0 };
    if ((item.sizeBytes ?? 0) > MEMORY_SIZE_WARN_BYTES) {
      item.issues.push({
        level: 'warn',
        code: 'memory.large',
        message: `${Math.round((item.sizeBytes ?? 0) / 1024)} KB of instructions load on every request in this scope. Consider moving reference material into skills that load on demand.`,
        path: file,
      });
    }
    items.push(item);
  }

  for (const file of dirs.settingsFiles) {
    const facts = await inspect(file);
    if (!facts.exists && !facts.brokenLink) continue;
    const item = await baseItem('settings', scope, basename(file), file, project);
    const { value, issue } = await readJson(item.realPath ?? file);
    if (issue) item.issues.push(issue);
    if (typeof value === 'object' && value !== null) {
      const v = value as Record<string, unknown>;
      item.meta = {
        keys: Object.keys(v).join(', '),
        model: asString(v.model),
        hasHooks: Boolean(v.hooks),
        hasPermissions: Boolean(v.permissions),
      };
      items.push(...hookItems(value, scope, item.realPath ?? file, project));
      items.push(...mcpItems(value, scope, item.realPath ?? file, project));

      const enabled = v.enabledPlugins;
      if (typeof enabled === 'object' && enabled !== null) {
        for (const [pluginName, on] of Object.entries(enabled as Record<string, unknown>)) {
          items.push({
            id: itemId('plugin', scope, pluginName, project),
            adapter: ADAPTER_ID,
            kind: 'plugin',
            scope,
            name: pluginName,
            path: item.realPath ?? file,
            realPath: null,
            exists: true,
            sizeBytes: null,
            modifiedAt: null,
            project,
            description: on === true ? 'enabled' : 'disabled',
            meta: { enabled: on === true },
            issues: [],
          });
        }
      }
    }
    items.push(item);
  }

  if (dirs.mcpJson) {
    const facts = await inspect(dirs.mcpJson);
    if (facts.exists) {
      const { value, issue } = await readJson(dirs.mcpJson);
      if (issue) {
        const item = await baseItem('settings', scope, basename(dirs.mcpJson), dirs.mcpJson, project);
        item.issues.push(issue);
        items.push(item);
      }
      items.push(...mcpItems(value, scope, dirs.mcpJson, project));
    }
  }

  if (!dirs.definitions) return items;

  const agentsDir = join(dirs.claudeDir, 'agents');
  for (const file of await listFiles(agentsDir, '.md', true)) {
    items.push(await definitionItem('agent', scope, file, project, agentsDir));
  }

  const commandsDir = join(dirs.claudeDir, 'commands');
  for (const file of await listFiles(commandsDir, '.md', true)) {
    items.push(await definitionItem('command', scope, file, project, commandsDir));
  }

  const skillsDir = join(dirs.claudeDir, 'skills');
  let skillEntries: string[] = [];
  try {
    skillEntries = (await readdir(skillsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => join(skillsDir, e.name));
  } catch {
    skillEntries = [];
  }
  for (const dir of skillEntries) {
    const skillFile = join(dir, 'SKILL.md');
    const facts = await inspect(skillFile);
    if (!facts.exists && !facts.brokenLink) {
      // A directory under skills/ with no SKILL.md is invisible to Claude Code.
      const nested = await listFiles(dir, 'SKILL.md', true);
      if (nested.length === 0) {
        const item = await baseItem('skill', scope, basename(dir), skillFile, project);
        item.issues.push({
          level: 'warn',
          code: 'skill.missing-manifest',
          message: 'Directory under skills/ with no SKILL.md, so Claude Code will not see a skill here.',
          path: dir,
        });
        items.push(item);
        continue;
      }
      for (const file of nested) {
        const nestedItem = await definitionItem('skill', scope, file, project, skillsDir);
        // `skills/synced/<bucket>/<name>/SKILL.md` is where Claude Code puts
        // account-synced skills. That is expected, so it gets a flag rather than
        // a complaint; anything else nested deeper is worth a note.
        const isSynced = /(^|\/)synced\/[^/]+\/[^/]+$/.test(nestedItem.name);
        nestedItem.meta = { ...nestedItem.meta, synced: isSynced };
        if (!isSynced) {
          nestedItem.issues.push({
            level: 'info',
            code: 'skill.nested',
            message:
              'Deeper than skills/<name>/SKILL.md, and not in the account-synced bucket. Claude Code may not register it here.',
            path: file,
          });
        }
        items.push(nestedItem);
      }
      continue;
    }
    items.push(await definitionItem('skill', scope, skillFile, project, skillsDir));
  }

  return items;
}

/** Projects Claude Code knows about, from `~/.claude.json`. */
async function knownProjects(root: string): Promise<string[]> {
  const path = resolve(dirname(root), '.claude.json');
  const { value } = await readJson(path);
  if (typeof value !== 'object' || value === null) return [];
  const projects = (value as { projects?: unknown }).projects;
  if (typeof projects !== 'object' || projects === null) return [];
  return Object.keys(projects as Record<string, unknown>).filter((p) => isAbsolute(p));
}

/** Claude Code takes no extra scan options beyond the shared ones. */
export type ScanConfigOptions = ConfigScanOptions;

export async function scanClaudeConfig(options: ScanConfigOptions = {}): Promise<ConfigSurface> {
  const root = claudeRoot();
  const issues: Issue[] = [];
  const items: ConfigItem[] = [];

  const rootFacts = await inspect(root);
  if (!rootFacts.exists) {
    // A warning, not an error: having nothing to watch is a legitimate state —
    // Pebble on a machine without Claude Code is idle, not broken. The adapter's
    // own `detect()` already reports the absence, and `pebble doctor` exits
    // non-zero only on errors, so this must not fail a CI run.
    issues.push({
      level: 'warn',
      code: 'adapter.root-missing',
      message: `No Claude Code config directory at ${root}. Set CLAUDE_CONFIG_DIR if it lives elsewhere.`,
      path: root,
    });
    return { adapter: ADAPTER_ID, scannedAt: new Date().toISOString(), root, items, shadowed: [], issues };
  }

  items.push(
    ...(await scanScope(
      'user',
      {
        claudeDir: root,
        memoryFiles: [join(root, 'CLAUDE.md')],
        settingsFiles: [join(root, 'settings.json'), join(root, 'settings.local.json')],
        mcpJson: resolve(dirname(root), '.claude.json'),
        definitions: true,
      },
      null,
    )),
  );

  const fromConfig = await knownProjects(root);
  const projects = [...new Set([...(options.projectPaths ?? []), ...fromConfig])];
  const limited = typeof options.maxProjects === 'number' ? projects.slice(0, options.maxProjects) : projects;

  for (const project of limited) {
    const projectClaude = join(project, '.claude');
    const exists = await inspect(project);
    if (!exists.exists) {
      issues.push({
        level: 'info',
        code: 'project.missing',
        message: 'Claude Code has history for this directory but it no longer exists on disk.',
        path: project,
      });
      continue;
    }
    items.push(
      ...(await scanScope(
        'project',
        {
          claudeDir: projectClaude,
          memoryFiles: [join(project, 'CLAUDE.md'), join(project, 'CLAUDE.local.md')],
          settingsFiles: [join(projectClaude, 'settings.json')],
          mcpJson: join(project, '.mcp.json'),
          definitions: true,
        },
        project,
      )),
    );
    items.push(
      ...(await scanScope(
        'local',
        {
          claudeDir: projectClaude,
          memoryFiles: [],
          settingsFiles: [join(projectClaude, 'settings.local.json')],
          mcpJson: null,
          definitions: false,
        },
        project,
      )),
    );
  }

  const deduped = dedupeById(items);
  return {
    adapter: ADAPTER_ID,
    scannedAt: new Date().toISOString(),
    root,
    items: deduped,
    shadowed: findShadowed(deduped),
    issues,
  };
}

/** Keeps the first item seen for an id — scans go shallowest-first. */
function dedupeById(items: ConfigItem[]): ConfigItem[] {
  const seen = new Map<string, ConfigItem>();
  for (const item of items) if (!seen.has(item.id)) seen.set(item.id, item);
  return [...seen.values()];
}

const SCOPE_RANK: Record<ConfigScope, number> = { plugin: 0, user: 1, project: 2, local: 3 };

/**
 * Finds definitions that exist at more than one scope, the way the host resolves
 * them: per project.
 *
 * A project's `.claude/agents/review.md` shadows the global one **for that
 * project only**. Two different projects each defining `review` is not a
 * collision at all. So the comparison is global-vs-this-project and
 * project-vs-local within the same project — never project-vs-other-project.
 *
 * Entries that resolve to the same file on disk (a symlinked config reached by
 * two routes) are one definition, not an override.
 */
export function findShadowed(items: ConfigItem[]): ConfigSurface['shadowed'] {
  // Only kinds that resolve by name and precedence can shadow one another.
  //
  // `memory` is excluded because Claude Code *concatenates* CLAUDE.md files up
  // the tree rather than picking one — a project having its own is normal and
  // overrides nothing. `settings` merge key by key, `hooks` all run, and a
  // `plugin` enabled in two scopes is just enabled. Calling any of those an
  // override would be telling you something untrue about your own setup.
  const SHADOWABLE: ConfigKind[] = ['agent', 'skill', 'command', 'mcp-server'];
  const comparable = items.filter((item) => SHADOWABLE.includes(item.kind));
  const key = (item: ConfigItem): string => `${item.kind}\u0000${item.name}`;

  const globals = new Map<string, ConfigItem[]>();
  const byProject = new Map<string, Map<string, ConfigItem[]>>();

  for (const item of comparable) {
    const isGlobal = item.scope === 'user' || item.scope === 'plugin';
    if (isGlobal) {
      globals.set(key(item), [...(globals.get(key(item)) ?? []), item]);
      continue;
    }
    const project = item.project ?? '(unknown)';
    const inProject = byProject.get(project) ?? new Map<string, ConfigItem[]>();
    inProject.set(key(item), [...(inProject.get(key(item)) ?? []), item]);
    byProject.set(project, inProject);
  }

  const result: ConfigSurface['shadowed'] = [];

  const record = (group: ConfigItem[]): void => {
    if (group.length < 2) return;
    const distinctFiles = new Set(group.map((item) => item.realPath ?? item.path));
    if (distinctFiles.size < 2) return;
    const sorted = [...group].sort((a, b) => SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope]);
    const winner = sorted[0];
    if (!winner) return;
    result.push({
      kind: winner.kind,
      name: winner.name,
      winner: winner.id,
      shadowed: sorted.slice(1).map((item) => item.id),
    });
  };

  // Two global definitions of one name — typically a plugin and a user file.
  for (const group of globals.values()) record(group);

  // Each project, resolved against the globals it sits under.
  for (const inProject of byProject.values()) {
    for (const [name, group] of inProject.entries()) {
      record([...(globals.get(name) ?? []), ...group]);
    }
  }

  return result;
}
