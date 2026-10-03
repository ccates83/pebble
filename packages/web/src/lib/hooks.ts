import { useCallback, useEffect, useRef, useState } from 'react';

import { subscribe, type StreamEvent } from './api.ts';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** True while refetching with data already on screen — no full-page spinner. */
  refreshing: boolean;
  reload: () => void;
}

/**
 * Loads data and keeps the previous value visible while reloading.
 *
 * A dashboard that blanks out every time it refreshes is unreadable, so the
 * first load is the only one that shows an empty state.
 */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);
  const generation = useRef(0);
  const hasData = useRef(false);

  useEffect(() => {
    const current = ++generation.current;
    if (hasData.current) setRefreshing(true);
    else setLoading(true);

    load()
      .then((value) => {
        if (generation.current !== current) return;
        setData(value);
        hasData.current = true;
        setError(null);
      })
      .catch((cause: unknown) => {
        if (generation.current !== current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (generation.current !== current) return;
        setLoading(false);
        setRefreshing(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, refreshing, reload };
}

/** Fires `onIndex` whenever the server reports that the index changed. */
export function useLiveIndex(onIndex: () => void): StreamEvent | null {
  const [last, setLast] = useState<StreamEvent | null>(null);
  const handler = useRef(onIndex);
  handler.current = onIndex;

  useEffect(() => {
    return subscribe((event) => {
      setLast(event);
      if (event.type === 'index') handler.current();
    });
  }, []);

  return last;
}

/** Hash routing. No router library for a six-view app. */
export interface Route {
  view: string;
  params: Record<string, string>;
}

function readHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path = '', search = ''] = raw.split('?');
  const segments = path.split('/').filter(Boolean);
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(search)) params[key] = value;
  if (segments[0] === 'session' && segments[1]) {
    params.adapter = segments[1];
    if (segments[2]) params.id = segments[2];
  }
  return { view: segments[0] ?? 'fleet', params };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(readHash);
  useEffect(() => {
    const update = (): void => setRoute(readHash());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}

export function navigate(hash: string): void {
  window.location.hash = hash;
}

/** Re-renders on a timer so "2m ago" does not sit there going stale. */
export function useClock(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** A sort state plus the comparator plumbing every table in Pebble uses. */
export function useSort<K extends string>(initialKey: K, initialDirection: 'asc' | 'desc' = 'desc') {
  const [key, setKey] = useState<K>(initialKey);
  const [direction, setDirection] = useState<'asc' | 'desc'>(initialDirection);

  const toggle = useCallback(
    (next: K) => {
      if (next === key) {
        setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
        return;
      }
      setKey(next);
      setDirection('desc');
    },
    [key],
  );

  const sort = useCallback(
    <T>(rows: T[], value: (row: T, key: K) => string | number | null): T[] => {
      const factor = direction === 'asc' ? 1 : -1;
      return [...rows].sort((a, b) => {
        const left = value(a, key);
        const right = value(b, key);
        if (left === right) return 0;
        if (left === null) return 1;
        if (right === null) return -1;
        if (typeof left === 'number' && typeof right === 'number') return (left - right) * factor;
        return String(left).localeCompare(String(right)) * factor;
      });
    },
    [key, direction],
  );

  return { key, direction, toggle, sort };
}
