import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Issue, SessionStatus, SessionSummary, SubagentSummary, TokenCounts } from '../types.ts';
import { pebbleDataDir } from '../paths.ts';
import { DATA_TABLES, SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts';

export interface SessionFilter {
  adapter?: string;
  status?: SessionStatus[];
  project?: string;
  model?: string;
  since?: string;
  /** Matches title, project label, or prompt preview. */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface DailyCost {
  day: string;
  sessions: number;
  costUsd: number;
  tokens: number;
  /** True when any session that day had an estimated or disputed cost. */
  approximate: boolean;
}

export interface ProjectRollup {
  projectPath: string;
  projectLabel: string;
  sessions: number;
  costUsd: number;
  tokens: number;
  lastActivityAt: string;
  activeSessions: number;
  /**
   * True when any session in this project has an estimated, incomplete or
   * disputed cost — so a rollup never looks more certain than the figures it is
   * made of.
   */
  approximate: boolean;
}

export interface ModelRollup {
  model: string;
  sessions: number;
}

export interface ToolRollup {
  tool: string;
  calls: number;
  sessions: number;
}

export interface IndexStats {
  sessions: number;
  projects: number;
  costUsd: number;
  tokens: number;
  earliest: string | null;
  latest: string | null;
  lastIndexedAt: string | null;
  /** Sessions whose cost is estimated, partial, or disputed. */
  approximateSessions: number;
}

/** One stored sub-agent run, joined to where its parent session ran. */
export interface SubagentRun {
  adapter: string;
  parentSessionId: string;
  /** The parent session's working directory — sub-agents are placed by their parent. */
  parentProjectPath: string;
  id: string;
  agentType: string | null;
  title: string;
  status: SessionStatus;
  errorCount: number;
  startedAt: string;
  lastActivityAt: string;
}

export interface SessionWrite {
  promptPreview: string | null;
  toolHistogram: Record<string, number>;
  sourceMtimeMs: number;
  /** Replaces every stored sub-agent run for this session. Absent means none. */
  subagents?: SubagentSummary[];
}

type Row = Record<string, unknown>;

const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0) || 0);
const str = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? ''));
const nullableStr = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const nullableNum = (value: unknown): number | null => (value === null || value === undefined ? null : num(value));

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * The derived index over every adapter's sessions.
 *
 * Deliberately boring: one table of session summaries, two child tables, and
 * replace-don't-merge writes. One user, one machine — a query that gets slow
 * gets an index, not a cache layer.
 */
export class PebbleStore {
  private readonly db: DatabaseSync;

  constructor(readonly path: string = join(pebbleDataDir(), 'pebble.db')) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL lets the dashboard read while the indexer writes.
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.rebuildIfOutdated();
    this.db.exec(SCHEMA_SQL);
    this.setMeta('schema_version', String(SCHEMA_VERSION));
  }

  /**
   * The index is a cache, so a schema change is handled by throwing it away
   * rather than migrating it: drop every derived table and let the next index
   * pass rebuild from the source files. Without this, `CREATE TABLE IF NOT
   * EXISTS` would leave an old table shape in place and `isFresh` would skip
   * every unchanged session, so new columns or tables would never fill.
   */
  private rebuildIfOutdated(): void {
    let stored: string | null = null;
    try {
      const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | undefined;
      stored = row ? str(row.value) : null;
    } catch {
      return; // No meta table: a fresh database.
    }
    if (stored === null || stored === String(SCHEMA_VERSION)) return;
    for (const table of DATA_TABLES) this.db.exec(`DROP TABLE IF EXISTS ${table}`);
    this.db.prepare("DELETE FROM meta WHERE key = 'last_indexed_at'").run();
  }

  close(): void {
    this.db.close();
  }

  /**
   * Runs `work` in a transaction. node:sqlite has no `transaction()` wrapper, so
   * this is the explicit version — and it matters: a session's row and its model
   * and tool rows must land together or the rollups count a session twice.
   */
  private tx<T>(work: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Already rolled back by SQLite; the original error is what matters.
      }
      throw error;
    }
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined;
    return row ? str(row.value) : null;
  }

  /**
   * True when the stored row already reflects this file's current bytes and
   * mtime, so there is nothing to re-parse.
   */
  isFresh(adapter: string, id: string, sourceBytes: number, sourceMtimeMs: number): boolean {
    const row = this.db
      .prepare('SELECT source_bytes, source_mtime_ms FROM sessions WHERE adapter = ? AND id = ?')
      .get(adapter, id) as Row | undefined;
    if (!row) return false;
    return num(row.source_bytes) === sourceBytes && Math.floor(num(row.source_mtime_ms)) === Math.floor(sourceMtimeMs);
  }

  /**
   * Writes one session. The row is replaced in full from the parsed file —
   * never merged — so a short read can never blank out a good value.
   */
  upsertSession(summary: SessionSummary, extras: SessionWrite): void {
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO sessions (
            adapter, id, title, title_source, project_path, project_label, git_branch, entrypoint,
            cli_version, permission_mode, started_at, last_activity_at, status, user_turns,
            assistant_turns, tool_calls, pending_tool_calls, subagent_count, error_count,
            sub_tok_input, sub_tok_output, sub_tok_cache_read, sub_tok_cache_write_5m,
            sub_tok_cache_write_1h, sub_tok_thinking, sub_cost_usd, sub_cost_basis,
            tok_input, tok_output, tok_cache_read, tok_cache_write_5m, tok_cache_write_1h, tok_thinking,
            cost_usd, cost_basis, cost_conflict, unpriced_models, lines_added, lines_removed,
            api_duration_ms, models, prompt_preview, issues, transcript_path, source_bytes,
            source_mtime_ms, indexed_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(adapter, id) DO UPDATE SET
            title=excluded.title, title_source=excluded.title_source, project_path=excluded.project_path,
            project_label=excluded.project_label, git_branch=excluded.git_branch, entrypoint=excluded.entrypoint,
            cli_version=excluded.cli_version, permission_mode=excluded.permission_mode,
            started_at=excluded.started_at, last_activity_at=excluded.last_activity_at, status=excluded.status,
            user_turns=excluded.user_turns, assistant_turns=excluded.assistant_turns,
            tool_calls=excluded.tool_calls, pending_tool_calls=excluded.pending_tool_calls,
            subagent_count=excluded.subagent_count, error_count=excluded.error_count,
            sub_tok_input=excluded.sub_tok_input, sub_tok_output=excluded.sub_tok_output,
            sub_tok_cache_read=excluded.sub_tok_cache_read,
            sub_tok_cache_write_5m=excluded.sub_tok_cache_write_5m,
            sub_tok_cache_write_1h=excluded.sub_tok_cache_write_1h,
            sub_tok_thinking=excluded.sub_tok_thinking, sub_cost_usd=excluded.sub_cost_usd,
            sub_cost_basis=excluded.sub_cost_basis,
            tok_input=excluded.tok_input, tok_output=excluded.tok_output, tok_cache_read=excluded.tok_cache_read,
            tok_cache_write_5m=excluded.tok_cache_write_5m, tok_cache_write_1h=excluded.tok_cache_write_1h,
            tok_thinking=excluded.tok_thinking, cost_usd=excluded.cost_usd, cost_basis=excluded.cost_basis,
            cost_conflict=excluded.cost_conflict, unpriced_models=excluded.unpriced_models,
            lines_added=excluded.lines_added, lines_removed=excluded.lines_removed,
            api_duration_ms=excluded.api_duration_ms, models=excluded.models,
            prompt_preview=excluded.prompt_preview, issues=excluded.issues,
            transcript_path=excluded.transcript_path, source_bytes=excluded.source_bytes,
            source_mtime_ms=excluded.source_mtime_ms, indexed_at=excluded.indexed_at`,
        )
        .run(
          summary.adapter,
          summary.id,
          summary.title,
          summary.titleSource,
          summary.projectPath,
          summary.projectLabel,
          summary.gitBranch,
          summary.entrypoint,
          summary.cliVersion,
          summary.permissionMode,
          summary.startedAt,
          summary.lastActivityAt,
          summary.status,
          summary.userTurns,
          summary.assistantTurns,
          summary.toolCalls,
          summary.pendingToolCalls,
          summary.subagentCount,
          summary.errorCount,
          summary.subagentTokens.input,
          summary.subagentTokens.output,
          summary.subagentTokens.cacheRead,
          summary.subagentTokens.cacheWrite5m,
          summary.subagentTokens.cacheWrite1h,
          summary.subagentTokens.thinking,
          summary.subagentCost.usd,
          summary.subagentCost.basis,
          summary.tokens.input,
          summary.tokens.output,
          summary.tokens.cacheRead,
          summary.tokens.cacheWrite5m,
          summary.tokens.cacheWrite1h,
          summary.tokens.thinking,
          summary.cost.usd,
          summary.cost.basis,
          summary.cost.conflict ? JSON.stringify(summary.cost.conflict) : null,
          JSON.stringify(summary.cost.unpricedModels),
          summary.linesAdded,
          summary.linesRemoved,
          summary.apiDurationMs,
          JSON.stringify(summary.models),
          extras.promptPreview,
          JSON.stringify(summary.issues),
          summary.transcriptPath,
          summary.transcriptBytes,
          Math.floor(extras.sourceMtimeMs),
          new Date().toISOString(),
        );

      this.db.prepare('DELETE FROM session_models WHERE adapter = ? AND id = ?').run(summary.adapter, summary.id);
      const insertModel = this.db.prepare('INSERT OR REPLACE INTO session_models (adapter, id, model) VALUES (?,?,?)');
      for (const model of summary.models) insertModel.run(summary.adapter, summary.id, model);

      this.db.prepare('DELETE FROM tool_usage WHERE adapter = ? AND id = ?').run(summary.adapter, summary.id);
      const insertTool = this.db.prepare('INSERT OR REPLACE INTO tool_usage (adapter, id, tool, calls) VALUES (?,?,?,?)');
      for (const [tool, calls] of Object.entries(extras.toolHistogram)) {
        insertTool.run(summary.adapter, summary.id, tool, calls);
      }

      // Replaced with the parent, never merged: a sub-agent that is no longer on
      // disk must not linger as a department's "last run".
      this.db.prepare('DELETE FROM subagents WHERE adapter = ? AND session_id = ?').run(summary.adapter, summary.id);
      const insertSub = this.db.prepare(
        `INSERT OR REPLACE INTO subagents (
          adapter, session_id, id, agent_type, title, status, pending_tool_calls, error_count,
          started_at, last_activity_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const sub of extras.subagents ?? []) {
        insertSub.run(
          summary.adapter,
          summary.id,
          sub.id,
          sub.agentType,
          sub.title,
          sub.status,
          sub.pendingToolCalls ?? 0,
          sub.errorCount,
          sub.startedAt,
          sub.lastActivityAt,
        );
      }
    });
  }

  /** Drops sessions whose transcripts are gone, so the index cannot outlive its source. */
  pruneMissing(adapter: string, liveIds: Set<string>): number {
    const rows = this.db.prepare('SELECT id FROM sessions WHERE adapter = ?').all(adapter) as Row[];
    const stale = rows.map((r) => str(r.id)).filter((id) => !liveIds.has(id));
    if (stale.length === 0) return 0;
    this.tx(() => {
      const del = this.db.prepare('DELETE FROM sessions WHERE adapter = ? AND id = ?');
      const delModels = this.db.prepare('DELETE FROM session_models WHERE adapter = ? AND id = ?');
      const delTools = this.db.prepare('DELETE FROM tool_usage WHERE adapter = ? AND id = ?');
      const delSubs = this.db.prepare('DELETE FROM subagents WHERE adapter = ? AND session_id = ?');
      for (const id of stale) {
        del.run(adapter, id);
        delModels.run(adapter, id);
        delTools.run(adapter, id);
        delSubs.run(adapter, id);
      }
    });
    return stale.length;
  }

  /**
   * Recomputes `status` for every row against the clock.
   *
   * Status is time-relative, so a row indexed ten minutes ago is stale even
   * though its file has not changed. Cheap enough to run on every poll.
   */
  refreshStatuses(now: number, activeMs: number, idleMs: number): void {
    const nowIso = new Date(now).toISOString();
    const activeCutoff = new Date(now - activeMs).toISOString();
    const idleCutoff = new Date(now - idleMs).toISOString();
    this.db
      .prepare(
        `UPDATE sessions SET status = CASE
           WHEN last_activity_at >= ? THEN 'active'
           WHEN last_activity_at >= ? AND pending_tool_calls > 0 THEN 'waiting'
           WHEN last_activity_at >= ? THEN 'idle'
           ELSE 'done'
         END
         WHERE last_activity_at <= ?`,
      )
      .run(activeCutoff, idleCutoff, idleCutoff, nowIso);
    this.db
      .prepare(
        `UPDATE subagents SET status = CASE
           WHEN last_activity_at >= ? THEN 'active'
           WHEN last_activity_at >= ? AND pending_tool_calls > 0 THEN 'waiting'
           WHEN last_activity_at >= ? THEN 'idle'
           ELSE 'done'
         END
         WHERE last_activity_at <= ?`,
      )
      .run(activeCutoff, idleCutoff, idleCutoff, nowIso);
  }

  /** Shared filter compiler, so list and count can never drift apart. */
  private buildWhere(filter: SessionFilter): { sql: string; params: Array<string | number> } {
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (filter.adapter) {
      where.push('s.adapter = ?');
      params.push(filter.adapter);
    }
    if (filter.status && filter.status.length > 0) {
      where.push(`s.status IN (${filter.status.map(() => '?').join(',')})`);
      params.push(...filter.status);
    }
    if (filter.project) {
      where.push('s.project_path = ?');
      params.push(filter.project);
    }
    if (filter.since) {
      where.push('s.last_activity_at >= ?');
      params.push(filter.since);
    }
    if (filter.model) {
      where.push('EXISTS (SELECT 1 FROM session_models m WHERE m.adapter = s.adapter AND m.id = s.id AND m.model = ?)');
      params.push(filter.model);
    }
    if (filter.search) {
      where.push('(s.title LIKE ? OR s.project_label LIKE ? OR s.prompt_preview LIKE ?)');
      const like = `%${filter.search}%`;
      params.push(like, like, like);
    }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  listSessions(filter: SessionFilter = {}): SessionSummary[] {
    const { sql: whereSql, params } = this.buildWhere(filter);
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 2000);
    const offset = Math.max(filter.offset ?? 0, 0);
    const rows = this.db
      .prepare(`SELECT s.* FROM sessions s ${whereSql} ORDER BY s.last_activity_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Row[];
    return rows.map(rowToSummary);
  }

  countSessions(filter: SessionFilter = {}): number {
    const { sql, params } = this.buildWhere(filter);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM sessions s ${sql}`).get(...params) as Row | undefined;
    return num(row?.n);
  }

  /**
   * Sessions whose working directory is `root` or anywhere beneath it, newest
   * first. Compared with `substr`, not `LIKE`, because `_` and `%` are ordinary
   * characters in a path (`_archive/`).
   */
  listSessionsUnder(root: string, limit = 5000): SessionSummary[] {
    const base = root.replace(/\/+$/, '');
    const prefix = `${base}/`;
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE project_path = ? OR substr(project_path, 1, ?) = ?
         ORDER BY last_activity_at DESC LIMIT ?`,
      )
      .all(base, prefix.length, prefix, Math.max(1, limit)) as Row[];
    return rows.map(rowToSummary);
  }

  /** Stored sub-agent runs whose parent session ran at or beneath `root`, newest first. */
  listSubagentRunsUnder(root: string, limit = 5000): SubagentRun[] {
    const base = root.replace(/\/+$/, '');
    const prefix = `${base}/`;
    const rows = this.db
      .prepare(
        `SELECT a.*, s.project_path AS parent_project_path
         FROM subagents a
         JOIN sessions s ON s.adapter = a.adapter AND s.id = a.session_id
         WHERE s.project_path = ? OR substr(s.project_path, 1, ?) = ?
         ORDER BY a.last_activity_at DESC LIMIT ?`,
      )
      .all(base, prefix.length, prefix, Math.max(1, limit)) as Row[];
    return rows.map((r) => ({
      adapter: str(r.adapter),
      parentSessionId: str(r.session_id),
      parentProjectPath: str(r.parent_project_path),
      id: str(r.id),
      agentType: nullableStr(r.agent_type),
      title: str(r.title),
      status: str(r.status) as SessionStatus,
      errorCount: num(r.error_count),
      startedAt: str(r.started_at),
      lastActivityAt: str(r.last_activity_at),
    }));
  }

  getSession(adapter: string, id: string): SessionSummary | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE adapter = ? AND id = ?').get(adapter, id) as Row | undefined;
    return row ? rowToSummary(row) : null;
  }

  dailyCost(days: number): DailyCost[] {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT substr(last_activity_at, 1, 10) AS day,
                COUNT(*) AS sessions,
                SUM(cost_usd) AS cost,
                SUM(tok_input + tok_output + tok_cache_read + tok_cache_write_5m + tok_cache_write_1h) AS tokens,
                SUM(CASE WHEN cost_basis IN ('estimated','partial') OR cost_conflict IS NOT NULL THEN 1 ELSE 0 END) AS approx
         FROM sessions WHERE last_activity_at >= ?
         GROUP BY day ORDER BY day ASC`,
      )
      .all(since) as Row[];
    return rows.map((r) => ({
      day: str(r.day),
      sessions: num(r.sessions),
      costUsd: num(r.cost),
      tokens: num(r.tokens),
      approximate: num(r.approx) > 0,
    }));
  }

  projectRollup(): ProjectRollup[] {
    const rows = this.db
      .prepare(
        `SELECT project_path, project_label,
                COUNT(*) AS sessions,
                SUM(cost_usd) AS cost,
                SUM(tok_input + tok_output + tok_cache_read + tok_cache_write_5m + tok_cache_write_1h) AS tokens,
                MAX(last_activity_at) AS last_activity,
                SUM(CASE WHEN status IN ('active','waiting') THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN cost_basis IN ('estimated','partial') OR cost_conflict IS NOT NULL THEN 1 ELSE 0 END) AS approx
         FROM sessions GROUP BY project_path ORDER BY last_activity DESC`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      projectPath: str(r.project_path),
      projectLabel: str(r.project_label),
      sessions: num(r.sessions),
      costUsd: num(r.cost),
      tokens: num(r.tokens),
      lastActivityAt: str(r.last_activity),
      activeSessions: num(r.active),
      approximate: num(r.approx) > 0,
    }));
  }

  modelRollup(): ModelRollup[] {
    const rows = this.db
      .prepare('SELECT model, COUNT(*) AS sessions FROM session_models GROUP BY model ORDER BY sessions DESC')
      .all() as Row[];
    return rows.map((r) => ({ model: str(r.model), sessions: num(r.sessions) }));
  }

  toolRollup(limit = 40): ToolRollup[] {
    const rows = this.db
      .prepare(
        `SELECT tool, SUM(calls) AS calls, COUNT(DISTINCT id) AS sessions
         FROM tool_usage GROUP BY tool ORDER BY calls DESC LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((r) => ({ tool: str(r.tool), calls: num(r.calls), sessions: num(r.sessions) }));
  }

  stats(): IndexStats {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS sessions,
                COUNT(DISTINCT project_path) AS projects,
                SUM(cost_usd) AS cost,
                SUM(tok_input + tok_output + tok_cache_read + tok_cache_write_5m + tok_cache_write_1h) AS tokens,
                MIN(started_at) AS earliest,
                MAX(last_activity_at) AS latest,
                SUM(CASE WHEN cost_basis IN ('estimated','partial') OR cost_conflict IS NOT NULL THEN 1 ELSE 0 END) AS approx
         FROM sessions`,
      )
      .get() as Row | undefined;
    return {
      sessions: num(row?.sessions),
      projects: num(row?.projects),
      costUsd: num(row?.cost),
      tokens: num(row?.tokens),
      earliest: nullableStr(row?.earliest),
      latest: nullableStr(row?.latest),
      lastIndexedAt: this.getMeta('last_indexed_at'),
      approximateSessions: num(row?.approx),
    };
  }

  /** Distinct project paths, for the config scanner. */
  projectPaths(): string[] {
    const rows = this.db
      .prepare('SELECT project_path, MAX(last_activity_at) AS la FROM sessions GROUP BY project_path ORDER BY la DESC')
      .all() as Row[];
    return rows.map((r) => str(r.project_path)).filter((p) => p.startsWith('/'));
  }
}

function rowToSummary(row: Row): SessionSummary {
  const tokens: TokenCounts = {
    input: num(row.tok_input),
    output: num(row.tok_output),
    cacheRead: num(row.tok_cache_read),
    cacheWrite5m: num(row.tok_cache_write_5m),
    cacheWrite1h: num(row.tok_cache_write_1h),
    thinking: num(row.tok_thinking),
  };
  const conflict = parseJson<{ reportedUsd: number; computedUsd: number } | null>(row.cost_conflict, null);
  return {
    id: str(row.id),
    adapter: str(row.adapter),
    title: str(row.title),
    titleSource: str(row.title_source) as SessionSummary['titleSource'],
    projectPath: str(row.project_path),
    projectLabel: str(row.project_label),
    gitBranch: nullableStr(row.git_branch),
    entrypoint: nullableStr(row.entrypoint),
    cliVersion: nullableStr(row.cli_version),
    models: parseJson<string[]>(row.models, []),
    startedAt: str(row.started_at),
    lastActivityAt: str(row.last_activity_at),
    status: str(row.status) as SessionStatus,
    userTurns: num(row.user_turns),
    assistantTurns: num(row.assistant_turns),
    toolCalls: num(row.tool_calls),
    pendingToolCalls: num(row.pending_tool_calls),
    tokens,
    cost: {
      usd: num(row.cost_usd),
      basis: str(row.cost_basis) as SessionSummary['cost']['basis'],
      unpricedModels: parseJson<string[]>(row.unpriced_models, []),
      ...(conflict ? { conflict } : {}),
    },
    subagentCount: num(row.subagent_count),
    subagentTokens: {
      input: num(row.sub_tok_input),
      output: num(row.sub_tok_output),
      cacheRead: num(row.sub_tok_cache_read),
      cacheWrite5m: num(row.sub_tok_cache_write_5m),
      cacheWrite1h: num(row.sub_tok_cache_write_1h),
      thinking: num(row.sub_tok_thinking),
    },
    subagentCost: {
      usd: num(row.sub_cost_usd),
      basis: str(row.sub_cost_basis) as SessionSummary['cost']['basis'],
      unpricedModels: [],
    },
    errorCount: num(row.error_count),
    transcriptPath: str(row.transcript_path),
    transcriptBytes: num(row.source_bytes),
    linesAdded: nullableNum(row.lines_added),
    linesRemoved: nullableNum(row.lines_removed),
    apiDurationMs: nullableNum(row.api_duration_ms),
    permissionMode: nullableStr(row.permission_mode),
    issues: parseJson<Issue[]>(row.issues, []),
  };
}
