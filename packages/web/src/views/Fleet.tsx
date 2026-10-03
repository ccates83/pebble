import type { ReactNode } from 'react';

import type { SessionSummary } from '@pebble/core';
import { api } from '../lib/api.ts';
import { useAsync, useClock, useSort, navigate } from '../lib/hooks.ts';
import { compactNumber, money, relativeTime } from '../lib/format.ts';
import { Badge, Bars, CostFigure, Empty, Meter, Money, Note, Section, Stat, StatRow, StatusDot } from '../components/ui.tsx';
import { DataTable, type Column } from '../components/DataTable.tsx';

type ProjectKey = 'project' | 'sessions' | 'cost' | 'tokens' | 'last';

/**
 * The home view: what is happening right now, what wants attention, and where
 * the money went. Nothing on this page is here to be impressive — if an element
 * neither tells you something new nor prompts an action, it was cut.
 */
export function Fleet(props: { reloadToken: number }): ReactNode {
  const state = useAsync(() => api.overview(), [props.reloadToken]);
  const now = useClock();
  const projectSort = useSort<ProjectKey>('last');

  if (state.loading && !state.data) return <Empty>Reading transcripts…</Empty>;
  if (state.error && !state.data) return <Note tone="error">Could not load: {state.error}</Note>;
  if (!state.data) return null;

  const { stats, live, recent, adapters, projects, daily } = state.data;
  const needsYou = live.filter((session) => session.status === 'waiting' || session.errorCount > 0);
  const working = live.filter((session) => session.status === 'active');
  const windowCost = daily.reduce((sum, day) => sum + day.costUsd, 0);
  const todayKey = new Date().toISOString().slice(0, 10);
  const today = daily.find((day) => day.day === todayKey);

  const projectColumns: Column<(typeof projects)[number], ProjectKey>[] = [
    {
      key: 'project',
      header: 'project',
      render: (row) => (
        <span title={row.projectPath}>
          {row.activeSessions > 0 && <Badge tone="live">{row.activeSessions} live</Badge>} {row.projectLabel}
        </span>
      ),
    },
    { key: 'sessions', header: 'sessions', numeric: true, render: (row) => row.sessions },
    {
      key: 'cost',
      header: 'cost',
      numeric: true,
      render: (row) => <Money usd={row.costUsd} approximate={row.approximate} reason={`A session in ${row.projectLabel} has an estimated, incomplete or disputed cost.`} />,
    },
    {
      header: 'share',
      render: (row) => (
        <Meter value={row.costUsd} max={Math.max(...projects.map((p) => p.costUsd))} title={`${money(row.costUsd)} of total`} />
      ),
    },
    { key: 'tokens', header: 'tokens', numeric: true, render: (row) => compactNumber(row.tokens) },
    {
      key: 'last',
      header: 'last seen',
      numeric: true,
      render: (row) => <span className="faint">{relativeTime(row.lastActivityAt, now)}</span>,
    },
  ];

  return (
    <>
      {needsYou.length > 0 && (
        <Section title="Needs you" count={needsYou.length} note="waiting on a human, or finished with errors">
          <SessionList sessions={needsYou} now={now} />
        </Section>
      )}

      <Section
        title="Working now"
        count={working.length}
        note={working.length === 0 ? 'nothing running' : undefined}
        onRefresh={state.reload}
        refreshing={state.refreshing}
      >
        {working.length === 0 ? (
          <Empty>
            No agent has written to a transcript in the last 90 seconds. Start one and this fills in on its own.
          </Empty>
        ) : (
          <SessionList sessions={working} now={now} />
        )}
      </Section>

      <div className="grid-2">
        <Section
          title="Spend"
          note={`last ${daily.length} days with activity`}
          actions={
            <a className="small" href="#/analytics">
              more →
            </a>
          }
        >
          <StatRow>
            <Stat label="window" value={<Money usd={windowCost} approximate={daily.some((day) => day.approximate)} />} />
            <Stat label="today" value={<Money usd={today?.costUsd ?? 0} approximate={today?.approximate ?? false} />} />
            <Stat
              label="all time"
              value={<Money usd={stats.costUsd} approximate={stats.approximateSessions > 0} />}
              title={`${stats.sessions} sessions indexed`}
            />
            <Stat label="tokens" value={compactNumber(stats.tokens)} />
          </StatRow>
          <Bars
            values={daily.map((day) => ({
              label: day.day.slice(5),
              value: day.costUsd,
              approximate: day.approximate,
              title: `${day.day}: ${money(day.costUsd)} across ${day.sessions} session${day.sessions === 1 ? '' : 's'}${
                day.approximate ? ' (contains an estimated figure)' : ''
              }`,
            }))}
          />
          {stats.approximateSessions > 0 && (
            <p className="faint small">
              {stats.approximateSessions} session{stats.approximateSessions === 1 ? '' : 's'} carry an estimated or
              disputed cost — hatched bars include one. <a href="#/doctor">See why →</a>
            </p>
          )}
        </Section>

        <Section title="Projects" count={projects.length}>
          <DataTable
            rows={projectSort.sort(projects, (row, key) =>
              key === 'project'
                ? row.projectLabel
                : key === 'sessions'
                  ? row.sessions
                  : key === 'cost'
                    ? row.costUsd
                    : key === 'tokens'
                      ? row.tokens
                      : Date.parse(row.lastActivityAt),
            )}
            columns={projectColumns}
            rowKey={(row) => row.projectPath}
            sortKey={projectSort.key}
            sortDirection={projectSort.direction}
            onSort={projectSort.toggle}
            onRowClick={(row) => navigate(`#/sessions?project=${encodeURIComponent(row.projectPath)}`)}
            pageSize={8}
            compact
          />
        </Section>
      </div>

      <Section title="Recent sessions" count={recent.length} actions={<a className="small" href="#/sessions">all →</a>}>
        <SessionList sessions={recent} now={now} pageSize={12} />
      </Section>

      <Section title="Tools Pebble is watching" count={adapters.length}>
        <div className="pills">
          {adapters.map((adapter) => (
            <span key={adapter.id} className="badge" title={adapter.evidence}>
              {adapter.installed ? '●' : '○'} {adapter.label}
              {adapter.version ? ` ${adapter.version}` : ''}
            </span>
          ))}
        </div>
        <p className="faint small">
          Read-only. Pebble parses what these tools leave on disk — it never writes to their config, spawns an agent,
          or makes a network request.
        </p>
      </Section>
    </>
  );
}

type SessionKey = 'status' | 'activity' | 'project' | 'cost' | 'turns' | 'tools' | 'title';

/** Shared session table, used on the fleet page and inside other views. */
export function SessionList(props: { sessions: SessionSummary[]; now: number; pageSize?: number }): ReactNode {
  const sort = useSort<SessionKey>('activity');
  const statusRank: Record<string, number> = { active: 3, waiting: 2, idle: 1, done: 0 };

  const columns: Column<SessionSummary, SessionKey>[] = [
    { key: 'status', header: 'status', render: (row) => <StatusDot status={row.status} /> },
    {
      key: 'activity',
      header: 'activity',
      numeric: true,
      render: (row) => <span className="faint nowrap">{relativeTime(row.lastActivityAt, props.now)}</span>,
    },
    {
      key: 'project',
      header: 'project',
      render: (row) => (
        <span className="nowrap" title={row.projectPath}>
          {row.projectLabel}
          {row.gitBranch && row.gitBranch !== 'HEAD' && <span className="faint small mono"> {row.gitBranch}</span>}
        </span>
      ),
    },
    { key: 'cost', header: 'cost', numeric: true, render: (row) => <CostFigure cost={row.cost} /> },
    {
      key: 'turns',
      header: 'turns',
      numeric: true,
      title: 'your prompts / model replies',
      render: (row) => (
        <span className="nowrap">
          {row.userTurns}
          <span className="faint">/{row.assistantTurns}</span>
        </span>
      ),
    },
    { key: 'tools', header: 'tools', numeric: true, render: (row) => row.toolCalls },
    {
      header: 'flags',
      render: (row) => (
        <span className="nowrap">
          {row.subagentCount > 0 && (
            <Badge tone="accent" title={`${row.subagentCount} sub-agents, costing a further ${money(row.subagentCost.usd)}`}>
              {row.subagentCount} sub
            </Badge>
          )}{' '}
          {row.errorCount > 0 && <Badge tone="warn" title="tool failures or API errors in this session">{row.errorCount} err</Badge>}
        </span>
      ),
    },
    {
      key: 'title',
      header: 'what it was doing',
      render: (row) => (
        <span className="truncate" title={row.title}>
          {row.title}
        </span>
      ),
    },
  ];

  return (
    <DataTable
      rows={sort.sort(props.sessions, (row, key) =>
        key === 'status'
          ? (statusRank[row.status] ?? 0)
          : key === 'activity'
            ? Date.parse(row.lastActivityAt)
            : key === 'project'
              ? row.projectLabel
              : key === 'cost'
                ? row.cost.usd
                : key === 'turns'
                  ? row.userTurns + row.assistantTurns
                  : key === 'tools'
                    ? row.toolCalls
                    : row.title,
      )}
      columns={columns}
      rowKey={(row) => `${row.adapter}:${row.id}`}
      sortKey={sort.key}
      sortDirection={sort.direction}
      onSort={sort.toggle}
      onRowClick={(row) => navigate(`#/session/${row.adapter}/${row.id}`)}
      pageSize={props.pageSize ?? 8}
      compact
      empty="No sessions."
    />
  );
}
