import { useState, type ReactNode } from 'react';

import type { Check } from '@pebble/core';
import { api } from '../lib/api.ts';
import { useAsync } from '../lib/hooks.ts';
import { relativeTime } from '../lib/format.ts';
import { Badge, Disclose, Empty, FilterPills, Note, Section } from '../components/ui.tsx';

type Level = Check['level'];

const LEVEL_OPTIONS: Array<{ value: Level; label: string }> = [
  { value: 'error', label: 'errors' },
  { value: 'warn', label: 'warnings' },
  { value: 'info', label: 'notes' },
  { value: 'ok', label: 'passing' },
];

const TONE: Record<Level, 'error' | 'warn' | 'live' | undefined> = {
  error: 'error',
  warn: 'warn',
  ok: 'live',
  info: undefined,
};

/**
 * Deterministic health check. No model is called to produce this page, which is
 * the only reason it is worth trusting as a check.
 */
export function Doctor(props: { reloadToken: number }): ReactNode {
  const [refreshNonce, setRefreshNonce] = useState(0);
  const state = useAsync(() => api.doctor(refreshNonce > 0), [props.reloadToken, refreshNonce]);
  const [levels, setLevels] = useState<Level[]>([]);

  if (state.loading && !state.data) return <Empty>Running checks…</Empty>;
  if (state.error && !state.data) return <Note tone="error">{state.error}</Note>;
  if (!state.data) return null;

  const report = state.data;
  const checks = levels.length === 0 ? report.checks : report.checks.filter((check) => levels.includes(check.level));

  return (
    <Section
      title="Doctor"
      note={`ran ${relativeTime(report.ranAt)} · nothing here calls a model`}
      onRefresh={() => setRefreshNonce((n) => n + 1)}
      refreshing={state.refreshing}
      actions={
        <FilterPills
          label="severity"
          options={LEVEL_OPTIONS.map((option) => ({ ...option, count: report.counts[option.value] }))}
          active={levels}
          onToggle={(value) =>
            setLevels((current) => (current.includes(value) ? current.filter((v) => v !== value) : [...current, value]))
          }
        />
      }
    >
      {report.counts.error === 0 && report.counts.warn === 0 && (
        <Note tone="info">Nothing is broken and nothing needs attention.</Note>
      )}

      {checks.length === 0 ? (
        <Empty>No checks at that severity.</Empty>
      ) : (
        checks.map((check) => (
          <div key={check.id} className="section">
            <div className="stat-row">
              <Badge tone={TONE[check.level]}>{check.level}</Badge>
              <strong>{check.title}</strong>
            </div>
            <p className="muted small">{check.detail}</p>
            {check.items && check.items.length > 0 && (
              <Disclose summary={`${check.items.length} affected`}>
                <ul className="small">
                  {check.items.map((item, index) => (
                    <li key={`${check.id}-${index}`} className="mono">
                      {item.message}
                    </li>
                  ))}
                </ul>
              </Disclose>
            )}
          </div>
        ))
      )}
    </Section>
  );
}
