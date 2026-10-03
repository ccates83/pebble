/**
 * Pebble's index schema.
 *
 * Everything in here is a cache. The transcripts under `~/.claude` are the only
 * source of truth, and `pebble index --rebuild` throws this away and derives it
 * again. Two consequences worth stating, because they shape the design:
 *
 *  - A session row is replaced wholesale from its file, never merged field by
 *    field. There is no path by which a failed read can blank out good data.
 *  - Prompt and response text is NOT stored here. Only a short preview, for
 *    search. Detail views re-read the transcript, so Pebble never becomes a
 *    second copy of everything you have ever said to an agent.
 */
export const SCHEMA_VERSION = 3;

/**
 * Every derived table, so a version change can drop them all. `meta` survives;
 * it holds nothing that cannot be rewritten.
 */
export const DATA_TABLES = ['sessions', 'session_models', 'tool_usage', 'subagents'] as const;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  adapter            TEXT NOT NULL,
  id                 TEXT NOT NULL,
  title              TEXT NOT NULL,
  title_source       TEXT NOT NULL,
  project_path       TEXT NOT NULL,
  project_label      TEXT NOT NULL,
  git_branch         TEXT,
  entrypoint         TEXT,
  cli_version        TEXT,
  permission_mode    TEXT,
  started_at         TEXT NOT NULL,
  last_activity_at   TEXT NOT NULL,
  status             TEXT NOT NULL,
  user_turns         INTEGER NOT NULL,
  assistant_turns    INTEGER NOT NULL,
  tool_calls         INTEGER NOT NULL,
  pending_tool_calls INTEGER NOT NULL,
  subagent_count     INTEGER NOT NULL,
  sub_tok_input          INTEGER NOT NULL DEFAULT 0,
  sub_tok_output         INTEGER NOT NULL DEFAULT 0,
  sub_tok_cache_read     INTEGER NOT NULL DEFAULT 0,
  sub_tok_cache_write_5m INTEGER NOT NULL DEFAULT 0,
  sub_tok_cache_write_1h INTEGER NOT NULL DEFAULT 0,
  sub_tok_thinking       INTEGER NOT NULL DEFAULT 0,
  sub_cost_usd           REAL NOT NULL DEFAULT 0,
  sub_cost_basis         TEXT NOT NULL DEFAULT 'exact',
  error_count        INTEGER NOT NULL,
  tok_input          INTEGER NOT NULL,
  tok_output         INTEGER NOT NULL,
  tok_cache_read     INTEGER NOT NULL,
  tok_cache_write_5m INTEGER NOT NULL,
  tok_cache_write_1h INTEGER NOT NULL,
  tok_thinking       INTEGER NOT NULL,
  cost_usd           REAL NOT NULL,
  cost_basis         TEXT NOT NULL,
  cost_conflict      TEXT,
  unpriced_models    TEXT NOT NULL,
  lines_added        INTEGER,
  lines_removed      INTEGER,
  api_duration_ms    INTEGER,
  models             TEXT NOT NULL,
  prompt_preview     TEXT,
  issues             TEXT NOT NULL,
  transcript_path    TEXT NOT NULL,
  source_bytes       INTEGER NOT NULL,
  source_mtime_ms    INTEGER NOT NULL,
  indexed_at         TEXT NOT NULL,
  PRIMARY KEY (adapter, id)
);

CREATE INDEX IF NOT EXISTS sessions_last_activity ON sessions (last_activity_at DESC);
CREATE INDEX IF NOT EXISTS sessions_project       ON sessions (project_path);
CREATE INDEX IF NOT EXISTS sessions_status        ON sessions (status);

CREATE TABLE IF NOT EXISTS session_models (
  adapter TEXT NOT NULL,
  id      TEXT NOT NULL,
  model   TEXT NOT NULL,
  PRIMARY KEY (adapter, id, model)
);

CREATE TABLE IF NOT EXISTS tool_usage (
  adapter TEXT NOT NULL,
  id      TEXT NOT NULL,
  tool    TEXT NOT NULL,
  calls   INTEGER NOT NULL,
  PRIMARY KEY (adapter, id, tool)
);

CREATE INDEX IF NOT EXISTS tool_usage_tool ON tool_usage (tool);

-- Sub-agent runs, written and deleted with their parent session's row. Only
-- what department activity needs: who ran, on what, and when. Cost is not here;
-- it stays on the parent as the separate sub-agent figure.
CREATE TABLE IF NOT EXISTS subagents (
  adapter            TEXT NOT NULL,
  session_id         TEXT NOT NULL,
  id                 TEXT NOT NULL,
  agent_type         TEXT,
  title              TEXT NOT NULL,
  status             TEXT NOT NULL,
  pending_tool_calls INTEGER NOT NULL DEFAULT 0,
  error_count        INTEGER NOT NULL DEFAULT 0,
  started_at         TEXT NOT NULL,
  last_activity_at   TEXT NOT NULL,
  PRIMARY KEY (adapter, session_id, id)
);

CREATE INDEX IF NOT EXISTS subagents_agent_type ON subagents (agent_type);
`;
