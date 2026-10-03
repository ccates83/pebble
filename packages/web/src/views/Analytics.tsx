import { useState, type ReactNode } from 'react';

import { api } from '../lib/api.ts';
import { useAsync, useSort, navigate } from '../lib/hooks.ts';
import { compactNumber, money, relativeTime } from '../lib/format.ts';
import { Bars, Empty, FilterPills, Meter, Money, Note, Section, Stat, StatRow } from '../components/ui.tsx';
import { DataTable, type Column } from '../components/DataTable.tsx';

type ProjectKey = 'project' | 'sessions' | 'cost' | 'tokens' | 'last';
type ToolKey = 'tool' | 'calls' | 'sessions';

const WINDOWS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: 'a year' },
];

export function Analytics(props: { reloadToken: number }): ReactNode {
  const [days, setDays] = useState(30);
  const state = useAsync(() => api.analytics(days), [days, props.reloadToken]);
  const projectSort = useSort<ProjectKey>('cost');
  const toolSort = useSort<ToolKey>('calls');

  if (state.loading && !state.data) return <Empty>Loading…</Empty>;
  if (state.error && !state.data) return <Note tone="error">{state.error}</Note>;
  if (!state.data) return null;

  const { daily, projects, models, tools, stats } = state.data;
  const windowCost = daily.reduce((sum, day) => sum + day.costUsd, 0);
  const activeDays = daily.filter((day) => day.sessions > 0).length;
  const maxProjectCost = Math.max(...projects.map((p) => p.costUsd), 0.0001);
  const maxToolCalls = Math.max(...tools.map((t) => t.calls), 1);

  const projectColumns: Column<(typeof projects)[number], ProjectKey>[] = [
    { key: 'project', header: 'project', render: (row) => <span title={row.projectPath}>{row.projectLabel}</span> },
    {
      key: 'cost',
      header: 'cost',
      numeric: true,
      render: (row) => <Money usd={row.costUsd} approximate={row.approximate} />,
    },
    { header: 'share', render: (row) => <Meter value={row.costUsd} max={maxProjectCost} /> },
    { key: 'sessions', header: 'sessions', numeric: true, render: (row) => row.sessions },
    {
      header: 'per session',
      numeric: true,
      render: (row) => <Money usd={row.sessions > 0 ? row.costUsd / row.sessions : 0} approximate={row.approximate} />,
    },
    { key: 'tokens', header: 'tokens', numeric: true, render: (row) => compactNumber(row.tokens) },
    {
      key: 'last',
      header: 'last seen',
      numeric: true,
      render: (row) => <span className="faint nowrap">{relativeTime(row.lastActivityAt)}</span>,
    },
  ];

  const toolColumns: Column<(typeof tools)[number], ToolKey>[] = [
    { key: 'tool', header: 'tool', render: (row) => <span className="mono small">{row.tool}</span> },
    { key: 'calls', header: 'calls', numeric: true, render: (row) => row.calls },
    { header: 'share', render: (row) => <Meter value={row.calls} max={maxToolCalls} /> },
    { key: 'sessions', header: 'in sessions', numeric: true, render: (row) => row.sessions },
    {
      header: 'calls / session',
      numeric: true,
      render: (row) => (row.sessions > 0 ? (row.calls / row.sessions).toFixed(1) : '—'),
    },
  ];

  return (
    <>
      <Section
        title="Spend"
        note={`${activeDays} day${activeDays === 1 ? '' : 's'} with activity in this window`}
        onRefresh={state.reload}
        refreshing={state.refreshing}
        actions={
          <FilterPills
            label="window"
            options={WINDOWS}
            active={[String(days)]}
            onToggle={(value) => setDays(Number(value))}
          />
        }
      >
        <StatRow>
          <Stat label="window" value={<Money usd={windowCost} approximate={daily.some((day) => day.approximate)} />} />
          <Stat
            label="per active day"
            value={<Money usd={activeDays > 0 ? windowCost / activeDays : 0} approximate={daily.some((day) => day.approximate)} />}
          />
          <Stat label="all time" value={<Money usd={stats.costUsd} approximate={stats.approximateSessions > 0} />} />
          <Stat label="sessions" value={stats.sessions} />
          <Stat label="tokens" value={compactNumber(stats.tokens)} />
        </StatRow>
        {daily.length === 0 ? (
          <Empty>No activity in this window.</Empty>
        ) : (
          <Bars
            values={daily.map((day) => ({
              label: day.day.slice(5),
              value: day.costUsd,
              approximate: day.approximate,
              title: `${day.day}: ${money(day.costUsd)} across ${day.sessions} session${day.sessions === 1 ? '' : 's'}`,
            }))}
          />
        )}
        {stats.approximateSessions > 0 && (
          <p className="faint small">
            Hatched bars contain a figure Pebble estimated or disputes. <a href="#/doctor">Which ones →</a>
          </p>
        )}
      </Section>

      <Section title="By project" count={projects.length}>
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
          pageSize={12}
          compact
        />
      </Section>

      <div className="grid-2">
        <Section title="By model" count={models.length} note="sessions that used each">
          {models.length === 0 ? (
            <Empty>No models recorded.</Empty>
          ) : (
            <table className="t t--compact">
              <tbody>
                {models.map((row) => (
                  <tr key={row.model}>
                    <td className="mono small">{row.model}</td>
                    <td className="num">{row.sessions}</td>
                    <td>
                      <Meter value={row.sessions} max={Math.max(...models.map((m) => m.sessions))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="faint small">
            Counted per session, not per call: a session that used two models appears under both.
          </p>
        </Section>

        <Section title="Tool use" count={tools.length}>
          <DataTable
            rows={toolSort.sort(tools, (row, key) => (key === 'tool' ? row.tool : key === 'calls' ? row.calls : row.sessions))}
            columns={toolColumns}
            rowKey={(row) => row.tool}
            sortKey={toolSort.key}
            sortDirection={toolSort.direction}
            onSort={toolSort.toggle}
            pageSize={12}
            compact
          />
        </Section>
      </div>
    </>
  );
}
