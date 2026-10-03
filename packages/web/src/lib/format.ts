import type { Cost, TokenCounts } from '@pebble/core';

export function money(usd: number): string {
  if (usd === 0) return '$0.00';
  if (Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
  if (Math.abs(usd) >= 1000) return `$${Math.round(usd).toLocaleString('en-US')}`;
  return `$${usd.toFixed(2)}`;
}

export function compactNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 45) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

export function absoluteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

export function totalTokens(t: TokenCounts): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
}

/**
 * Cache efficiency: what share of input the cache served.
 *
 * Returns null rather than 0 when there was no input at all — "0% cache hit" and
 * "no requests yet" are different facts and should not look the same.
 */
export function cacheHitRate(t: TokenCounts): number | null {
  const denominator = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
  if (denominator === 0) return null;
  return t.cacheRead / denominator;
}

export function percent(value: number | null, digits = 0): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/** The human explanation behind a cost figure's provenance marker. */
export function costExplanation(cost: Cost): string | null {
  if (cost.conflict) {
    return (
      `Claude Code reports ${money(cost.conflict.reportedUsd)}; calculating from token usage gives ` +
      `${money(cost.conflict.computedUsd)}. The reported figure is shown. Both are kept — usually the ` +
      `price table is missing one of this session's models.`
    );
  }
  if (cost.basis === 'estimated') {
    return `Estimated: priced at the family rate because ${cost.unpricedModels.join(', ') || 'a model'} has no exact entry in the price table.`;
  }
  if (cost.basis === 'partial') {
    return `Incomplete: ${cost.unpricedModels.join(', ') || 'a model'} could not be priced, so its usage is missing from this total.`;
  }
  if (cost.basis === 'reported') return 'Reported by Claude Code itself.';
  return null;
}

export function shortPath(path: string, keep = 3): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= keep) return path;
  return `…/${parts.slice(-keep).join('/')}`;
}
