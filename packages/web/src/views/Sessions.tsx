import { useMemo, useState, type ReactNode } from 'react';

import type { SessionStatus } from '@pebble/core';
import { api } from '../lib/api.ts';
import { useAsync, useClock, navigate, type Route } from '../lib/hooks.ts';
import { Empty, FilterPills, Note, Section } from '../components/ui.tsx';
import { SessionList } from './Fleet.tsx';

const STATUS_OPTIONS: Array<{ value: SessionStatus; label: string }> = [
  { value: 'active', label: 'active' },
  { value: 'waiting', label: 'needs you' },
  { value: 'idle', label: 'idle' },
  { value: 'done', label: 'done' },
];

export function Sessions(props: { route: Route; reloadToken: number }): ReactNode {
  const projectFromRoute = props.route.params.project ?? '';
  const [statuses, setStatuses] = useState<SessionStatus[]>([]);
  const [search, setSearch] = useState('');
  const [project, setProject] = useState(projectFromRoute);
  const [model, setModel] = useState('');
  const now = useClock();

  // Changing the filter changes the query, so the list is server-filtered rather
  // than fetched-then-sliced: the index is the thing that knows how to filter.
  const state = useAsync(
    () =>
      api.sessions({
        status: statuses.length > 0 ? statuses.join(',') : undefined,
        q: search || undefined,
        project: project || undefined,
        model: model || undefined,
        limit: 500,
      }),
    [statuses.join(','), search, project, model, props.reloadToken],
  );

  const overview = useAsync(() => api.overview(), [props.reloadToken]);
  const analytics = useAsync(() => api.analytics(90), [props.reloadToken]);

  const projects = useMemo(() => overview.data?.projects ?? [], [overview.data]);
  const models = useMemo(() => analytics.data?.models ?? [], [analytics.data]);

  const toggleStatus = (value: SessionStatus): void =>
    setStatuses((current) => (current.includes(value) ? current.filter((v) => v !== value) : [...current, value]));

  const filtersActive = statuses.length > 0 || search !== '' || project !== '' || model !== '';

  return (
    <Section
      title="Sessions"
      count={state.data?.total}
      note={state.refreshing ? 'refreshing…' : undefined}
      onRefresh={state.reload}
      refreshing={state.refreshing}
      actions={
        filtersActive ? (
          <button
            type="button"
            className="btn btn--plain"
            onClick={() => {
              setStatuses([]);
              setSearch('');
              setProject('');
              setModel('');
              navigate('#/sessions');
            }}
          >
            clear filters
          </button>
        ) : undefined
      }
    >
      <div className="pills">
        <FilterPills label="status" options={STATUS_OPTIONS} active={statuses} onToggle={toggleStatus} />
        <input
          className="search"
          type="search"
          placeholder="search titles and first prompts"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search sessions"
        />
        <label className="sr-only" htmlFor="project-filter">
          Project
        </label>
        <select
          id="project-filter"
          className="select"
          value={project}
          onChange={(event) => setProject(event.target.value)}
        >
          <option value="">every project</option>
          {projects.map((row) => (
            <option key={row.projectPath} value={row.projectPath}>
              {row.projectLabel} ({row.sessions})
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="model-filter">
          Model
        </label>
        <select id="model-filter" className="select" value={model} onChange={(event) => setModel(event.target.value)}>
          <option value="">every model</option>
          {models.map((row) => (
            <option key={row.model} value={row.model}>
              {row.model} ({row.sessions})
            </option>
          ))}
        </select>
      </div>

      {state.error && <Note tone="error">{state.error}</Note>}
      {state.loading && !state.data ? (
        <Empty>Loading…</Empty>
      ) : (
        <SessionList sessions={state.data?.sessions ?? []} now={now} pageSize={25} />
      )}
    </Section>
  );
}
