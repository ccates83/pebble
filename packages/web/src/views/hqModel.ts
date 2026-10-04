import type {
  ApprovalRequest,
  AttentionItem,
  AttentionKind,
  DepartmentActivity,
  HqLiveSession,
  HqOverview,
  HqUnit,
  IssueLevel,
  LiveSubagent,
  OrgDepartment,
  OrgSnapshot,
  SessionStatus,
  Subsidiary,
} from '@pebble/core';
import { hashOf, type Pose, type SeatedPose } from '../components/sprites.tsx';

/*
 * The office floor, derived from one /api/hq read.
 *
 * One room per unit: HQ, the tooling workshop(s), and each subsidiary. A
 * subsidiary's departments each get a workstation with a nameplate; live
 * sessions that belong to no department (and every live session at HQ or a
 * workshop) sit at hot desks. Everything here comes from the API; nothing is
 * interpolated or invented. A desk with nobody at it is drawn empty.
 */

/** A live session on the map, with the sub-agent runs it has going right now. */
export type PlacedSession = HqLiveSession;

/** Live sub-agents of a session, defensive against a server that predates the field. */
export function liveSubsOf(session: PlacedSession): LiveSubagent[] {
  return (session.liveSubagents ?? []).filter((sub) => sub.status !== 'done');
}

export const LEVEL_RANK: Record<IssueLevel, number> = { error: 2, warn: 1, info: 0 };
const TINTS = 12;
const FLOORS = 4;
/** Hot desks always leave room for this many more sessions. */
export const SPARE_HOT_DESKS = 2;

/** Approval statuses are verbatim frontmatter, so compare loosely. */
export function isPending(approval: ApprovalRequest): boolean {
  return (approval.status ?? '').trim().toLowerCase() === 'pending';
}

export function isArchived(subsidiary: Subsidiary): boolean {
  return subsidiary.status.trim().toLowerCase() === 'archived';
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function sessionHref(session: { adapter: string; id: string }): string {
  return `#/session/${encodeURIComponent(session.adapter)}/${encodeURIComponent(session.id)}`;
}

/** `at` can carry an approval's free-text due ("before launch"); only a real time gets "3d ago". */
export function isTime(value: string | null): value is string {
  return value !== null && Number.isFinite(Date.parse(value));
}

export function sessionKey(session: { adapter: string; id: string }): string {
  return `${session.adapter}:${session.id}`;
}

export interface DeptModel {
  id: string;
  name: string;
  agent: string;
  /** Null when sessions were placed in a department org.json does not list. */
  org: OrgDepartment | null;
  activity: DepartmentActivity | null;
  tint: number;
  pose: Pose;
  /** The status in words, in full: aria-labels and the inspector. */
  statusText: string;
  /** The same, short enough for a nameplate. */
  caption: string;
}

export interface StationModel {
  /** Unique within its room: `d:<department>` or `h:<seat>`. */
  key: string;
  /** Position in the room's grid of desks, row by row. */
  index: number;
  kind: 'dept' | 'hot';
  dept: DeptModel | null;
  /** Whoever sits at a hot desk; null for a free one. */
  session: PlacedSession | null;
  pose: Pose;
  statusText: string;
  caption: string;
  plate: string;
  tint: number | 'worker';
  look: number;
  /** The character at this desk, when the data says someone is there. */
  occupant: string | null;
  /** The parent's caption's sub-agent count ("3"), kept apart so it never truncates. */
  subsCaption: string | null;
  /** Every live sub-agent drawn at this desk, oldest first; the first few stand round it. */
  subagents: StationSub[];
  /** The sub-agents drawn as small characters beside the chair, at most MAX_KIDS. */
  kids: KidModel[];
  /** Sub-agents running here that there is no room to draw. */
  kidsHidden: number;
}

/** A live sub-agent and the session that started it. */
export interface StationSub {
  sub: LiveSubagent;
  parent: PlacedSession;
}

/** A sub-agent drawn as a small character standing at its parent's desk. */
export interface KidModel {
  /** Stable occupant id, so the map can diff it like any other character. */
  id: string;
  sub: LiveSubagent;
  /** Which spot beside the chair, 0..MAX_KIDS-1. Stable across reads. */
  slot: number;
  pose: SeatedPose;
  look: number;
}

/** Spots beside a chair for sub-agents; more than this become a "+N" chip. */
export const MAX_KIDS = 4;

export const SUB_WORDS: Record<SessionStatus, string> = {
  active: 'working',
  waiting: 'needs you',
  idle: 'idle',
  done: 'done',
};

export interface UnitModel {
  id: string;
  kind: 'hq' | 'subsidiary' | 'tooling';
  name: string;
  subtitle: string;
  unit: HqUnit | null;
  subsidiary: Subsidiary | null;
  archived: boolean;
  floor: number;
  depts: DeptModel[];
  /** Live sessions at hot desks: every live session for HQ and tooling, unplaced ones for a subsidiary. */
  desks: PlacedSession[];
  /** Department desks, then hot desks (taken and free). Rows are filled out later, by the layout. */
  stations: StationModel[];
}

export type Selection =
  | { kind: 'unit'; unit: string }
  | { kind: 'dept'; unit: string; department: string }
  | { kind: 'desk'; unit: string; session: string };

export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (!a || !b || a.kind !== b.kind || a.unit !== b.unit) return false;
  if (a.kind === 'dept' && b.kind === 'dept') return a.department === b.department;
  if (a.kind === 'desk' && b.kind === 'desk') return a.session === b.session;
  return true;
}

function deptPose(org: OrgDepartment | null, activity: DepartmentActivity | null): { pose: Pose; text: string; caption: string } {
  if (org && !org.agentDefined) return { pose: 'vacant', text: 'vacant: agent not defined', caption: 'vacant' };
  switch (activity?.status ?? null) {
    case 'active':
      return { pose: 'active', text: 'working', caption: 'working' };
    case 'waiting':
      return { pose: 'waiting', text: 'needs you', caption: 'needs you' };
    case 'idle':
      return { pose: 'idle', text: 'idle', caption: 'idle' };
    case 'done':
      return { pose: 'empty', text: 'empty desk: last run done', caption: 'run done' };
    default:
      return { pose: 'empty', text: 'empty desk: no runs yet', caption: 'no runs' };
  }
}

export const DESK_POSE: Record<SessionStatus, { pose: Pose; text: string }> = {
  active: { pose: 'active', text: 'working' },
  waiting: { pose: 'waiting', text: 'needs you' },
  idle: { pose: 'idle', text: 'idle' },
  done: { pose: 'empty', text: 'done' },
};

export function isSeated(pose: Pose): pose is SeatedPose {
  return pose === 'active' || pose === 'waiting' || pose === 'idle';
}

/*
 * Hot desk seats, and the spots beside a chair where sub-agents stand, are
 * remembered for the life of the page, so a session keeps its chair (and a
 * helper its spot) across reloads instead of shuffling whenever someone else
 * leaves.
 */
const seatMemory = new Map<string, Map<string, number>>();
const kidMemory = new Map<string, Map<string, number>>();

/**
 * Stable slots for `keys`. A key keeps its previous slot; with a `cap`, a key
 * remembered beyond the cap (not drawn) moves into a lower free slot when one
 * opens up.
 */
function assignSlots(memory: Map<string, Map<string, number>>, scope: string, keys: string[], cap = Infinity): Map<string, number> {
  const previous = memory.get(scope) ?? new Map<string, number>();
  const next = new Map<string, number>();
  const live = new Set(keys);
  // A slot freed in this read is not handed to a newcomer in the same read:
  // the leaver is still walking out of it.
  const released = new Set([...previous].filter(([key]) => !live.has(key)).map(([, slot]) => slot));
  for (const key of keys) {
    const slot = previous.get(key);
    if (slot !== undefined && slot < cap) next.set(key, slot);
  }
  const taken = new Set([...next.values(), ...released]);
  for (const key of keys) {
    if (next.has(key)) continue;
    let slot = 0;
    while (taken.has(slot)) slot += 1;
    // Still beyond the cap: keep its old place in the overflow queue if it had one.
    const old = previous.get(key);
    if (slot >= cap && old !== undefined && !taken.has(old)) slot = old;
    next.set(key, slot);
    taken.add(slot);
  }
  if (next.size === 0) memory.delete(scope);
  else memory.set(scope, next);
  return next;
}

function assignSeats(unitId: string, keys: string[]): Map<string, number> {
  return assignSlots(seatMemory, unitId, keys);
}

/** Pose for a sub-agent standing at the desk. `done` never reaches here; it is filtered out. */
function kidPose(status: SessionStatus): SeatedPose {
  return status === 'waiting' ? 'waiting' : status === 'idle' ? 'idle' : 'active';
}

/** "2 working, 1 needs you": sub-agent statuses in words, busiest first. */
export function subBreakdown(subs: LiveSubagent[]): string {
  const order: SessionStatus[] = ['active', 'waiting', 'idle'];
  return order
    .map((status) => [status, subs.filter((sub) => sub.status === status).length] as const)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${SUB_WORDS[status]}`)
    .join(', ');
}

interface DeskPeople {
  pose: Pose;
  statusText: string;
  caption: string;
  subsCaption: string | null;
  subagents: StationSub[];
  kids: KidModel[];
  kidsHidden: number;
}

/**
 * The sub-agents at one desk, and what that does to the desk's own words.
 *
 * A sub-agent whose type is the agent of a department desk in the same room
 * already lights that desk up as a grown-up character (core counts it as the
 * department's activity), so drawing it again here would count it twice.
 *
 * A parent whose own run is done but whose sub-agents are still going stays
 * seated, quiet: it has not left, and it is not working either.
 */
function deskPeople(
  unitId: string,
  stationKey: string,
  base: { pose: Pose; statusText: string; caption: string },
  parents: PlacedSession[],
  deptAgents: Set<string>,
  draw: boolean,
): DeskPeople {
  const subagents: StationSub[] = parents
    .flatMap((parent) => liveSubsOf(parent).map((sub) => ({ sub, parent })))
    .filter(({ sub }) => sub.agentType === null || !deptAgents.has(sub.agentType))
    .sort((a, b) => Date.parse(a.sub.startedAt) - Date.parse(b.sub.startedAt));
  if (!draw || subagents.length === 0) {
    return { ...base, subsCaption: null, subagents: draw ? [] : subagents, kids: [], kidsHidden: 0 };
  }

  const idOf = (entry: StationSub): string => `${unitId}/k/${sessionKey(entry.parent)}/${entry.sub.id}`;
  const slots = assignSlots(kidMemory, `${unitId}|${stationKey}`, subagents.map(idOf), MAX_KIDS);
  const kids: KidModel[] = [];
  let kidsHidden = 0;
  for (const entry of subagents) {
    const id = idOf(entry);
    const slot = slots.get(id) ?? MAX_KIDS;
    if (slot >= MAX_KIDS) {
      kidsHidden += 1;
      continue;
    }
    kids.push({ id, sub: entry.sub, slot, pose: kidPose(entry.sub.status), look: hashOf(id) });
  }

  const n = subagents.length;
  const quiet = base.pose === 'empty';
  const pose: Pose = quiet ? 'idle' : base.pose;
  const word = quiet ? 'quiet' : base.caption;
  const lead = quiet ? 'quiet, its sub-agents are still running' : base.statusText;
  return {
    pose,
    statusText: `${lead}; ${plural(n, 'sub-agent')} running: ${subBreakdown(subagents.map((e) => e.sub))}`,
    caption: word,
    subsCaption: String(n),
    subagents,
    kids,
    kidsHidden,
  };
}

export function buildFloor(data: HqOverview, org: OrgSnapshot): UnitModel[] {
  const unitById = new Map(data.units.map((unit) => [unit.id, unit]));

  // One tint per department id, in order of first appearance across the org,
  // so "Marketing" wears the same colour in every room.
  const tintOf = new Map<string, number>();
  for (const subsidiary of org.subsidiaries) {
    for (const department of subsidiary.departments) {
      if (!tintOf.has(department.id)) tintOf.set(department.id, (tintOf.size % TINTS) + 1);
    }
  }
  const tint = (id: string): number => {
    if (!tintOf.has(id)) tintOf.set(id, (tintOf.size % TINTS) + 1);
    return tintOf.get(id) ?? 1;
  };

  const units: UnitModel[] = [];
  const hqUnit = unitById.get('hq') ?? null;
  units.push(room({ id: 'hq', kind: 'hq', name: hqUnit?.name ?? 'HQ', subtitle: 'head office', unit: hqUnit, subsidiary: null, archived: false, floor: 1, depts: [], desks: hqUnit?.live ?? [] }));

  for (const tool of org.tooling) {
    const unit = unitById.get(tool.id) ?? null;
    units.push(room({ id: tool.id, kind: 'tooling', name: unit?.name ?? tool.id, subtitle: 'workshop', unit, subsidiary: null, archived: false, floor: 5, depts: [], desks: unit?.live ?? [] }));
  }

  org.subsidiaries.forEach((subsidiary, index) => {
    const unit = unitById.get(subsidiary.id) ?? null;
    const activityById = new Map((unit?.departments ?? []).map((a) => [a.department, a]));
    const depts: DeptModel[] = subsidiary.departments.map((department) => {
      const activity = activityById.get(department.id) ?? null;
      const { pose, text, caption } = deptPose(department, activity);
      return { id: department.id, name: department.name, agent: department.agent, org: department, activity, tint: tint(department.id), pose, statusText: text, caption };
    });
    // Activity for a department org.json does not list: shown, not dropped.
    for (const activity of unit?.departments ?? []) {
      if (subsidiary.departments.some((d) => d.id === activity.department)) continue;
      const { pose, text, caption } = deptPose(null, activity);
      depts.push({ id: activity.department, name: activity.department, agent: activity.agent, org: null, activity, tint: tint(activity.department), pose, statusText: text, caption });
    }
    const deptIds = new Set(depts.map((d) => d.id));
    units.push(
      room({
        id: subsidiary.id,
        kind: 'subsidiary',
        name: subsidiary.name,
        subtitle: `${subsidiary.type} · ${subsidiary.status}`,
        unit,
        subsidiary,
        archived: isArchived(subsidiary),
        floor: (index % FLOORS) + 1,
        depts,
        // A live session with no department, or one whose department has no
        // desk, takes a hot desk. Work is never hidden.
        desks: (unit?.live ?? []).filter((s) => s.placement.department === null || !deptIds.has(s.placement.department)),
      }),
    );
  });

  return units;
}

function room(base: Omit<UnitModel, 'stations'>): UnitModel {
  const deptAgents = new Set(base.depts.map((dept) => dept.agent));
  const live = base.unit?.live ?? [];

  const stations: StationModel[] = base.depts.map((dept, index) => {
    const key = `d:${dept.id}`;
    // An archived room is closed: its desks are under dust sheets, whatever the last run said.
    const closed = { pose: 'vacant' as Pose, statusText: 'closed: subsidiary archived', caption: 'closed' };
    const people = deskPeople(
      base.id,
      key,
      base.archived ? closed : { pose: dept.pose, statusText: dept.statusText, caption: dept.caption },
      live.filter((session) => session.placement.department === dept.id),
      deptAgents,
      !base.archived,
    );
    return {
      key,
      index,
      kind: 'dept',
      dept,
      session: null,
      ...people,
      plate: dept.name,
      tint: dept.tint,
      look: hashOf(`${base.id}/${dept.id}`),
      occupant: isSeated(people.pose) ? `${base.id}/d/${dept.id}` : null,
    };
  });

  const seats = assignSeats(base.id, base.desks.map(sessionKey));
  const bySeat = new Map(base.desks.map((session) => [seats.get(sessionKey(session)) ?? 0, session]));
  const highest = Math.max(-1, ...seats.values());
  // A closed room keeps no spare desks; an open one always has room for more.
  const hotCount = base.archived ? highest + 1 : Math.max(highest + 1, base.desks.length + SPARE_HOT_DESKS);
  for (let seat = 0; seat < hotCount; seat += 1) {
    const session = bySeat.get(seat) ?? null;
    const key = session ? sessionKey(session) : null;
    const stationKey = `h:${seat}`;
    if (!session || !key) {
      stations.push({
        key: stationKey,
        index: stations.length,
        kind: 'hot',
        dept: null,
        session: null,
        pose: 'empty',
        statusText: 'free hot desk',
        caption: 'free',
        subsCaption: null,
        subagents: [],
        kids: [],
        kidsHidden: 0,
        plate: 'hot desk',
        tint: 'worker',
        look: hashOf(`${base.id}/seat/${seat}`),
        occupant: null,
      });
      continue;
    }
    const { pose, text } = DESK_POSE[session.status];
    let people = deskPeople(base.id, stationKey, { pose, statusText: text, caption: text }, [session], deptAgents, true);
    if (session.status === 'done' && people.subagents.length === 0 && liveSubsOf(session).length > 0) {
      // Every one of its sub-agents is drawn as a grown-up at a department desk.
      people = { ...people, statusText: 'done; its sub-agents are still running at department desks' };
    }
    stations.push({
      key: stationKey,
      index: stations.length,
      kind: 'hot',
      dept: null,
      session,
      ...people,
      plate: 'hot desk',
      tint: 'worker',
      look: hashOf(key),
      occupant: isSeated(people.pose) ? `${base.id}/s/${key}` : null,
    });
  }
  return { ...base, stations };
}

/** Where on the map an attention item belongs, as a location key. */
export function locate(item: AttentionItem, units: UnitModel[]): { key: string; selection: Selection | null } {
  const unit = units.find((u) => u.id === item.unit);
  if (!unit) return { key: 'org', selection: null };
  if (item.session) {
    const key = sessionKey(item.session);
    if (unit.desks.some((s) => sessionKey(s) === key)) {
      return { key: `d:${unit.id}:${key}`, selection: { kind: 'desk', unit: unit.id, session: key } };
    }
  }
  if (item.department && unit.depts.some((dept) => dept.id === item.department)) {
    return { key: `r:${unit.id}:${item.department}`, selection: { kind: 'dept', unit: unit.id, department: item.department } };
  }
  return { key: `u:${unit.id}`, selection: { kind: 'unit', unit: unit.id } };
}

export type Pins = Map<string, AttentionItem[]>;

export function pinItems(attention: AttentionItem[], units: UnitModel[]): Pins {
  const pins: Pins = new Map();
  for (const item of attention) {
    const { key } = locate(item, units);
    const list = pins.get(key) ?? [];
    list.push(item);
    pins.set(key, list);
  }
  return pins;
}

export const KIND_WORDS: Record<AttentionKind, [string, string]> = {
  approval: ['pending approval', 'pending approvals'],
  'waiting-session': ['session waiting on you', 'sessions waiting on you'],
  'session-errors': ['session that hit errors', 'sessions that hit errors'],
  drift: ['drift issue', 'drift issues'],
  inbox: ['unfiled inbox note', 'unfiled inbox notes'],
  proposal: ['proposed improvement', 'proposed improvements'],
  charter: ['unfilled charter', 'unfilled charters'],
  'review-overdue': ['overdue weekly review', 'overdue weekly reviews'],
  'org-issue': ['org issue', 'org issues'],
};

/** Marker order on the map: what needs Connor first. */
const KIND_ORDER: AttentionKind[] = ['approval', 'waiting-session', 'session-errors', 'charter', 'drift', 'review-overdue', 'inbox', 'proposal', 'org-issue'];

export function kindSummary(items: AttentionItem[]): Array<{ kind: AttentionKind; count: number; urgent: boolean; label: string }> {
  return KIND_ORDER.flatMap((kind) => {
    const matching = items.filter((item) => item.kind === kind);
    if (matching.length === 0) return [];
    const [one, many] = KIND_WORDS[kind];
    return [{ kind, count: matching.length, urgent: matching.some((item) => LEVEL_RANK[item.level] > 0), label: `${matching.length} ${matching.length === 1 ? one : many}` }];
  });
}

export function markerWords(items: AttentionItem[] | undefined): string {
  const summary = kindSummary(items ?? []);
  return summary.length === 0 ? '' : ` ${summary.map((entry) => entry.label).join(', ')}.`;
}
