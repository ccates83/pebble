import type { AgentAdapter, Issue, SessionSource } from './types.ts';
import type { AdapterRegistry } from './registry.ts';
import type { PebbleStore } from './store/index.ts';
import { DEFAULT_WINDOWS, type StatusWindows } from './status.ts';
import { mapLimit } from './util.ts';

export interface IndexOptions {
  /** Re-read every session even when its file has not changed. */
  force?: boolean;
  concurrency?: number;
  windows?: StatusWindows;
}

export interface AdapterIndexResult {
  adapter: string;
  scanned: number;
  updated: number;
  skipped: number;
  pruned: number;
  failed: number;
  issues: Issue[];
}

export interface IndexResult {
  startedAt: string;
  durationMs: number;
  adapters: AdapterIndexResult[];
  updated: number;
}

/**
 * Walks every adapter and brings the store up to date.
 *
 * Incremental when the adapter can describe its sources cheaply, a full re-read
 * when it cannot. Either way the write is a whole-row replace derived from the
 * file, so a partial read can never corrupt a good row — it just fails and says
 * so in `failed`.
 */
export class Indexer {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly store: PebbleStore,
  ) {}

  async indexAll(options: IndexOptions = {}): Promise<IndexResult> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const results: AdapterIndexResult[] = [];

    for (const adapter of this.registry.all()) {
      results.push(await this.indexAdapter(adapter, options));
    }

    const windows = options.windows ?? DEFAULT_WINDOWS;
    this.store.refreshStatuses(Date.now(), windows.activeMs, windows.idleMs);
    this.store.setMeta('last_indexed_at', new Date().toISOString());

    return {
      startedAt,
      durationMs: Date.now() - started,
      adapters: results,
      updated: results.reduce((sum, r) => sum + r.updated, 0),
    };
  }

  private async indexAdapter(adapter: AgentAdapter, options: IndexOptions): Promise<AdapterIndexResult> {
    const result: AdapterIndexResult = {
      adapter: adapter.id,
      scanned: 0,
      updated: 0,
      skipped: 0,
      pruned: 0,
      failed: 0,
      issues: [],
    };

    const presence = await adapter.detect();
    if (!presence.installed) {
      result.issues.push({
        level: 'info',
        code: 'adapter.not-installed',
        message: `${adapter.label} not found: ${presence.evidence}`,
      });
      return result;
    }

    const incremental = typeof adapter.listSources === 'function' && typeof adapter.summarizeSource === 'function';

    if (!incremental) {
      // Fallback path: the adapter can only hand us whole summaries.
      const sessions = await adapter.listSessions();
      result.scanned = sessions.length;
      for (const summary of sessions) {
        this.store.upsertSession(summary, {
          promptPreview: null,
          toolHistogram: {},
          sourceMtimeMs: Date.parse(summary.lastActivityAt) || Date.now(),
        });
        result.updated += 1;
      }
      result.pruned = this.store.pruneMissing(adapter.id, new Set(sessions.map((s) => s.id)));
      return result;
    }

    const sources = await adapter.listSources!();
    result.scanned = sources.length;

    const stale: SessionSource[] = options.force
      ? sources
      : sources.filter((s) => !this.store.isFresh(adapter.id, s.id, s.bytes, s.mtimeMs));
    result.skipped = sources.length - stale.length;

    await mapLimit(stale, options.concurrency ?? 8, async (source) => {
      try {
        const indexed = await adapter.summarizeSource!(source);
        if (!indexed) {
          result.failed += 1;
          return;
        }
        this.store.upsertSession(indexed.summary, {
          promptPreview: indexed.promptPreview,
          toolHistogram: indexed.toolHistogram,
          sourceMtimeMs: indexed.sourceMtimeMs,
          subagents: indexed.subagents,
        });
        result.updated += 1;
      } catch (error) {
        result.failed += 1;
        result.issues.push({
          level: 'warn',
          code: 'index.source-failed',
          message: `Could not index ${source.id}: ${(error as Error).message}`,
          path: source.path,
        });
      }
    });

    result.pruned = this.store.pruneMissing(adapter.id, new Set(sources.map((s) => s.id)));
    return result;
  }
}

export interface IndexLoopOptions extends IndexOptions {
  intervalMs?: number;
  onResult?: (result: IndexResult) => void;
  onError?: (error: Error) => void;
}

/**
 * Re-indexes on a timer.
 *
 * This is the whole live-update mechanism in v1, and it is deliberately a poll
 * rather than a hook: nothing is written into anyone's Claude Code config to
 * make Pebble work. A full pass over an unchanged tree is a readdir and a stat
 * per session, so polling every couple of seconds costs approximately nothing.
 */
export class IndexLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly indexer: Indexer,
    private readonly options: IndexLoopOptions = {},
  ) {}

  get intervalMs(): number {
    return this.options.intervalMs ?? 2_000;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const tick = async (): Promise<void> => {
      if (this.running || this.stopped) return;
      this.running = true;
      try {
        const result = await this.indexer.indexAll(this.options);
        this.options.onResult?.(result);
      } catch (error) {
        this.options.onError?.(error as Error);
      } finally {
        this.running = false;
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
