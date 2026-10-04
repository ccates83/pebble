import type {
  AttentionItem,
  AttentionKind,
  DepartmentActivity,
  HqLiveSession,
  HqOverview,
  HqUnit,
  IssueLevel,
  LiveSubagent,
  OrgNote,
  OrgPlacement,
  OrgSnapshot,
  SessionStatus,
  SessionSummary,
  Subsidiary,
} from '../types.ts';
import type { PebbleStore, SubagentRun } from '../store/index.ts';
import { dateMs } from './fs.ts';
import { isWithin, placeSession } from './place.ts';
import type { OrgRootSource } from './read.ts';

const DAY_MS = 86_400_000;
const RECENT_CAP = 10;
/** A weekly review older than this is overdue. A week plus a day of grace. */
const REVIEW_OVERDUE_MS = 8 * DAY_MS;
const LIVE: SessionStatus[] = ['active', 'waiting', 'idle'];

const LEVEL_RANK: Record<IssueLevel, number> = { error: 0, warn: 1, info: 2 };
const KIND_RANK: Record<AttentionKind, number> = {
  approval: 0,
  'waiting-session': 1,
  'session-errors': 2,
  drift: 3,
  inbox: 4,
  proposal: 5,
  charter: 6,
  'review-overdue': 7,
  'org-issue': 8,
};

type Placed = SessionSummary & { placement: OrgPlacement };

const key = (adapter: string, id: string): string => `${adapter}\u0000${id}`;
const isArchived = (sub: Subsidiary): boolean => sub.status.toLowerCase() === 'archived' || sub.archived !== null;

/**
 * Most urgent first: level, then kind (the order of `KIND_RANK`), then time —
 * the soonest deadline first for approvals, the newest first for the rest.
 * Exported so the ordering is testable on its own.
 */
export function sortAttention(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => {
    const level = LEVEL_RANK[a.level] - LEVEL_RANK[b.level];
    if (level !== 0) return level;
    const kind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (kind !== 0) return kind;
    const ta = dateMs(a.at);
    const tb = dateMs(b.at);
    if (ta !== tb) {
      if (ta === 0) return 1;
      if (tb === 0) return -1;
      return a.kind === 'approval' ? ta - tb : tb - ta;
    }
    return a.title.localeCompare(b.title);
  });
}

/**
 * True once a `due` value is behind us. A bare date is due by the end of that
 * day, not its first instant — "due today" is not yet overdue.
 */
function isPastDue(due: string, now: number): boolean {
  const ms = Date.parse(due);
  if (!Number.isFinite(ms)) return false;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(due.trim());
  return now > (dateOnly ? ms + DAY_MS : ms);
}

function money(usd: number): string {
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function noteItem(kind: 'inbox' | 'proposal', unit: string, note: OrgNote): AttentionItem {
  return {
    id: `${kind}:${note.relPath}`,
    kind,
    level: 'info',
    unit,
    department: null,
    title: note.title,
    detail: note.summary ?? (kind === 'inbox' ? 'Waiting in 00 Inbox' : 'Proposed self-improvement'),
    path: note.path,
    session: null,
    at: note.created ?? note.updated,
  };
}

function departmentFor(sub: Subsidiary, raw: string | null): string | null {
  if (!raw) return null;
  const wanted = raw.toLowerCase();
  const match = sub.departments.find(
    (d) => d.id.toLowerCase() === wanted || d.name.toLowerCase() === wanted || d.agent.toLowerCase() === wanted,
  );
  return match ? match.id : raw;
}

/** The directories whose sessions can belong to the org — usually just the root. */
function searchRoots(org: OrgSnapshot): string[] {
  const roots = [org.root];
  for (const path of [org.hq.path, ...org.subsidiaries.map((s) => s.path), ...org.tooling.map((t) => t.path)]) {
    if (!roots.some((r) => isWithin(path, r))) roots.push(path);
  }
  return roots;
}

interface Run {
  at: string;
  status: SessionStatus;
  title: string;
  session: { adapter: string; id: string };
}

function departmentActivity(
  sub: Subsidiary,
  sessions: Placed[],
  runsByParent: Map<string, SubagentRun[]>,
  since7d: number,
): DepartmentActivity[] {
  return sub.departments.map((dept) => {
    const runs: Run[] = [];
    for (const s of sessions) {
      if (s.titleSource === 'agent' && s.title === dept.agent) {
        runs.push({ at: s.lastActivityAt, status: s.status, title: s.title, session: { adapter: s.adapter, id: s.id } });
      }
      for (const run of runsByParent.get(key(s.adapter, s.id)) ?? []) {
        if (run.agentType === dept.agent) {
          runs.push({ at: run.lastActivityAt, status: run.status, title: run.title, session: { adapter: s.adapter, id: s.id } });
        }
      }
    }
    runs.sort((a, b) => dateMs(b.at) - dateMs(a.at));
    const last = runs[0] ?? null;
    return {
      department: dept.id,
      agent: dept.agent,
      runs7d: runs.filter((r) => dateMs(r.at) >= since7d).length,
      lastActivityAt: last?.at ?? null,
      status: last?.status ?? null,
      lastTitle: last?.title ?? null,
      lastSession: last?.session ?? null,
    };
  });
}

/** A session's sub-agent runs that are still going, oldest first so the UI can seat them stably. */
function liveSubagentsOf(s: Placed, runsByParent: Map<string, SubagentRun[]>): LiveSubagent[] {
  return (runsByParent.get(key(s.adapter, s.id)) ?? [])
    .filter((run) => LIVE.includes(run.status))
    .sort((a, b) => dateMs(a.startedAt) - dateMs(b.startedAt) || a.id.localeCompare(b.id))
    .map((run) => ({
      id: run.id,
      agentType: run.agentType,
      title: run.title,
      status: run.status,
      startedAt: run.startedAt,
      lastActivityAt: run.lastActivityAt,
      errorCount: run.errorCount,
    }));
}

function buildUnit(
  id: string,
  kind: HqUnit['kind'],
  name: string,
  sessions: Placed[],
  departments: DepartmentActivity[],
  runsByParent: Map<string, SubagentRun[]>,
  since7d: number,
): HqUnit {
  // A parent that went quiet while background sub-agents keep working is still
  // on the floor. Its own status stays as measured; only its membership in
  // `live` is widened. `sessions` is already newest first, so order holds.
  const live: HqLiveSession[] = [];
  for (const s of sessions) {
    const liveSubagents = liveSubagentsOf(s, runsByParent);
    if (LIVE.includes(s.status) || liveSubagents.length > 0) live.push({ ...s, liveSubagents });
  }

  const week = sessions.filter((s) => dateMs(s.lastActivityAt) >= since7d);
  let usd = 0;
  let approximate = false;
  for (const s of week) {
    // Own cost only. Sub-agent cost stays separate everywhere in Pebble, because
    // the transcripts never say whether the parent's figure already includes it.
    usd += s.cost.usd;
    if ((s.cost.basis !== 'reported' && s.cost.basis !== 'exact') || s.cost.conflict) approximate = true;
  }
  return {
    id,
    kind,
    name,
    live,
    recent: sessions.slice(0, RECENT_CAP),
    departments,
    sessions7d: week.length,
    cost7d: { usd, approximate },
    lastActivityAt: sessions[0]?.lastActivityAt ?? null,
  };
}

export interface HqOrigin {
  root: string;
  source: OrgRootSource;
  /** Why `org` is null, when it is. */
  reason?: string | null;
}

/**
 * The HQ view: the org snapshot joined to the session index.
 *
 * Everything here is derived on each call from the store and a fresh snapshot.
 * Nothing is written anywhere, and attention items are never stored — an
 * approval disappears from the list the moment its file says it was decided.
 */
export function buildHqOverview(store: PebbleStore, org: OrgSnapshot | null, now: number, origin?: HqOrigin): HqOverview {
  const orgRoot = origin?.root ?? org?.root ?? '';
  const orgRootSource = origin?.source ?? 'flag';
  const since7d = now - 7 * DAY_MS;
  const since24h = now - DAY_MS;
  const total7d = store.countSessions({ since: new Date(since7d).toISOString() });

  if (!org) {
    return {
      orgRoot,
      orgRootSource,
      org: null,
      orgError: origin?.reason ?? 'No org.json found.',
      attention: [],
      units: [],
      outside7d: total7d,
    };
  }

  // Sessions and sub-agent runs that could sit in the org, deduplicated in case
  // a vault lives outside the root.
  const sessionMap = new Map<string, SessionSummary>();
  const runsByParent = new Map<string, SubagentRun[]>();
  const seenRuns = new Set<string>();
  for (const root of searchRoots(org)) {
    for (const s of store.listSessionsUnder(root)) sessionMap.set(key(s.adapter, s.id), s);
    for (const run of store.listSubagentRunsUnder(root)) {
      const runKey = `${key(run.adapter, run.parentSessionId)}\u0000${run.id}`;
      if (seenRuns.has(runKey)) continue;
      seenRuns.add(runKey);
      const parent = key(run.adapter, run.parentSessionId);
      runsByParent.set(parent, [...(runsByParent.get(parent) ?? []), run]);
    }
  }

  const placed: Placed[] = [...sessionMap.values()]
    .sort((a, b) => dateMs(b.lastActivityAt) - dateMs(a.lastActivityAt))
    .map((s) => ({
      ...s,
      placement: placeSession(s.projectPath, org, {
        title: s.title,
        titleSource: s.titleSource,
        subagentTypes: (runsByParent.get(key(s.adapter, s.id)) ?? []).map((r) => r.agentType),
      }),
    }));

  const inOrg = placed.filter((s) => s.placement.scope !== 'outside');
  const byUnit = (scope: OrgPlacement['scope'], unit: string): Placed[] =>
    inOrg.filter((s) => s.placement.scope === scope && s.placement.unit === unit);

  const units: HqUnit[] = [buildUnit('hq', 'hq', org.name ?? 'HQ', byUnit('hq', 'hq'), [], runsByParent, since7d)];
  for (const sub of org.subsidiaries) {
    const sessions = byUnit('subsidiary', sub.id);
    units.push(buildUnit(sub.id, 'subsidiary', sub.name, sessions, departmentActivity(sub, sessions, runsByParent, since7d), runsByParent, since7d));
  }
  for (const tool of org.tooling) units.push(buildUnit(tool.id, 'tooling', tool.id, byUnit('tooling', tool.id), [], runsByParent, since7d));

  // ---- attention ---------------------------------------------------------

  const archivedIds = new Set(org.subsidiaries.filter(isArchived).map((s) => s.id));
  const active = (p: OrgPlacement): boolean => !(p.scope === 'subsidiary' && p.unit !== null && archivedIds.has(p.unit));
  const attention: AttentionItem[] = [];

  for (const sub of org.subsidiaries) {
    // Approvals surface even for an archived subsidiary: a pending request is a
    // commitment someone is waiting on, whatever state the business is in.
    for (const a of sub.approvals) {
      if ((a.status ?? '').toLowerCase() !== 'pending') continue;
      const overdue = a.due !== null && isPastDue(a.due, now);
      const parts = [
        a.action ?? 'action',
        a.amountUsd !== null ? `${money(a.amountUsd)} (provisional)` : null,
        a.requestedBy ? `requested by ${a.requestedBy}` : null,
        a.due ? `${overdue ? 'was due' : 'due'} ${a.due}` : null,
      ].filter((p): p is string => p !== null);
      attention.push({
        id: `approval:${a.relPath}`,
        kind: 'approval',
        level: overdue ? 'error' : 'warn',
        unit: sub.id,
        department: departmentFor(sub, a.department),
        title: a.title,
        detail: parts.join(' · '),
        path: a.path,
        session: null,
        at: a.due ?? a.created ?? a.updated,
      });
    }
  }

  for (const s of inOrg) {
    if (!active(s.placement)) continue;
    const ref = { adapter: s.adapter, id: s.id };
    if (s.status === 'waiting') {
      attention.push({
        id: `waiting-session:${s.adapter}:${s.id}`,
        kind: 'waiting-session',
        level: 'warn',
        unit: s.placement.unit,
        department: s.placement.department,
        title: s.title,
        detail: `${s.pendingToolCalls} tool call${s.pendingToolCalls === 1 ? '' : 's'} awaiting a result · ${s.projectLabel}`,
        path: null,
        session: ref,
        at: s.lastActivityAt,
      });
    }
    if (s.errorCount > 0 && dateMs(s.lastActivityAt) >= since24h) {
      attention.push({
        id: `session-errors:${s.adapter}:${s.id}`,
        kind: 'session-errors',
        level: 'info',
        unit: s.placement.unit,
        department: s.placement.department,
        title: s.title,
        detail: `${s.errorCount} error${s.errorCount === 1 ? '' : 's'} · ${s.projectLabel}`,
        path: null,
        session: ref,
        at: s.lastActivityAt,
      });
    }
  }

  for (const note of org.hq.inbox) attention.push(noteItem('inbox', 'hq', note));
  for (const note of org.hq.proposals) attention.push(noteItem('proposal', 'hq', note));

  for (const sub of org.subsidiaries) {
    if (isArchived(sub)) continue;
    sub.drift.forEach((issue, i) => {
      attention.push({
        id: `drift:${sub.id}:${issue.code}:${i}`,
        kind: 'drift',
        level: 'warn',
        unit: sub.id,
        department: null,
        title: `${sub.name}: ${issue.message}`,
        detail: issue.code,
        path: issue.path ?? null,
        session: null,
        at: null,
      });
    });
    for (const note of sub.inbox) attention.push(noteItem('inbox', sub.id, note));
    for (const note of sub.proposals) attention.push(noteItem('proposal', sub.id, note));
    if (sub.charter && !sub.charter.filled) {
      attention.push({
        id: `charter:${sub.id}`,
        kind: 'charter',
        level: 'info',
        unit: sub.id,
        department: null,
        title: `${sub.name} charter is not filled in`,
        detail: 'Still carries the "Connor to fill in" marker.',
        path: sub.charter.path,
        session: null,
        at: sub.charter.updated,
      });
    }
    if (sub.status.toLowerCase() === 'active' && sub.exists) {
      const last = sub.lastReview;
      const lastAt = last ? dateMs(last.created ?? last.updated) : 0;
      if (lastAt === 0 || now - lastAt > REVIEW_OVERDUE_MS) {
        attention.push({
          id: `review-overdue:${sub.id}`,
          kind: 'review-overdue',
          level: 'warn',
          unit: sub.id,
          department: null,
          title: `${sub.name} weekly review is overdue`,
          detail: last ? `Last review: ${last.title}` : 'No weekly review yet.',
          path: last?.path ?? null,
          session: null,
          at: last ? (last.created ?? last.updated) : null,
        });
      }
    }
  }

  const archivedPaths = org.subsidiaries.filter(isArchived).map((s) => s.path);
  org.issues.forEach((issue, i) => {
    if (issue.path && archivedPaths.some((p) => isWithin(issue.path as string, p))) return;
    attention.push({
      id: `org-issue:${issue.code}:${i}`,
      kind: 'org-issue',
      level: issue.level,
      unit: null,
      department: null,
      title: issue.message,
      detail: issue.code,
      path: issue.path ?? null,
      session: null,
      at: null,
    });
  });

  const inOrg7d = inOrg.filter((s) => dateMs(s.lastActivityAt) >= since7d).length;

  return {
    orgRoot,
    orgRootSource,
    org,
    attention: sortAttention(attention),
    units,
    outside7d: Math.max(0, total7d - inOrg7d),
  };
}
