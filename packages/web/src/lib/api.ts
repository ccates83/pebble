import type {
  AdapterPresence,
  ConfigSurface,
  DailyCost,
  DoctorReport,
  IndexResult,
  IndexStats,
  ModelRollup,
  ProjectRollup,
  SessionDetail,
  SessionSummary,
  ToolRollup,
} from '@pebble/core';

export interface AdapterInfo extends AdapterPresence {
  id: string;
  label: string;
  kind: string;
}

export interface Overview {
  stats: IndexStats;
  live: SessionSummary[];
  recent: SessionSummary[];
  adapters: AdapterInfo[];
  projects: ProjectRollup[];
  daily: DailyCost[];
}

export interface SessionsPage {
  sessions: SessionSummary[];
  total: number;
}

export interface Analytics {
  daily: DailyCost[];
  projects: ProjectRollup[];
  models: ModelRollup[];
  tools: ToolRollup[];
  stats: IndexStats;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' }, ...init });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Not JSON; the status line is the best we have.
    }
    throw new ApiError(message, response.status);
  }
  return (await response.json()) as T;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const api = {
  overview: () => request<Overview>('/api/overview'),
  sessions: (params: { status?: string; project?: string; model?: string; q?: string; limit?: number }) =>
    request<SessionsPage>(`/api/sessions${query(params)}`),
  session: (adapter: string, id: string) =>
    request<SessionDetail>(`/api/sessions/${encodeURIComponent(adapter)}/${encodeURIComponent(id)}`),
  analytics: (days: number) => request<Analytics>(`/api/analytics${query({ days })}`),
  config: (refresh = false) => request<{ surfaces: ConfigSurface[] }>(`/api/config${query({ refresh: refresh ? 1 : undefined })}`),
  doctor: (refresh = false) => request<DoctorReport>(`/api/doctor${query({ refresh: refresh ? 1 : undefined })}`),
  reindex: (force = false) => request<IndexResult>(`/api/index${query({ force: force ? 1 : undefined })}`, { method: 'POST' }),
};

export interface StreamEvent {
  type: 'hello' | 'ping' | 'index';
  at: string;
  updated?: number;
  durationMs?: number;
}

/**
 * Subscribes to the server's event stream.
 *
 * EventSource reconnects on its own, so there is no retry logic here — adding
 * one would fight the browser.
 */
export function subscribe(onEvent: (event: StreamEvent) => void): () => void {
  const source = new EventSource('/api/stream');
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as StreamEvent);
    } catch {
      // A malformed frame is not worth tearing the stream down for.
    }
  };
  return () => source.close();
}
