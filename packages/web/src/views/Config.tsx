import { useMemo, useState, type ReactNode } from 'react';

import type { ConfigItem, ConfigKind, ConfigScope } from '@pebble/core';
import { api } from '../lib/api.ts';
import { useAsync, useSort } from '../lib/hooks.ts';
import { compactNumber, relativeTime, shortPath } from '../lib/format.ts';
import { Badge, Disclose, Empty, FilterPills, Note, Section } from '../components/ui.tsx';
import { DataTable, type Column } from '../components/DataTable.tsx';

type ItemKey = 'kind' | 'scope' | 'name' | 'project' | 'size' | 'modified';

const KIND_ORDER: ConfigKind[] = ['memory', 'agent', 'skill', 'command', 'hook', 'mcp-server', 'plugin', 'settings'];

const KIND_LABEL: Record<ConfigKind, string> = {
  memory: 'CLAUDE.md',
  agent: 'agents',
  skill: 'skills',
  command: 'commands',
  hook: 'hooks',
  'mcp-server': 'MCP servers',
  plugin: 'plugins',
  settings: 'settings',
};

const SCOPE_OPTIONS: Array<{ value: ConfigScope; label: string }> = [
  { value: 'user', label: 'global' },
  { value: 'project', label: 'project' },
  { value: 'local', label: 'local' },
  { value: 'plugin', label: 'plugin' },
];

/**
 * The fleet inventory: every agent, skill, command, hook and MCP server this
 * machine would load, where it comes from, and what is wrong with it.
 *
 * The question this page exists to answer is "what is actually in effect?" — the
 * one a sprawling config makes impossible to answer by reading files.
 */
export function Config(props: { reloadToken: number }): ReactNode {
  const [refreshNonce, setRefreshNonce] = useState(0);
  const state = useAsync(() => api.config(refreshNonce > 0), [props.reloadToken, refreshNonce]);
  const [kinds, setKinds] = useState<ConfigKind[]>([]);
  const [scopes, setScopes] = useState<ConfigScope[]>([]);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [search, setSearch] = useState('');
  const sort = useSort<ItemKey>('kind', 'asc');

  const surface = state.data?.surfaces[0];

  const counts = useMemo(() => {
    const byKind = new Map<ConfigKind, number>();
    for (const item of surface?.items ?? []) byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
    return byKind;
  }, [surface]);

  const filtered = useMemo(() => {
    let items = surface?.items ?? [];
    if (kinds.length > 0) items = items.filter((item) => kinds.includes(item.kind));
    if (scopes.length > 0) items = items.filter((item) => scopes.includes(item.scope));
    if (onlyIssues) items = items.filter((item) => item.issues.length > 0);
    if (search) {
      const needle = search.toLowerCase();
      items = items.filter(
        (item) =>
          item.name.toLowerCase().includes(needle) ||
          (item.description ?? '').toLowerCase().includes(needle) ||
          item.path.toLowerCase().includes(needle),
      );
    }
    return items;
  }, [surface, kinds, scopes, onlyIssues, search]);

  if (state.loading && !state.data) return <Empty>Scanning every project Claude Code knows about…</Empty>;
  if (state.error && !state.data) return <Note tone="error">{state.error}</Note>;
  if (!surface) return null;

  const allIssues = [...surface.issues, ...surface.items.flatMap((item) => item.issues)];
  const errors = allIssues.filter((issue) => issue.level === 'error');
  const warnings = allIssues.filter((issue) => issue.level === 'warn');

  const columns: Column<ConfigItem, ItemKey>[] = [
    { key: 'kind', header: 'kind', render: (row) => <span className="faint small">{row.kind}</span> },
    { key: 'scope', header: 'scope', render: (row) => <span className="small">{row.scope}</span> },
    {
      key: 'name',
      header: 'name',
      render: (row) => (
        <span className="mono small" title={row.path}>
          {row.name}
        </span>
      ),
    },
    {
      key: 'project',
      header: 'where',
      render: (row) => (
        <span className="faint small nowrap" title={row.project ?? surface.root}>
          {row.project ? (row.project.split('/').pop() ?? row.project) : 'global'}
        </span>
      ),
    },
    {
      header: 'notes',
      render: (row) => (
        <span className="nowrap">
          {row.realPath && (
            <Badge title={`symlink → ${row.realPath}`} tone="accent">
              link
            </Badge>
          )}{' '}
          {row.meta.synced === true && <Badge title="Account-synced skill">synced</Badge>}{' '}
          {!row.exists && <Badge tone="error">missing</Badge>}{' '}
          {row.issues.length > 0 && (
            <Badge tone={row.issues.some((issue) => issue.level === 'error') ? 'error' : 'warn'} title={row.issues.map((i) => i.message).join('\n')}>
              {row.issues.length} issue{row.issues.length === 1 ? '' : 's'}
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: 'size',
      header: 'size',
      numeric: true,
      render: (row) => (row.sizeBytes === null ? <span className="faint">—</span> : `${compactNumber(row.sizeBytes)}B`),
    },
    {
      key: 'modified',
      header: 'changed',
      numeric: true,
      render: (row) => <span className="faint nowrap">{row.modifiedAt ? relativeTime(row.modifiedAt) : '—'}</span>,
    },
    {
      header: 'description',
      render: (row) => (
        <span className="truncate faint small" title={row.description ?? undefined}>
          {row.description ?? ''}
        </span>
      ),
    },
  ];

  return (
    <>
      <Section
        title="Fleet config"
        count={surface.items.length}
        note={`${shortPath(surface.root, 2)} · scanned ${relativeTime(surface.scannedAt)}`}
        onRefresh={() => setRefreshNonce((n) => n + 1)}
        refreshing={state.refreshing}
      >
        <div className="pills">
          <FilterPills
            label="kind"
            options={KIND_ORDER.filter((kind) => counts.has(kind)).map((kind) => ({
              value: kind,
              label: KIND_LABEL[kind],
              count: counts.get(kind),
            }))}
            active={kinds}
            onToggle={(value) =>
              setKinds((current) => (current.includes(value) ? current.filter((v) => v !== value) : [...current, value]))
            }
          />
        </div>
        <div className="pills">
          <FilterPills
            label="scope"
            options={SCOPE_OPTIONS.filter((option) => surface.items.some((item) => item.scope === option.value))}
            active={scopes}
            onToggle={(value) =>
              setScopes((current) => (current.includes(value) ? current.filter((v) => v !== value) : [...current, value]))
            }
          />
          <button type="button" className="pill" aria-pressed={onlyIssues} onClick={() => setOnlyIssues((v) => !v)}>
            only problems <span className="pill__n">{surface.items.filter((i) => i.issues.length > 0).length}</span>
          </button>
          <input
            className="search"
            type="search"
            placeholder="search names, paths, descriptions"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search config"
          />
        </div>

        {(errors.length > 0 || warnings.length > 0) && (
          <Note tone={errors.length > 0 ? 'error' : 'warn'}>
            {errors.length > 0 && (
              <>
                <strong>{errors.length} error{errors.length === 1 ? '' : 's'}</strong>
                {warnings.length > 0 && ' and '}
              </>
            )}
            {warnings.length > 0 && (
              <strong>
                {warnings.length} warning{warnings.length === 1 ? '' : 's'}
              </strong>
            )}{' '}
            across this config. <a href="#/doctor">See them grouped →</a>
          </Note>
        )}

        <DataTable
          rows={sort.sort(filtered, (row, key) =>
            key === 'kind'
              ? `${KIND_ORDER.indexOf(row.kind)}${row.name}`
              : key === 'scope'
                ? row.scope
                : key === 'name'
                  ? row.name
                  : key === 'project'
                    ? (row.project ?? '')
                    : key === 'size'
                      ? (row.sizeBytes ?? -1)
                      : row.modifiedAt
                        ? Date.parse(row.modifiedAt)
                        : 0,
          )}
          columns={columns}
          rowKey={(row) => row.id}
          sortKey={sort.key}
          sortDirection={sort.direction}
          onSort={sort.toggle}
          pageSize={30}
          compact
          empty="Nothing matches those filters."
        />
      </Section>

      {surface.shadowed.length > 0 && (
        <Section
          title="Defined more than once"
          count={surface.shadowed.length}
          note="a narrower scope overriding a broader one"
        >
          <p className="faint small">
            This is how overrides are supposed to work — it is listed so that an override you did not intend is
            visible rather than silent.
          </p>
          {surface.shadowed.map((entry) => (
            <Disclose key={`${entry.kind}-${entry.name}`} summary={`${entry.kind} ${entry.name}`}>
              <dl className="kv">
                <dt>in effect</dt>
                <dd className="mono small">{entry.winner}</dd>
                <dt>overridden</dt>
                <dd className="mono small">{entry.shadowed.join(', ')}</dd>
              </dl>
            </Disclose>
          ))}
        </Section>
      )}
    </>
  );
}
