import { useState, type ReactNode } from 'react';

import type { SessionEvent, SubagentSummary } from '@pebble/core';
import { api } from '../lib/api.ts';
import { useAsync, useSort } from '../lib/hooks.ts';
import { absoluteTime, cacheHitRate, compactNumber, duration, money, percent, relativeTime, totalTokens } from '../lib/format.ts';
import {
  Badge,
  CostFigure,
  Disclose,
  Empty,
  FilterPills,
  IssueList,
  Meter,
  Note,
  Section,
  Stat,
  StatRow,
  StatusDot,
} from '../components/ui.tsx';
import { DataTable, type Column } from '../components/DataTable.tsx';

type SubKey = 'started' | 'model' | 'cost' | 'tools' | 'title';
type EventKindFilter = SessionEvent['kind'];

const KIND_OPTIONS: Array<{ value: EventKindFilter; label: string }> = [
  { value: 'prompt', label: 'your prompts' },
  { value: 'response', label: 'replies' },
  { value: 'tool-call', label: 'tool calls' },
  { value: 'tool-result', label: 'results' },
  { value: 'error', label: 'errors' },
  { value: 'hook', label: 'hooks' },
];

export function SessionDetail(props: { adapter: string; id: string; reloadToken: number }): ReactNode {
  const state = useAsync(() => api.session(props.adapter, props.id), [props.adapter, props.id, props.reloadToken]);
  const subSort = useSort<SubKey>('started', 'asc');
  const [kinds, setKinds] = useState<EventKindFilter[]>([]);

  if (state.loading && !state.data) return <Empty>Reading the transcript…</Empty>;
  if (state.error) return <Note tone="error">{state.error}</Note>;
  const detail = state.data;
  if (!detail) return null;

  const events = kinds.length === 0 ? detail.events : detail.events.filter((event) => kinds.includes(event.kind));
  const tools = Object.entries(detail.toolHistogram).sort((a, b) => b[1] - a[1]);
  const maxToolCalls = Math.max(...tools.map(([, n]) => n), 1);
  const hitRate = cacheHitRate(detail.tokens);

  const subColumns: Column<SubagentSummary, SubKey>[] = [
    { key: 'started', header: 'started', numeric: true, render: (row) => <span className="faint">{absoluteTime(row.startedAt)}</span> },
    { key: 'model', header: 'model', render: (row) => <span className="mono small">{row.models.join(', ') || '—'}</span> },
    { key: 'cost', header: 'cost', numeric: true, render: (row) => <CostFigure cost={row.cost} /> },
    { key: 'tools', header: 'tools', numeric: true, render: (row) => row.toolCalls },
    {
      header: 'flags',
      render: (row) => (row.errorCount > 0 ? <Badge tone="warn">{row.errorCount} err</Badge> : <span className="faint">—</span>),
    },
    {
      key: 'title',
      header: 'task',
      render: (row) => (
        <span className="truncate" title={row.title}>
          {row.title}
        </span>
      ),
    },
  ];

  return (
    <>
      <Section
        title={detail.title}
        note={detail.titleSource === 'prompt' ? 'named from its first prompt' : `named from ${detail.titleSource}`}
        onRefresh={state.reload}
        refreshing={state.refreshing}
        actions={<a className="small" href="#/sessions">← all sessions</a>}
      >
        <StatRow>
          <Stat label="state" value={<StatusDot status={detail.status} />} />
          <Stat label="last seen" value={relativeTime(detail.lastActivityAt)} title={absoluteTime(detail.lastActivityAt)} />
          <Stat label="started" value={absoluteTime(detail.startedAt)} />
          <Stat label="prompts" value={detail.userTurns} />
          <Stat label="replies" value={detail.assistantTurns} />
          <Stat label="tool calls" value={detail.toolCalls} />
          {detail.pendingToolCalls > 0 && (
            <Stat
              label="unanswered"
              value={<span className="badge badge--warn">{detail.pendingToolCalls}</span>}
              title="Tool calls with no result in the transcript — usually a pending permission prompt."
            />
          )}
          {detail.errorCount > 0 && <Stat label="errors" value={<span className="badge badge--error">{detail.errorCount}</span>} />}
        </StatRow>

        <dl className="kv">
          <dt>project</dt>
          <dd className="mono small">{detail.projectPath}</dd>
          {detail.gitBranch && (
            <>
              <dt>branch</dt>
              <dd className="mono small">{detail.gitBranch}</dd>
            </>
          )}
          <dt>models</dt>
          <dd className="mono small">{detail.models.join(', ') || 'none recorded'}</dd>
          <dt>started by</dt>
          <dd className="small">
            {detail.entrypoint ?? 'unknown'}
            {detail.cliVersion && <span className="faint"> · v{detail.cliVersion}</span>}
            {detail.permissionMode && <span className="faint"> · {detail.permissionMode} permissions</span>}
          </dd>
          <dt>transcript</dt>
          <dd className="mono small">
            {detail.transcriptPath} <span className="faint">({compactNumber(detail.transcriptBytes)}B)</span>
          </dd>
        </dl>

        {detail.issues.length > 0 && <IssueList issues={detail.issues} />}
      </Section>

      <div className="grid-2">
        <Section title="Cost and tokens">
          <StatRow>
            <Stat label="this session" value={<CostFigure cost={detail.cost} />} />
            {detail.subagentCount > 0 && (
              <Stat
                label="its sub-agents"
                value={<CostFigure cost={detail.subagentCost} />}
                title="Counted separately — the transcripts do not say whether the reported session cost already includes sub-agents, so Pebble does not add them together."
              />
            )}
            {detail.apiDurationMs !== null && <Stat label="model time" value={duration(detail.apiDurationMs)} />}
            {detail.linesAdded !== null && (
              <Stat label="lines" value={`+${detail.linesAdded} / −${detail.linesRemoved ?? 0}`} />
            )}
          </StatRow>
          <dl className="kv">
            <dt>input</dt>
            <dd className="num">{compactNumber(detail.tokens.input)}</dd>
            <dt>output</dt>
            <dd className="num">
              {compactNumber(detail.tokens.output)}
              {detail.tokens.thinking > 0 && (
                <span className="faint small"> ({compactNumber(detail.tokens.thinking)} thinking)</span>
              )}
            </dd>
            <dt>cache read</dt>
            <dd className="num">{compactNumber(detail.tokens.cacheRead)}</dd>
            <dt>cache written</dt>
            <dd className="num">
              {compactNumber(detail.tokens.cacheWrite5m + detail.tokens.cacheWrite1h)}
              {detail.tokens.cacheWrite1h > 0 && (
                <span className="faint small"> ({compactNumber(detail.tokens.cacheWrite1h)} at the 1-hour TTL)</span>
              )}
            </dd>
            <dt>cache hit</dt>
            <dd className="num" title="Share of input tokens served from cache rather than charged at full rate.">
              {percent(hitRate, 1)}
            </dd>
            <dt>total</dt>
            <dd className="num">{compactNumber(totalTokens(detail.tokens))}</dd>
          </dl>
        </Section>

        <Section title="Tools used" count={tools.length}>
          {tools.length === 0 ? (
            <Empty>No tool calls in this session.</Empty>
          ) : (
            <table className="t t--compact">
              <tbody>
                {tools.map(([tool, count]) => (
                  <tr key={tool}>
                    <td className="mono small">{tool}</td>
                    <td className="num">{count}</td>
                    <td>
                      <Meter value={count} max={maxToolCalls} title={`${count} calls`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </div>

      {detail.subagents.length > 0 && (
        <Section
          title="Sub-agents"
          count={detail.subagents.length}
          note={
            <>
              <CostFigure cost={detail.subagentCost} /> in total, counted separately from the session above
            </>
          }
        >
          <DataTable
            rows={subSort.sort(detail.subagents, (row, key) =>
              key === 'started'
                ? Date.parse(row.startedAt)
                : key === 'model'
                  ? (row.models[0] ?? '')
                  : key === 'cost'
                    ? row.cost.usd
                    : key === 'tools'
                      ? row.toolCalls
                      : row.title,
            )}
            columns={subColumns}
            rowKey={(row) => row.id}
            sortKey={subSort.key}
            sortDirection={subSort.direction}
            onSort={subSort.toggle}
            pageSize={10}
            compact
          />
        </Section>
      )}

      <Section
        title="Timeline"
        count={events.length}
        note={kinds.length > 0 ? `filtered from ${detail.events.length}` : undefined}
        actions={
          <FilterPills
            label="event kinds"
            options={KIND_OPTIONS.map((option) => ({
              ...option,
              count: detail.events.filter((event) => event.kind === option.value).length,
            }))}
            active={kinds}
            onToggle={(value) =>
              setKinds((current) => (current.includes(value) ? current.filter((v) => v !== value) : [...current, value]))
            }
          />
        }
      >
        <Timeline events={events} />
      </Section>
    </>
  );
}

const KIND_LABEL: Record<SessionEvent['kind'], string> = {
  prompt: 'you',
  response: 'agent',
  'tool-call': 'call',
  'tool-result': 'result',
  error: 'error',
  hook: 'hook',
  meta: 'meta',
};

/**
 * Events oldest-first, in one scrollable column, with the long tail collapsed.
 *
 * Collapsing the middle rather than the end is deliberate: the start of a
 * session says what was asked and the end says how it went, and those are the
 * two parts anyone actually reads.
 */
function Timeline(props: { events: SessionEvent[] }): ReactNode {
  const HEAD = 15;
  const TAIL = 40;
  if (props.events.length === 0) return <Empty>No events match that filter.</Empty>;

  const collapsible = props.events.length > HEAD + TAIL;
  const head = collapsible ? props.events.slice(0, HEAD) : props.events;
  const middle = collapsible ? props.events.slice(HEAD, props.events.length - TAIL) : [];
  const tail = collapsible ? props.events.slice(props.events.length - TAIL) : [];

  return (
    <div className="timeline">
      {head.map((event) => (
        <EventRow key={event.uuid + event.seq} event={event} />
      ))}
      {collapsible && (
        <Disclose summary={`${middle.length} events in the middle`}>
          <div className="timeline">
            {middle.map((event) => (
              <EventRow key={event.uuid + event.seq} event={event} />
            ))}
          </div>
        </Disclose>
      )}
      {tail.map((event) => (
        <EventRow key={event.uuid + event.seq} event={event} />
      ))}
    </div>
  );
}

function EventRow(props: { event: SessionEvent }): ReactNode {
  const { event } = props;
  const isError = event.toolStatus === 'error' || event.kind === 'error';
  return (
    <div className={`ev ev--${event.kind}${isError ? ' is-error' : ''}`}>
      <span className="ev__kind">{KIND_LABEL[event.kind]}</span>
      <span className="ev__who mono small">
        {event.toolName ?? event.model ?? ''}
        {event.effort && <span className="faint"> {event.effort}</span>}
      </span>
      <span className="ev__text">
        {event.text}
        {event.tokens && event.tokens.output > 0 && (
          <span className="faint small"> · {compactNumber(event.tokens.output)} out</span>
        )}
      </span>
    </div>
  );
}
