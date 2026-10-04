/**
 * Pebble's vocabulary. Every adapter normalizes into these shapes, so the
 * dashboard never learns a vendor's file format.
 */

export type AdapterId = string;

/**
 * Where a session is, judged from evidence on disk — not from a vendor status field,
 * because none of them publish one.
 *
 * active  — wrote to its transcript within the active window
 * waiting — last thing it did was ask for something (a tool call with no result yet,
 *           or a hook that blocked) and it has gone quiet. This is the "needs you" state.
 * idle    — quiet, but recently enough that the process is probably still alive
 * done    — quiet long enough that the session is over
 */
export type SessionStatus = 'active' | 'waiting' | 'idle' | 'done';

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  /** Cache writes at the 5-minute TTL, billed at 1.25x input. */
  cacheWrite5m: number;
  /** Cache writes at the 1-hour TTL, billed at 2x input. */
  cacheWrite1h: number;
  thinking: number;
}

/**
 * How much we trust a dollar figure. Pebble never renders an estimate as if it
 * were measured — `basis` travels with the number all the way to the pixel.
 */
export type CostBasis =
  /** The host tool recorded the cost itself. Trusted over anything we compute. */
  | 'reported'
  /** Every model in the session had an exact entry in the price table. */
  | 'exact'
  /** At least one model fell back to its family's tier price (e.g. an unrecognized opus-*). */
  | 'estimated'
  /** At least one model was unpriceable; the figure below excludes it. */
  | 'partial';

export interface Cost {
  usd: number;
  basis: CostBasis;
  /** Models that were priced by family fallback or not at all. Shown in the UI. */
  unpricedModels: string[];
  /**
   * Set when the host tool reported a cost AND our own computation disagreed by
   * more than the tolerance. Pebble shows both figures rather than picking one —
   * a quietly-reconciled number is a worse answer than a visible disagreement.
   */
  conflict?: { reportedUsd: number; computedUsd: number };
}

/**
 * One sub-agent run. Claude Code gives each its own transcript under
 * `<projectDir>/<sessionId>/subagents/agent-<id>.jsonl`, so a sub-agent has real
 * per-agent tokens and cost rather than being a line item in its parent.
 */
export interface SubagentSummary {
  /** Claude Code's `agentId`. */
  id: string;
  parentSessionId: string;
  /** Which agent definition ran (e.g. a department agent), when the host recorded it. */
  agentType: string | null;
  /** The task it was handed, truncated. */
  title: string;
  models: string[];
  startedAt: string;
  lastActivityAt: string;
  status: SessionStatus;
  /** Tool calls still awaiting a result; what lets the index tell `waiting` from `idle`. */
  pendingToolCalls?: number;
  toolCalls: number;
  tokens: TokenCounts;
  cost: Cost;
  errorCount: number;
  transcriptPath: string;
  transcriptBytes: number;
}

export interface SessionSummary {
  id: string;
  adapter: AdapterId;
  /** Best available human name: custom title, agent name, or first prompt. */
  title: string;
  titleSource: 'custom' | 'ai' | 'agent' | 'prompt' | 'fallback';
  /** Absolute path of the working directory the session ran in. */
  projectPath: string;
  /** Last path segment, for display. */
  projectLabel: string;
  gitBranch: string | null;
  /** e.g. "cli", "claude-desktop", "vscode" — how the session was started. */
  entrypoint: string | null;
  cliVersion: string | null;
  models: string[];
  startedAt: string;
  lastActivityAt: string;
  status: SessionStatus;
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  /** Tool calls still awaiting a result at the end of the transcript. */
  pendingToolCalls: number;
  tokens: TokenCounts;
  cost: Cost;
  /** Sub-agents this session spawned, counted from their own transcripts. */
  subagentCount: number;
  /**
   * Sub-agent usage, kept SEPARATE from the parent's own figures.
   *
   * Whether Claude Code's reported session cost already includes its sub-agents
   * is not something the transcripts state, so Pebble does not fold these in —
   * adding them could double-count, and hiding them would under-report. Both
   * numbers are shown, labelled.
   */
  subagentTokens: TokenCounts;
  subagentCost: Cost;
  errorCount: number;
  transcriptPath: string;
  transcriptBytes: number;
  /** Lines of code added/removed, when the host tool tracked it. */
  linesAdded: number | null;
  linesRemoved: number | null;
  /** Milliseconds spent waiting on the model, when recorded. */
  apiDurationMs: number | null;
  /** Permission mode last seen in the transcript (e.g. "auto", "default", "plan"). */
  permissionMode: string | null;
  /** Anything notable the parser found while reading this session. */
  issues: Issue[];
}

export type EventKind =
  | 'prompt'
  | 'response'
  | 'tool-call'
  | 'tool-result'
  | 'hook'
  | 'error'
  | 'meta';

export interface SessionEvent {
  sessionId: string;
  uuid: string;
  parentUuid: string | null;
  /** Position in the file. Stable, and the only reliable ordering key. */
  seq: number;
  at: string;
  kind: EventKind;
  role: 'user' | 'assistant' | 'system' | null;
  model: string | null;
  effort: string | null;
  isSidechain: boolean;
  /** Set on records belonging to a named sub-agent. */
  agentName: string | null;
  toolName: string | null;
  toolUseId: string | null;
  toolStatus: 'ok' | 'error' | 'pending' | null;
  /** Human-readable gist. Truncated; the transcript stays the source of truth. */
  text: string | null;
  tokens: TokenCounts | null;
  cost: Cost | null;
}

export interface SessionDetail extends SessionSummary {
  events: SessionEvent[];
  /** Tool-use frequency within this session. */
  toolHistogram: Record<string, number>;
  subagents: SubagentSummary[];
}

// ---------------------------------------------------------------------------
// Config surface — the "fleet inventory" half of Pebble.
// ---------------------------------------------------------------------------

export type ConfigKind =
  | 'settings'
  | 'memory'
  | 'agent'
  | 'skill'
  | 'command'
  | 'hook'
  | 'mcp-server'
  | 'plugin';

/** Precedence, lowest to highest, as the host tool resolves it. */
export type ConfigScope = 'plugin' | 'user' | 'project' | 'local';

export type IssueLevel = 'error' | 'warn' | 'info';

export interface Issue {
  level: IssueLevel;
  /** Stable machine code so the UI can group and the docs can explain. */
  code: string;
  message: string;
  path?: string;
}

export interface ConfigItem {
  /** Stable within a scan: `${adapter}:${kind}:${scope}:${name}@${project ?? 'global'}`. */
  id: string;
  adapter: AdapterId;
  kind: ConfigKind;
  scope: ConfigScope;
  name: string;
  /** The path as configured — may be a symlink. */
  path: string;
  /** Where that symlink actually lands. Null when the path is not a link. */
  realPath: string | null;
  exists: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
  /** Absolute project path for project/local scope; null for user/plugin scope. */
  project: string | null;
  description: string | null;
  /** Kind-specific extras (hook event, MCP transport, skill allowed-tools, ...). */
  meta: Record<string, string | number | boolean | null>;
  issues: Issue[];
}

export interface ConfigSurface {
  adapter: AdapterId;
  scannedAt: string;
  /** Root the adapter reads its global config from, e.g. ~/.claude. */
  root: string;
  items: ConfigItem[];
  /**
   * Same `kind` + `name` defined at more than one scope. Not an error — that is
   * how overrides work — but you should be able to see it.
   */
  shadowed: Array<{ kind: ConfigKind; name: string; winner: string; shadowed: string[] }>;
  issues: Issue[];
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export interface AdapterPresence {
  installed: boolean;
  /** Why we think so — shown verbatim in `pebble doctor`. */
  evidence: string;
  version: string | null;
  root: string | null;
}

export interface ConfigScanOptions {
  /**
   * Project directories to include beyond the ones the tool itself knows about —
   * normally the working directories seen in transcripts.
   */
  projectPaths?: string[];
  /** Cap on projects scanned, so a cold scan stays quick. */
  maxProjects?: number;
}

export interface ListSessionsOptions {
  /** Only sessions with activity at or after this ISO timestamp. */
  since?: string;
  limit?: number;
}

/**
 * A session's backing file, as cheaply as it can be described: enough to decide
 * whether the index is stale without parsing anything.
 */
export interface SessionSource {
  adapter: AdapterId;
  id: string;
  path: string;
  bytes: number;
  mtimeMs: number;
  /** Adapter-private breadcrumbs needed to parse this source later. */
  hint?: Record<string, string>;
}

/** What the indexer stores for one session. */
export interface IndexedSession {
  summary: SessionSummary;
  /** First human prompt, kept short — this is all the text the index holds. */
  promptPreview: string | null;
  toolHistogram: Record<string, number>;
  sourceMtimeMs: number;
  /**
   * The session's sub-agent runs, when the adapter has them. Stored alongside the
   * session row and replaced with it, so department activity can be answered from
   * the index without re-parsing transcripts.
   */
  subagents?: SubagentSummary[];
}

/**
 * One agent tool, normalized. Implement this and Pebble can watch it.
 *
 * The contract is deliberately read-shaped: v1 observes and inventories, it does
 * not launch or stop anything. Control verbs get their own optional interface
 * later so that a read-only adapter stays a complete adapter.
 */
export interface AgentAdapter {
  readonly id: AdapterId;
  readonly label: string;
  readonly kind: 'cli' | 'ide' | 'cloud';

  detect(): Promise<AdapterPresence>;
  listSessions(options?: ListSessionsOptions): Promise<SessionSummary[]>;
  readSession(sessionId: string): Promise<SessionDetail | null>;
  scanConfig(options?: ConfigScanOptions): Promise<ConfigSurface>;

  /**
   * Directories the watcher polls for change. Keep this small — it is stat'd on
   * a timer.
   */
  watchRoots(): string[];

  // -- Optional, for incremental indexing -----------------------------------
  //
  // An adapter that implements both of these lets Pebble skip sessions whose
  // files have not changed. Without them it still works — the indexer falls back
  // to `listSessions()` and re-reads everything, which is fine for tens of
  // sessions and wasteful for thousands.

  /** Cheap, stat-only listing of every session's backing file. */
  listSources?(): Promise<SessionSource[]>;

  /** Parses exactly one source. Returns null if it has become unreadable. */
  summarizeSource?(source: SessionSource): Promise<IndexedSession | null>;
}

// ---------------------------------------------------------------------------
// Org surface — the holding company Pebble lives inside.
//
// Read from `org.json` and the vault conventions under the org root
// (approvals, inbox, self-improvements, changelogs, reviews). Like everything
// else in Pebble this is read-only: the vaults are Connor's, and Pebble only
// looks. None of it is vendor-specific, so it lives outside the adapters.
// ---------------------------------------------------------------------------

/** A markdown note in one of the org's vaults, described from its frontmatter. */
export interface OrgNote {
  /** Absolute path. */
  path: string;
  /** Path relative to the org root, for display. */
  relPath: string;
  /** Frontmatter `title`, else the file name. */
  title: string;
  summary: string | null;
  /** Frontmatter `status`, verbatim. */
  status: string | null;
  /** Frontmatter `updated`/`created` as written, else the file's mtime (ISO). */
  updated: string | null;
  /** Frontmatter `created` as written. */
  created?: string | null;
}

/** A Tier 1 request filed in `<vault>/07 System/Approvals/`. */
export interface ApprovalRequest extends OrgNote {
  department: string | null;
  requestedBy: string | null;
  tier: number | null;
  /** publish | send | spend | commit | account | deploy | other, verbatim. */
  action: string | null;
  /** Provisional, as the agent wrote it. */
  amountUsd: number | null;
  due: string | null;
  created: string | null;
  decided: string | null;
}

/** One `- YYYY-MM-DD — actor — what` line from a vault's CHANGELOG.md. */
export interface ChangelogEntry {
  date: string;
  actor: string;
  text: string;
  /** 'hq' or a subsidiary id. */
  unit: string;
}

/** One row of a department scorecard table. Values are verbatim strings. */
export interface ScorecardKpi {
  name: string;
  target: string | null;
  baseline: string | null;
  latest: string | null;
  /** The "Red if" column. */
  redIf?: string | null;
  source: string | null;
  /** 'provisional' | 'verified' | whatever was written. */
  verified: string | null;
}

export interface OrgDepartment {
  id: string;
  name: string;
  /** Absolute path of the department folder. */
  path: string;
  /** The agent name that runs it (matches `.claude/agents/<agent>.md`). */
  agent: string;
  folderExists: boolean;
  agentDefined: boolean;
  scorecard: { path: string; kpis: ScorecardKpi[] } | null;
}

export interface Subsidiary {
  id: string;
  name: string;
  /** consulting | marketplace | content | software | other, verbatim. */
  type: string;
  /** planning | active | paused | archived, verbatim from org.json. */
  status: string;
  /** Absolute vault path. */
  path: string;
  exists: boolean;
  created: string | null;
  archived: string | null;
  departments: OrgDepartment[];
  /** `filled` is false while the charter still carries its "Connor to fill in" marker. */
  charter: (OrgNote & { filled: boolean }) | null;
  /** Every approval request, newest first, whatever its status. */
  approvals: ApprovalRequest[];
  /** Notes waiting in `00 Inbox` (index files and .gitkeep excluded). */
  inbox: OrgNote[];
  /** `06 Self Improvements` notes with `status: proposed`. */
  proposals: OrgNote[];
  /** Newest `08 Reviews/*Weekly Review.md`, if any. */
  lastReview: OrgNote | null;
  /** Newest first, capped. */
  changelog: ChangelogEntry[];
  /** Structural problems — the same checks as `org status`. */
  drift: Issue[];
}

export interface HqVault {
  path: string;
  exists: boolean;
  inbox: OrgNote[];
  proposals: OrgNote[];
  /** Most recent decisions in `05 Decisions`, newest first. */
  decisions: OrgNote[];
  changelog: ChangelogEntry[];
}

export interface OrgSnapshot {
  /** Directory holding org.json. */
  root: string;
  orgFile: string;
  name: string | null;
  updated: string | null;
  hq: HqVault;
  subsidiaries: Subsidiary[];
  tooling: Array<{ id: string; path: string; role: string | null }>;
  /** Anything unreadable or malformed. Never thrown. */
  issues: Issue[];
  readAt: string;
}

/** Where a session sits in the org, judged from its working directory. */
export interface OrgPlacement {
  scope: 'hq' | 'subsidiary' | 'tooling' | 'outside';
  /** 'hq', a subsidiary id or a tooling id; null when outside the org. */
  unit: string | null;
  /**
   * Department id, when the session itself ran as a department agent or
   * spawned one. Null means "the unit, not a specific department".
   */
  department: string | null;
}

export type AttentionKind =
  | 'approval'
  | 'waiting-session'
  | 'session-errors'
  | 'drift'
  | 'inbox'
  | 'proposal'
  | 'charter'
  | 'review-overdue'
  | 'org-issue';

/** Something Connor needs to act on. Derived on every read; never stored. */
export interface AttentionItem {
  /** Stable within a read, for React keys. */
  id: string;
  kind: AttentionKind;
  level: IssueLevel;
  /** 'hq', a subsidiary id, or null for org-wide. */
  unit: string | null;
  department: string | null;
  title: string;
  detail: string | null;
  /** The file to open, when there is one. */
  path: string | null;
  session: { adapter: string; id: string } | null;
  /** When it arose, or for approvals the `due` date if set. */
  at: string | null;
}

/** What one department's agent has been doing, from the session index. */
export interface DepartmentActivity {
  department: string;
  agent: string;
  /** Runs (sessions or sub-agent runs) in the last 7 days. */
  runs7d: number;
  lastActivityAt: string | null;
  /** Status of its most recent run. */
  status: SessionStatus | null;
  /** Title of its most recent run — "what it's working on". */
  lastTitle: string | null;
  lastSession: { adapter: string; id: string } | null;
}

/** A sub-agent run that is still active, waiting or idle: drawn as a helper at its parent's desk. */
export interface LiveSubagent {
  id: string;
  agentType: string | null;
  title: string;
  status: SessionStatus;
  startedAt: string;
  lastActivityAt: string;
  errorCount: number;
}

/** A live session on the HQ map, with the sub-agent runs it has going right now. */
export type HqLiveSession = SessionSummary & { placement: OrgPlacement; liveSubagents: LiveSubagent[] };

/** HQ, a subsidiary, or a tooling repo, with its sessions joined in. */
export interface HqUnit {
  id: string;
  kind: 'hq' | 'subsidiary' | 'tooling';
  name: string;
  /**
   * Sessions currently active, waiting or idle, each with its placement — plus
   * any session whose own status is `done` but which still has live sub-agents
   * (a parent that went quiet while background sub-agents work). Its `status`
   * is left as measured; the UI says in words that its sub-agents are running.
   */
  live: HqLiveSession[];
  /** Most recent sessions, newest first, capped. */
  recent: Array<SessionSummary & { placement: OrgPlacement }>;
  departments: DepartmentActivity[];
  sessions7d: number;
  /** Sum of session cost over 7 days; `approximate` if any figure was less than measured. */
  cost7d: { usd: number; approximate: boolean };
  lastActivityAt: string | null;
}

/** GET /api/hq */
export interface HqOverview {
  /** Where Pebble looked for org.json, and how it decided. */
  orgRoot: string;
  orgRootSource: 'flag' | 'env' | 'discovered' | 'default';
  /** Null when no org.json was found; the UI explains how to point Pebble at one. */
  org: OrgSnapshot | null;
  /** Why `org` is null, in words. Absent when the org was read. */
  orgError?: string | null;
  /**
   * Most urgent first: level (error, warn, info), then kind in the order
   * approval, waiting-session, session-errors, drift, inbox, proposal, charter,
   * review-overdue, org-issue; then `at` — soonest due first for approvals,
   * newest first for everything else.
   */
  attention: AttentionItem[];
  units: HqUnit[];
  /** Sessions in the index that sit outside the org entirely, last 7 days. */
  outside7d: number;
}
