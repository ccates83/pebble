import type { CSSProperties, ReactNode } from 'react';

import type { Cost, Issue, SessionStatus } from '@pebble/core';
import { costExplanation, money } from '../lib/format.ts';

// ---------------------------------------------------------------------------
// Section — the only container in Pebble. There is no card-inside-a-card.
// ---------------------------------------------------------------------------

export function Section(props: {
  title: string;
  count?: number;
  note?: ReactNode;
  actions?: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="section">
      <div className="section__head">
        <div className="section__title">
          <h2>{props.title}</h2>
          {props.count !== undefined && <span className="muted small">{props.count}</span>}
          {props.note && <span className="faint small">{props.note}</span>}
        </div>
        <div className="section__actions">
          {props.actions}
          {props.onRefresh && (
            <button
              type="button"
              className="btn btn--plain"
              onClick={props.onRefresh}
              disabled={props.refreshing}
              title="Re-read this section"
            >
              {props.refreshing ? 'refreshing…' : 'refresh'}
            </button>
          )}
        </div>
      </div>
      {props.children}
    </section>
  );
}

export function StatRow(props: { children: ReactNode }): ReactNode {
  return <div className="stat-row">{props.children}</div>;
}

/** A labelled number, inline where it is relevant — not a hero metric card. */
export function Stat(props: { label: string; value: ReactNode; title?: string }): ReactNode {
  return (
    <span className="stat" title={props.title}>
      <span className="stat__label">{props.label}</span>
      <span className="stat__value">{props.value}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Figures that carry their own provenance
// ---------------------------------------------------------------------------

/**
 * A dollar figure, marked when it is anything other than measured.
 *
 * The mark is the whole point: Pebble would rather show you an estimate you can
 * see is an estimate than a confident number that happens to be wrong.
 */
export function CostFigure(props: { cost: Cost; className?: string }): ReactNode {
  const { cost } = props;
  const explanation = costExplanation(cost);
  const variant = cost.conflict
    ? 'conflict'
    : cost.basis === 'estimated'
      ? 'estimated'
      : cost.basis === 'partial'
        ? 'partial'
        : null;
  const mark = cost.conflict ? '*' : cost.basis === 'estimated' ? '~' : cost.basis === 'partial' ? '?' : null;

  return (
    <span className={`figure${variant ? ` figure--${variant}` : ''}${props.className ? ` ${props.className}` : ''}`}>
      {money(cost.usd)}
      {mark && (
        <abbr className="figure__mark" title={explanation ?? undefined}>
          {mark}
        </abbr>
      )}
    </span>
  );
}

/**
 * A rollup figure — a project total, a day's spend, an all-time sum.
 *
 * A total built from any estimated, incomplete or disputed session is itself
 * uncertain, and saying so is the whole point of the design. Rendering a rollup
 * with bare `money()` is how a dashboard quietly launders a pile of estimates
 * into one confident number.
 */
export function Money(props: { usd: number; approximate?: boolean; reason?: string }): ReactNode {
  if (!props.approximate) return <span className="figure">{money(props.usd)}</span>;
  return (
    <span className="figure figure--estimated">
      {money(props.usd)}
      <abbr
        className="figure__mark"
        title={props.reason ?? 'Includes at least one session whose cost was estimated, incomplete, or disputed.'}
      >
        ~
      </abbr>
    </span>
  );
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  active: 'active',
  waiting: 'needs you',
  idle: 'idle',
  done: 'done',
};

export function StatusDot(props: { status: SessionStatus; title?: string }): ReactNode {
  return (
    <span className={`status status--${props.status}`} title={props.title}>
      <span className="status__dot" aria-hidden="true" />
      {STATUS_LABEL[props.status]}
    </span>
  );
}

export function Badge(props: { children: ReactNode; tone?: 'warn' | 'error' | 'live' | 'accent'; title?: string }): ReactNode {
  return (
    <span className={`badge${props.tone ? ` badge--${props.tone}` : ''}`} title={props.title}>
      {props.children}
    </span>
  );
}

export function Note(props: { tone?: 'warn' | 'error' | 'info'; children: ReactNode }): ReactNode {
  return <div className={`note${props.tone ? ` note--${props.tone}` : ''}`}>{props.children}</div>;
}

export function IssueList(props: { issues: Issue[]; limit?: number }): ReactNode {
  const limit = props.limit ?? 8;
  if (props.issues.length === 0) return null;
  const shown = props.issues.slice(0, limit);
  return (
    <div className="section">
      {shown.map((issue, index) => (
        <Note key={`${issue.code}-${index}`} tone={issue.level === 'error' ? 'error' : issue.level === 'warn' ? 'warn' : 'info'}>
          <strong className="mono small">{issue.code}</strong> {issue.message}
          {issue.path && (
            <>
              {' '}
              <span className="faint mono small">{issue.path}</span>
            </>
          )}
        </Note>
      ))}
      {props.issues.length > shown.length && <p className="faint small">…and {props.issues.length - shown.length} more.</p>}
    </div>
  );
}

export function Empty(props: { children: ReactNode }): ReactNode {
  return <p className="empty">{props.children}</p>;
}

export function Disclose(props: { summary: ReactNode; children: ReactNode; open?: boolean }): ReactNode {
  return (
    <details className="disclose" open={props.open}>
      <summary>
        <span className="disclose__caret" aria-hidden="true">
          ▶
        </span>
        {props.summary}
      </summary>
      <div className="disclose__body">{props.children}</div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Filter pills — visible, clickable state. Never a dropdown for a small set.
// ---------------------------------------------------------------------------

export interface PillOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

export function FilterPills<T extends string>(props: {
  options: PillOption<T>[];
  active: T[];
  onToggle: (value: T) => void;
  label: string;
}): ReactNode {
  return (
    <div className="pills" role="group" aria-label={props.label}>
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="pill"
          aria-pressed={props.active.includes(option.value)}
          onClick={() => props.onToggle(option.value)}
        >
          {option.label}
          {option.count !== undefined && <span className="pill__n">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Charts: inline markup, no charting library for two shapes.
//
// These are the only components that touch the `style` attribute, and they use
// it solely to hand a CSS custom property to the stylesheet. A bar's height
// comes from data, so it cannot live in a class — but its colour, radius and
// transition still do. No component sets a colour, font or spacing inline.
// ---------------------------------------------------------------------------

/** Passes a numeric magnitude to CSS without styling anything in JS. */
function cssVar(name: string, value: number): CSSProperties {
  return { [name]: String(value) } as CSSProperties;
}

export function Bars(props: {
  values: Array<{ label: string; value: number; approximate?: boolean; title?: string }>;
}): ReactNode {
  const max = Math.max(...props.values.map((v) => v.value), 0.000001);
  const first = props.values[0];
  const last = props.values[props.values.length - 1];
  return (
    <div>
      <div className="bars">
        {props.values.map((entry, index) => (
          <span
            key={`${entry.label}-${index}`}
            className={`bars__col${entry.approximate ? ' bars__col--approx' : ''}`}
            style={cssVar('--col-pct', Math.max((entry.value / max) * 100, entry.value > 0 ? 3 : 0))}
            title={entry.title ?? `${entry.label}: ${entry.value}`}
          />
        ))}
      </div>
      {first && last && (
        <div className="bars__axis">
          <span>{first.label}</span>
          <span>{last.label}</span>
        </div>
      )}
    </div>
  );
}

export function Meter(props: { value: number; max: number; title?: string }): ReactNode {
  const pct = props.max > 0 ? Math.min(100, (props.value / props.max) * 100) : 0;
  return (
    <span className="meter" title={props.title}>
      <span className="meter__fill" style={cssVar('--fill-pct', pct)} />
    </span>
  );
}
