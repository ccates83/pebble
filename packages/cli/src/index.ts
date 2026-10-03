import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AdapterRegistry,
  Indexer,
  PebbleStore,
  runDoctor,
  type ConfigSurface,
  type SessionStatus,
} from '@pebble/core';
import { DEFAULT_PORT, startServer } from '@pebble/server';

import { bold, compactNumber, costLabel, cyan, dim, green, money, red, relativeTime, statusMark, table, yellow } from './format.ts';

const HELP = `${bold('pebble')} — a local control center for your coding agents

${bold('Usage')}
  pebble serve [--port N] [--host H] [--open] [--poll MS]
  pebble sessions [--status s,s] [--project P] [--limit N] [--json]
  pebble show <session-id> [--events N] [--json]
  pebble config [--kind K] [--scope S] [--issues] [--json]
  pebble cost [--days N] [--json]
  pebble index [--force]
  pebble doctor [--json]
  pebble where

${bold('Commands')}
  serve      Run the dashboard and API (default ${DEFAULT_PORT}). Re-indexes on a timer.
  sessions   List agent sessions, newest first.
  show       One session in detail: timeline, tools, sub-agents.
  config     Inventory every agent, skill, command, hook and MCP server on this machine.
  cost       Spend per day, project and model.
  index      Re-read transcripts into the local index.
  doctor     Deterministic health check of the whole setup. No model calls.
  where      Print the paths Pebble reads and writes.

${bold('Notes')}
  Read-only. Pebble never writes to ~/.claude, never spawns an agent, and never
  makes a network request. Its own index lives in ~/.pebble and can be deleted
  at any time.

  A ${yellow('~')} after a dollar figure means it was estimated from a model Pebble
  does not have an exact price for; ${yellow('*')} means the host tool and Pebble
  disagree and both numbers are kept; ${red('?')} means part of it could not be priced.
`;

function webRoot(): string | undefined {
  // dist/index.js -> packages/cli/dist -> packages/cli -> packages
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, '../../web/dist');
  return existsSync(resolve(candidate, 'index.html')) ? candidate : undefined;
}

function openBrowser(url: string): void {
  // `open` is macOS; the others are best-effort and failure is silent on purpose
  // — not opening a browser is not worth an error message.
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  import('node:child_process')
    .then(({ spawn }) => {
      spawn(command, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
    })
    .catch(() => undefined);
}

function openStore(dbPath?: string): PebbleStore {
  return dbPath ? new PebbleStore(dbPath) : new PebbleStore();
}

async function freshIndex(store: PebbleStore, force = false): Promise<void> {
  const registry = new AdapterRegistry();
  await new Indexer(registry, store).indexAll({ force });
}

async function scanAll(registry: AdapterRegistry, store: PebbleStore): Promise<ConfigSurface[]> {
  const projectPaths = store.projectPaths();
  const surfaces: ConfigSurface[] = [];
  for (const adapter of registry.all()) surfaces.push(await adapter.scanConfig({ projectPaths }));
  return surfaces;
}

// ---------------------------------------------------------------------------

async function cmdServe(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      poll: { type: 'string' },
      db: { type: 'string' },
      open: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const root = webRoot();
  const server = await startServer({
    port: values.port ? Number(values.port) : undefined,
    host: values.host,
    pollMs: values.poll ? Number(values.poll) : undefined,
    dbPath: values.db,
    webRoot: root,
    onListen: ({ url }) => {
      process.stdout.write(`${bold('pebble')} ${dim('·')} ${cyan(url)}\n`);
      process.stdout.write(
        root
          ? `${dim('dashboard + API, polling for changes. ctrl-c to stop.')}\n`
          : `${yellow('API only')} ${dim('— the dashboard is not built. Run `pnpm build`, then restart.')}\n`,
      );
    },
    onIndex: (updated, ms) => {
      process.stdout.write(dim(`  indexed ${updated} session${updated === 1 ? '' : 's'} in ${ms}ms\n`));
    },
    onError: (error) => {
      process.stderr.write(red(`  index error: ${error.message}\n`));
    },
  });

  if (values.open) openBrowser(server.url);

  const shutdown = (): void => {
    process.stdout.write(dim('\nstopping…\n'));
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdSessions(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      status: { type: 'string' },
      project: { type: 'string' },
      model: { type: 'string' },
      q: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean', default: false },
      db: { type: 'string' },
    },
  });

  const store = openStore(values.db);
  await freshIndex(store);
  const statuses = values.status
    ? (values.status.split(',').map((s) => s.trim()) as SessionStatus[])
    : undefined;
  const sessions = store.listSessions({
    status: statuses,
    project: values.project,
    model: values.model,
    search: values.q,
    limit: values.limit ? Number(values.limit) : 30,
  });

  if (values.json) {
    process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
    store.close();
    return;
  }

  if (sessions.length === 0) {
    process.stdout.write(dim('No sessions matched.\n'));
    store.close();
    return;
  }

  process.stdout.write(
    `${table(
      sessions.map((s) => [
        statusMark(s.status),
        relativeTime(s.lastActivityAt),
        s.projectLabel.slice(0, 22),
        costLabel(s.cost.usd, s.cost.basis, s.cost.conflict !== undefined),
        `${s.userTurns}/${s.assistantTurns}`,
        String(s.toolCalls),
        s.subagentCount > 0 ? cyan(`${s.subagentCount} sub`) : dim('—'),
        s.errorCount > 0 ? yellow(`${s.errorCount} err`) : dim('—'),
        s.title.slice(0, 54),
      ]),
      { head: ['status', 'activity', 'project', 'cost', 'turns', 'tools', 'subs', 'errs', 'title'] },
    )}\n`,
  );
  process.stdout.write(dim(`\n${sessions.length} shown. \`pebble show <id>\` for one.\n`));
  store.close();
}

async function cmdShow(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { events: { type: 'string' }, json: { type: 'boolean', default: false } },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (!id) {
    process.stderr.write(red('Need a session id. `pebble sessions` lists them.\n'));
    process.exitCode = 1;
    return;
  }

  const registry = new AdapterRegistry();
  for (const adapter of registry.all()) {
    const detail = await adapter.readSession(id);
    if (!detail) continue;

    if (values.json) {
      process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
      return;
    }

    process.stdout.write(`${bold(detail.title)}\n`);
    process.stdout.write(
      dim(
        `${detail.adapter} · ${detail.projectPath}${detail.gitBranch ? ` · ${detail.gitBranch}` : ''}` +
          `${detail.cliVersion ? ` · v${detail.cliVersion}` : ''}\n`,
      ),
    );
    process.stdout.write(
      `\n${statusMark(detail.status)} ${dim('last activity')} ${relativeTime(detail.lastActivityAt)}` +
        ` ${dim('·')} ${detail.userTurns} prompts ${dim('·')} ${detail.assistantTurns} replies` +
        ` ${dim('·')} ${detail.toolCalls} tool calls\n`,
    );
    process.stdout.write(
      `${dim('own cost')}      ${costLabel(detail.cost.usd, detail.cost.basis, detail.cost.conflict !== undefined)}` +
        ` ${dim(`(${detail.cost.basis})`)}\n`,
    );
    if (detail.subagents.length > 0) {
      process.stdout.write(
        `${dim('sub-agents')}    ${costLabel(detail.subagentCost.usd, detail.subagentCost.basis, false)}` +
          ` ${dim(`across ${detail.subagents.length}, counted separately`)}\n`,
      );
    }
    process.stdout.write(
      `${dim('tokens')}        in ${compactNumber(detail.tokens.input)} ${dim('·')} out ${compactNumber(detail.tokens.output)}` +
        ` ${dim('·')} cache read ${compactNumber(detail.tokens.cacheRead)}` +
        ` ${dim('·')} cache write ${compactNumber(detail.tokens.cacheWrite5m + detail.tokens.cacheWrite1h)}\n`,
    );
    if (detail.models.length > 0) process.stdout.write(`${dim('models')}        ${detail.models.join(', ')}\n`);

    for (const issue of detail.issues) {
      const paint = issue.level === 'error' ? red : issue.level === 'warn' ? yellow : dim;
      process.stdout.write(`\n${paint(`${issue.level}: ${issue.message}`)}\n`);
    }

    const tools = Object.entries(detail.toolHistogram).sort((a, b) => b[1] - a[1]);
    if (tools.length > 0) {
      process.stdout.write(`\n${bold('Tools')}\n`);
      process.stdout.write(`${tools.map(([tool, n]) => `${tool} ${dim(`×${n}`)}`).join('  ')}\n`);
    }

    if (detail.subagents.length > 0) {
      process.stdout.write(`\n${bold('Sub-agents')}\n`);
      process.stdout.write(
        `${table(
          detail.subagents.map((sa) => [
            sa.id.slice(0, 10),
            sa.models.join(',') || dim('—'),
            costLabel(sa.cost.usd, sa.cost.basis, false),
            `${sa.toolCalls} tools`,
            sa.errorCount > 0 ? yellow(`${sa.errorCount} err`) : dim('—'),
            sa.title.slice(0, 58),
          ]),
        )}\n`,
      );
    }

    const limit = values.events ? Number(values.events) : 24;
    if (limit > 0) {
      process.stdout.write(`\n${bold('Timeline')} ${dim(`(last ${limit} of ${detail.events.length})`)}\n`);
      for (const event of detail.events.slice(-limit)) {
        const label =
          event.kind === 'prompt'
            ? green('you  ')
            : event.kind === 'response'
              ? cyan('agent')
              : event.kind === 'tool-call'
                ? dim('call ')
                : event.kind === 'tool-result'
                  ? event.toolStatus === 'error'
                    ? red('fail ')
                    : dim('ok   ')
                  : event.kind === 'error'
                    ? red('error')
                    : dim('hook ');
        const name = event.toolName ? `${event.toolName} ` : '';
        process.stdout.write(`  ${label} ${dim(name)}${(event.text ?? '').slice(0, 110)}\n`);
      }
    }
    return;
  }

  process.stderr.write(red(`No session "${id}" found in any adapter.\n`));
  process.exitCode = 1;
}

async function cmdConfig(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      kind: { type: 'string' },
      scope: { type: 'string' },
      issues: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      db: { type: 'string' },
    },
  });

  const store = openStore(values.db);
  await freshIndex(store);
  const registry = new AdapterRegistry();
  const surfaces = await scanAll(registry, store);

  if (values.json) {
    process.stdout.write(`${JSON.stringify(surfaces, null, 2)}\n`);
    store.close();
    return;
  }

  for (const surface of surfaces) {
    let items = surface.items;
    if (values.kind) items = items.filter((i) => i.kind === values.kind);
    if (values.scope) items = items.filter((i) => i.scope === values.scope);
    if (values.issues) items = items.filter((i) => i.issues.length > 0);

    process.stdout.write(`${bold(surface.adapter)} ${dim(surface.root)}\n`);

    const byKind = new Map<string, typeof items>();
    for (const item of items) byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item]);

    for (const [kind, group] of [...byKind.entries()].sort()) {
      process.stdout.write(`\n${bold(kind)} ${dim(`(${group.length})`)}\n`);
      process.stdout.write(
        `${table(
          group.slice(0, 60).map((item) => [
            item.scope,
            item.name.slice(0, 34),
            item.project ? dim(item.project.split('/').slice(-1)[0] ?? '') : dim('global'),
            item.realPath ? cyan('link') : '',
            item.issues.length > 0
              ? (item.issues.some((i) => i.level === 'error') ? red : yellow)(`${item.issues.length} issue`)
              : '',
            (item.description ?? '').slice(0, 58),
          ]),
        )}\n`,
      );
      if (group.length > 60) process.stdout.write(dim(`  …and ${group.length - 60} more\n`));
    }

    const allIssues = [...surface.issues, ...surface.items.flatMap((i) => i.issues)];
    if (allIssues.length > 0) {
      process.stdout.write(`\n${bold('Issues')} ${dim(`(${allIssues.length})`)}\n`);
      for (const issue of allIssues.slice(0, 40)) {
        const paint = issue.level === 'error' ? red : issue.level === 'warn' ? yellow : dim;
        process.stdout.write(`  ${paint(issue.level.padEnd(5))} ${issue.code} ${dim(issue.path ?? '')}\n    ${issue.message}\n`);
      }
    }
    if (surface.shadowed.length > 0) {
      process.stdout.write(`\n${bold('Defined at more than one scope')} ${dim(`(${surface.shadowed.length})`)}\n`);
      for (const s of surface.shadowed.slice(0, 20)) {
        process.stdout.write(`  ${s.kind} ${bold(s.name)} ${dim('→')} ${s.winner}\n`);
      }
    }
  }
  store.close();
}

async function cmdCost(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { days: { type: 'string' }, json: { type: 'boolean', default: false }, db: { type: 'string' } },
  });
  const store = openStore(values.db);
  await freshIndex(store);
  const days = values.days ? Number(values.days) : 30;
  const daily = store.dailyCost(days);
  const projects = store.projectRollup();
  const models = store.modelRollup();
  const stats = store.stats();

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ stats, daily, projects, models }, null, 2)}\n`);
    store.close();
    return;
  }

  process.stdout.write(
    `${bold('Spend')} ${dim(`last ${days} days · ${stats.sessions} sessions indexed`)}\n` +
      `${money(daily.reduce((sum, d) => sum + d.costUsd, 0))} ${dim('in window')} ${dim('·')} ` +
      `${money(stats.costUsd)} ${dim('all time')} ${dim('·')} ${compactNumber(stats.tokens)} ${dim('tokens')}\n`,
  );
  if (stats.approximateSessions > 0) {
    process.stdout.write(
      yellow(
        `\n${stats.approximateSessions} session${stats.approximateSessions === 1 ? '' : 's'} have an estimated or disputed cost — see \`pebble doctor\`.\n`,
      ),
    );
  }

  const max = Math.max(...daily.map((d) => d.costUsd), 0.0001);
  process.stdout.write(`\n${bold('By day')}\n`);
  for (const day of daily) {
    const width = Math.round((day.costUsd / max) * 34);
    process.stdout.write(
      `  ${dim(day.day)} ${money(day.costUsd).padStart(8)} ${day.approximate ? yellow('~') : ' '} ${cyan('█'.repeat(width))}\n`,
    );
  }

  process.stdout.write(`\n${bold('By project')}\n`);
  process.stdout.write(
    `${table(
      projects.slice(0, 15).map((p) => [
        money(p.costUsd).padStart(9),
        String(p.sessions),
        compactNumber(p.tokens),
        relativeTime(p.lastActivityAt),
        p.projectLabel.slice(0, 30),
      ]),
      { head: ['cost', 'n', 'tokens', 'last', 'project'] },
    )}\n`,
  );

  process.stdout.write(`\n${bold('By model')} ${dim('(sessions using each)')}\n`);
  process.stdout.write(`${models.map((m) => `${m.model} ${dim(`×${m.sessions}`)}`).join('\n')}\n`);
  store.close();
}

async function cmdIndex(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { force: { type: 'boolean', default: false }, db: { type: 'string' }, json: { type: 'boolean', default: false } },
  });
  const store = openStore(values.db);
  const result = await new Indexer(new AdapterRegistry(), store).indexAll({ force: values.force });

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const adapter of result.adapters) {
      process.stdout.write(
        `${bold(adapter.adapter)} ${dim('·')} ${adapter.scanned} found ${dim('·')} ${green(`${adapter.updated} indexed`)}` +
          ` ${dim('·')} ${adapter.skipped} unchanged` +
          `${adapter.pruned > 0 ? ` ${dim('·')} ${adapter.pruned} pruned` : ''}` +
          `${adapter.failed > 0 ? ` ${dim('·')} ${red(`${adapter.failed} failed`)}` : ''}\n`,
      );
      for (const issue of adapter.issues.slice(0, 10)) process.stdout.write(dim(`    ${issue.code}: ${issue.message}\n`));
    }
    process.stdout.write(dim(`${result.durationMs}ms · index at ${store.path}\n`));
  }
  store.close();
}

async function cmdDoctor(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean', default: false }, db: { type: 'string' } } });
  const store = openStore(values.db);
  await freshIndex(store);
  const registry = new AdapterRegistry();
  const report = await runDoctor(registry, store, await scanAll(registry, store));

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    store.close();
    process.exitCode = report.counts.error > 0 ? 1 : 0;
    return;
  }

  process.stdout.write(
    `${bold('pebble doctor')} ${dim('·')} ${green(`${report.counts.ok} ok`)} ${dim('·')} ` +
      `${report.counts.info} info ${dim('·')} ${yellow(`${report.counts.warn} warn`)} ${dim('·')} ${red(`${report.counts.error} error`)}\n\n`,
  );

  for (const check of report.checks) {
    const mark =
      check.level === 'ok' ? green('ok   ') : check.level === 'error' ? red('error') : check.level === 'warn' ? yellow('warn ') : dim('info ');
    process.stdout.write(`${mark} ${bold(check.title)}\n       ${dim(check.detail)}\n`);
    for (const item of check.items?.slice(0, 6) ?? []) {
      process.stdout.write(`       ${dim('·')} ${item.message.slice(0, 150)}\n`);
    }
  }
  store.close();
  process.exitCode = report.counts.error > 0 ? 1 : 0;
}

async function cmdWhere(): Promise<void> {
  const store = openStore();
  const registry = new AdapterRegistry();
  process.stdout.write(`${bold('reads')}\n`);
  for (const adapter of registry.all()) {
    const presence = await adapter.detect();
    process.stdout.write(
      `  ${adapter.label.padEnd(14)} ${presence.installed ? green('found') : yellow('missing')} ${dim(presence.evidence)}\n`,
    );
    for (const root of adapter.watchRoots()) process.stdout.write(`  ${''.padEnd(14)} ${dim(root)}\n`);
  }
  process.stdout.write(`\n${bold('writes')}\n  ${dim(store.path)} ${dim('(derived index — safe to delete)')}\n`);
  const web = webRoot();
  process.stdout.write(`\n${bold('dashboard assets')}\n  ${web ? dim(web) : yellow('not built — run `pnpm build`')}\n`);
  store.close();
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'serve':
      return cmdServe(rest);
    case 'sessions':
    case 'ls':
      return cmdSessions(rest);
    case 'show':
      return cmdShow(rest);
    case 'config':
      return cmdConfig(rest);
    case 'cost':
      return cmdCost(rest);
    case 'index':
      return cmdIndex(rest);
    case 'doctor':
      return cmdDoctor(rest);
    case 'where':
      return cmdWhere();
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(HELP);
      return;
    case '-v':
    case '--version':
      process.stdout.write('0.1.0\n');
      return;
    default:
      process.stderr.write(`${red(`Unknown command "${command}".`)}\n\n${HELP}`);
      process.exitCode = 1;
  }
}
