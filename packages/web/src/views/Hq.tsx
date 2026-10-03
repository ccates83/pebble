import { useEffect, useRef, useState, type ReactNode } from 'react';

import type {
  ApprovalRequest,
  AttentionItem,
  AttentionKind,
  ChangelogEntry,
  DepartmentActivity,
  HqOverview,
  HqUnit,
  IssueLevel,
  OrgDepartment,
  OrgNote,
  OrgPlacement,
  OrgSnapshot,
  SessionStatus,
  SessionSummary,
  Subsidiary,
} from '@pebble/core';
import { api } from '../lib/api.ts';
import { useAsync, useClock, useSort } from '../lib/hooks.ts';
import { dueLabel, duration, obsidianHref, relativeTime, relativeTo } from '../lib/format.ts';
import { Badge, CostFigure, Empty, FilterPills, Meter, Money, Note, Section, StatusDot } from '../components/ui.tsx';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { DeskScene, Marker, hashOf, type MarkerKind, type Pose } from '../components/sprites.tsx';

/*
 * HQ as an office floor.
 *
 * Each subsidiary is a building, each department a room, and each room's agent
 * a character at a desk whose pose is its latest run's status. HQ is the head
 * office and tooling repos are workshops; their live sessions sit at desks as
 * generic workers. Attention items are drawn where they happened.
 *
 * Everything on the map comes from /api/hq. A room with no runs shows an empty
 * desk, not a sleeping placeholder; a building with nobody in it says so.
 */

type PlacedSession = SessionSummary & { placement: OrgPlacement };

const LEVEL_RANK: Record<IssueLevel, number> = { error: 2, warn: 1, info: 0 };
const TINTS = 12;
const ROOFS = 6;

/** Approval statuses are verbatim frontmatter, so compare loosely. */
function isPending(approval: ApprovalRequest): boolean {
  return (approval.status ?? '').trim().toLowerCase() === 'pending';
}

function isArchived(subsidiary: Subsidiary): boolean {
  return subsidiary.status.trim().toLowerCase() === 'archived';
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function sessionHref(session: { adapter: string; id: string }): string {
  return `#/session/${encodeURIComponent(session.adapter)}/${encodeURIComponent(session.id)}`;
}

/** `at` can carry an approval's free-text due ("before launch"); only a real time gets "3d ago". */
function isTime(value: string | null): value is string {
  return value !== null && Number.isFinite(Date.parse(value));
}

function sessionKey(session: { adapter: string; id: string }): string {
  return `${session.adapter}:${session.id}`;
}

// ---------------------------------------------------------------------------
// The model: buildings, rooms and desks, derived from one /api/hq read
// ---------------------------------------------------------------------------

interface RoomModel {
  id: string;
  name: string;
  agent: string;
  /** Null when sessions were placed in a department org.json does not list. */
  org: OrgDepartment | null;
  activity: DepartmentActivity | null;
  tint: number;
  pose: Pose;
  /** The status in words: the caption under the sprite. */
  statusText: string;
}

interface BuildingModel {
  id: string;
  kind: 'hq' | 'subsidiary' | 'tooling';
  name: string;
  subtitle: string;
  unit: HqUnit | null;
  subsidiary: Subsidiary | null;
  archived: boolean;
  roof: number;
  rooms: RoomModel[];
  /** Live sessions at a desk: every live session for HQ and tooling, unplaced ones for a subsidiary. */
  desks: PlacedSession[];
}

type Selection =
  | { kind: 'building'; unit: string }
  | { kind: 'room'; unit: string; department: string }
  | { kind: 'desk'; unit: string; session: string };

function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (!a || !b || a.kind !== b.kind || a.unit !== b.unit) return false;
  if (a.kind === 'room' && b.kind === 'room') return a.department === b.department;
  if (a.kind === 'desk' && b.kind === 'desk') return a.session === b.session;
  return true;
}

function roomPose(org: OrgDepartment | null, activity: DepartmentActivity | null): { pose: Pose; text: string } {
  if (org && !org.agentDefined) return { pose: 'vacant', text: 'vacant: agent not defined' };
  switch (activity?.status ?? null) {
    case 'active':
      return { pose: 'active', text: 'working' };
    case 'waiting':
      return { pose: 'waiting', text: 'needs you' };
    case 'idle':
      return { pose: 'idle', text: 'idle' };
    case 'done':
      return { pose: 'empty', text: 'empty desk: last run done' };
    default:
      return { pose: 'empty', text: 'empty desk: no runs yet' };
  }
}

const DESK_POSE: Record<SessionStatus, { pose: Pose; text: string }> = {
  active: { pose: 'active', text: 'working' },
  waiting: { pose: 'waiting', text: 'needs you' },
  idle: { pose: 'idle', text: 'idle' },
  done: { pose: 'empty', text: 'done' },
};

function buildFloor(data: HqOverview, org: OrgSnapshot): BuildingModel[] {
  const unitById = new Map(data.units.map((unit) => [unit.id, unit]));

  // One tint per department id, in order of first appearance across the org,
  // so "Marketing" wears the same colour in every building.
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

  const buildings: BuildingModel[] = [];
  const hqUnit = unitById.get('hq') ?? null;
  buildings.push({
    id: 'hq',
    kind: 'hq',
    name: hqUnit?.name ?? 'HQ',
    subtitle: 'head office',
    unit: hqUnit,
    subsidiary: null,
    archived: false,
    roof: 4,
    rooms: [],
    desks: hqUnit?.live ?? [],
  });

  for (const tool of org.tooling) {
    const unit = unitById.get(tool.id) ?? null;
    buildings.push({
      id: tool.id,
      kind: 'tooling',
      name: unit?.name ?? tool.id,
      subtitle: 'workshop',
      unit,
      subsidiary: null,
      archived: false,
      roof: 6,
      rooms: [],
      desks: unit?.live ?? [],
    });
  }

  org.subsidiaries.forEach((subsidiary, index) => {
    const unit = unitById.get(subsidiary.id) ?? null;
    const activityById = new Map((unit?.departments ?? []).map((a) => [a.department, a]));
    const rooms: RoomModel[] = subsidiary.departments.map((department) => {
      const activity = activityById.get(department.id) ?? null;
      const { pose, text } = roomPose(department, activity);
      return {
        id: department.id,
        name: department.name,
        agent: department.agent,
        org: department,
        activity,
        tint: tint(department.id),
        pose,
        statusText: text,
      };
    });
    // Activity for a department org.json does not list: shown, not dropped.
    for (const activity of unit?.departments ?? []) {
      if (subsidiary.departments.some((d) => d.id === activity.department)) continue;
      const { pose, text } = roomPose(null, activity);
      rooms.push({
        id: activity.department,
        name: activity.department,
        agent: activity.agent,
        org: null,
        activity,
        tint: tint(activity.department),
        pose,
        statusText: text,
      });
    }
    const roomIds = new Set(rooms.map((room) => room.id));
    buildings.push({
      id: subsidiary.id,
      kind: 'subsidiary',
      name: subsidiary.name,
      subtitle: `${subsidiary.type} · ${subsidiary.status}`,
      unit,
      subsidiary,
      archived: isArchived(subsidiary),
      roof: (index % ROOFS) + 1,
      rooms,
      // A live session with no department, or one whose department has no
      // room, waits in the lobby. Work is never hidden.
      desks: (unit?.live ?? []).filter((s) => s.placement.department === null || !roomIds.has(s.placement.department)),
    });
  });

  return buildings;
}

/** Where on the map an attention item belongs, as a location key. */
function locate(item: AttentionItem, buildings: BuildingModel[]): { key: string; selection: Selection | null } {
  const building = buildings.find((b) => b.id === item.unit);
  if (!building) return { key: 'org', selection: null };
  if (item.session) {
    const key = sessionKey(item.session);
    if (building.desks.some((s) => sessionKey(s) === key)) {
      return { key: `d:${building.id}:${key}`, selection: { kind: 'desk', unit: building.id, session: key } };
    }
  }
  if (item.department && building.rooms.some((room) => room.id === item.department)) {
    return {
      key: `r:${building.id}:${item.department}`,
      selection: { kind: 'room', unit: building.id, department: item.department },
    };
  }
  return { key: `b:${building.id}`, selection: { kind: 'building', unit: building.id } };
}

type Pins = Map<string, AttentionItem[]>;

function pinItems(attention: AttentionItem[], buildings: BuildingModel[]): Pins {
  const pins: Pins = new Map();
  for (const item of attention) {
    const { key } = locate(item, buildings);
    const list = pins.get(key) ?? [];
    list.push(item);
    pins.set(key, list);
  }
  return pins;
}

const KIND_WORDS: Record<AttentionKind, [string, string]> = {
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
const KIND_ORDER: AttentionKind[] = [
  'approval',
  'waiting-session',
  'session-errors',
  'charter',
  'drift',
  'review-overdue',
  'inbox',
  'proposal',
  'org-issue',
];

function kindSummary(items: AttentionItem[]): Array<{ kind: AttentionKind; count: number; urgent: boolean; label: string }> {
  return KIND_ORDER.flatMap((kind) => {
    const matching = items.filter((item) => item.kind === kind);
    if (matching.length === 0) return [];
    const [one, many] = KIND_WORDS[kind];
    return [
      {
        kind,
        count: matching.length,
        urgent: matching.some((item) => LEVEL_RANK[item.level] > 0),
        label: `${matching.length} ${matching.length === 1 ? one : many}`,
      },
    ];
  });
}

function Markers(props: { items: AttentionItem[] | undefined; only?: AttentionKind[]; except?: AttentionKind[] }): ReactNode {
  const items = (props.items ?? []).filter(
    (item) => (!props.only || props.only.includes(item.kind)) && !(props.except ?? []).includes(item.kind),
  );
  if (items.length === 0) return null;
  return (
    <>
      {kindSummary(items).map((entry) => (
        <Marker key={entry.kind} kind={entry.kind as MarkerKind} count={entry.count} urgent={entry.urgent} label={entry.label} />
      ))}
    </>
  );
}

function markerWords(items: AttentionItem[] | undefined): string {
  const summary = kindSummary(items ?? []);
  return summary.length === 0 ? '' : ` ${summary.map((entry) => entry.label).join(', ')}.`;
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export function Hq(props: { reloadToken: number }): ReactNode {
  const state = useAsync(() => api.hq(), [props.reloadToken]);
  const now = useClock();

  if (state.loading && !state.data) return <Empty>Reading org.json and the vaults…</Empty>;
  if (state.error && !state.data) return <HqUnavailable error={state.error} status={state.errorStatus} />;
  if (!state.data) return null;

  const data = state.data;
  if (data.org === null) return <NoOrg data={data} />;

  return (
    <>
      <HqHeader data={data} org={data.org} now={now} />
      {state.error && <Note tone="warn">Could not refresh — showing the last good read. {state.error}</Note>}
      <Floor data={data} org={data.org} now={now} />
      <Logbook data={data} org={data.org} />
      {data.outside7d > 0 && (
        <p className="faint small">
          {plural(data.outside7d, 'session')} outside the org this week → <a href="#/fleet">Usage</a>
        </p>
      )}
    </>
  );
}

function HqUnavailable(props: { error: string; status: number | null }): ReactNode {
  return (
    <Section title="HQ">
      {props.status === 404 ? (
        <Note tone="warn">
          This server does not answer <code>/api/hq</code>, so it is likely older than this dashboard. Rebuild and
          restart <code>pebble serve</code>, then reload.
        </Note>
      ) : (
        <Note tone="error">
          Could not read the org{props.status !== null ? ` (HTTP ${props.status})` : ''}: {props.error}
        </Note>
      )}
      <p className="small">
        Session usage does not depend on the org and is still available: <a href="#/fleet">Usage →</a>
      </p>
    </Section>
  );
}

function NoOrg(props: { data: HqOverview }): ReactNode {
  const source: Record<HqOverview['orgRootSource'], string> = {
    flag: 'the --org flag',
    env: 'PEBBLE_ORG_ROOT',
    discovered: 'searching up from where Pebble was started',
    default: 'the built-in default',
  };
  return (
    <Section title="No org found">
      <p>
        Pebble looked for <code>org.json</code> in <span className="mono">{props.data.orgRoot}</span>, chosen by{' '}
        {source[props.data.orgRootSource]}
        {props.data.orgError ? '.' : ', and did not find one.'}
      </p>
      {props.data.orgError && <Note tone="warn">{props.data.orgError}</Note>}
      <p className="muted small">
        Point it at a holding company with <code>PEBBLE_ORG_ROOT=&lt;path&gt;</code> or{' '}
        <code>pebble serve --org &lt;path&gt;</code>. The directory should contain <code>org.json</code>.
      </p>
      <p className="small">
        Everything about sessions works without an org: <a href="#/fleet">Usage →</a>
        {props.data.outside7d > 0 && <span className="faint"> ({plural(props.data.outside7d, 'session')} this week)</span>}
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Header: one quiet line of totals
// ---------------------------------------------------------------------------

function HqHeader(props: { data: HqOverview; org: OrgSnapshot; now: number }): ReactNode {
  const { data, org } = props;
  const operating = org.subsidiaries.filter((s) => !isArchived(s));
  // Every subsidiary, archived included: a pending request is still a commitment.
  const pending = org.subsidiaries.reduce((sum, s) => sum + s.approvals.filter(isPending).length, 0);
  const working = data.units.reduce((sum, unit) => sum + unit.live.filter((s) => s.status === 'active').length, 0);
  const waiting = data.units.reduce((sum, unit) => sum + unit.live.filter((s) => s.status === 'waiting').length, 0);
  const weekUsd = data.units.reduce((sum, unit) => sum + unit.cost7d.usd, 0);
  const weekApprox = data.units.some((unit) => unit.cost7d.approximate);

  return (
    <header className="hq-head">
      <h1>{org.name ?? 'HQ'}</h1>
      <p className="hq-lede">
        <span>
          <strong>{operating.length}</strong> {operating.length === 1 ? 'subsidiary' : 'subsidiaries'} operating
        </span>
        <span>
          {pending === 0 ? (
            'no approvals pending'
          ) : (
            <>
              <strong className="hq-lede--signal">{pending}</strong> {pending === 1 ? 'approval' : 'approvals'} pending
            </>
          )}
        </span>
        <span>
          {working === 0 ? (
            'nobody working'
          ) : (
            <>
              <strong className="hq-lede--live">{working}</strong> working
            </>
          )}
          {waiting > 0 && (
            <>
              , <strong className="hq-lede--signal">{waiting}</strong> waiting on you
            </>
          )}
        </span>
        <span title="Session cost inside the org over the last 7 days.">
          <strong>
            <Money
              usd={weekUsd}
              approximate={weekApprox}
              reason="At least one session in this week's total has an estimated, incomplete or disputed cost."
            />
          </strong>{' '}
          this week
        </span>
        <span className="faint" title={`org.json: ${org.orgFile}`}>
          read {relativeTime(org.readAt, props.now)}
        </span>
      </p>
    </header>
  );
}

// ---------------------------------------------------------------------------
// The floor: map, inspector and notice board
// ---------------------------------------------------------------------------

function Floor(props: { data: HqOverview; org: OrgSnapshot; now: number }): ReactNode {
  const { data, org, now } = props;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const inspectorRef = useRef<HTMLDivElement>(null);

  const buildings = buildFloor(data, org);
  const pins = pinItems(data.attention, buildings);
  const archivedCount = buildings.filter((b) => b.archived).length;
  const plaza = buildings.filter((b) => b.kind !== 'subsidiary');
  const street = buildings.filter((b) => b.kind === 'subsidiary' && (showArchived || !b.archived));

  // A selection that points at something no longer on the map (an archived
  // building just hidden, a session that ended) closes rather than going blank.
  const visible = selection ? buildings.find((b) => b.id === selection.unit) : undefined;
  const live = selection && visible && (!visible.archived || showArchived) ? selection : null;

  const select = (next: Selection | null): void => {
    setSelection((current) => (sameSelection(current, next) ? null : next));
  };

  const reveal = (next: Selection): void => {
    const building = buildings.find((b) => b.id === next.unit);
    if (building?.archived) setShowArchived(true);
    setSelection(next);
  };

  // At phone width the inspector sits below the map, so bring it into view.
  useEffect(() => {
    if (!live || !inspectorRef.current) return;
    if (window.matchMedia('(width <= 52rem)').matches) {
      inspectorRef.current.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, [live?.kind, live?.unit, live && 'department' in live ? live.department : null, live && 'session' in live ? live.session : null]);

  return (
    <div className="floor">
      <div className="floor__map">
        <div className="map" aria-label="Office map">
          <div className="map__plaza">
            {plaza.map((building) => (
              <Building
                key={building.id}
                building={building}
                pins={pins}
                selection={live}
                onSelect={select}
                now={now}
              />
            ))}
          </div>
          <div className="map__street">
            {street.length === 0 ? (
              <p className="map__empty">
                No subsidiaries in org.json yet. Add one with <code>org new-subsidiary</code> and its building goes up here.
              </p>
            ) : (
              street.map((building) => (
                <Building
                  key={building.id}
                  building={building}
                  pins={pins}
                  selection={live}
                  onSelect={select}
                  now={now}
                />
              ))
            )}
          </div>
          {archivedCount > 0 && (
            <div className="map__foot">
              <button type="button" className="pill" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
                show archived
                <span className="pill__n">{archivedCount}</span>
              </button>
              <span className="faint small">{showArchived ? 'boarded up, still inspectable' : 'hidden'}</span>
            </div>
          )}
        </div>
      </div>

      <div className="floor__side">
        <div className="floor__inspector" ref={inspectorRef}>
          {live ? (
            <Inspector selection={live} buildings={buildings} data={data} org={org} pins={pins} now={now} onClose={() => setSelection(null)} />
          ) : (
            <p className="inspector-hint">Click a room, a desk or a building's sign to look inside.</p>
          )}
        </div>
        <NoticeBoard data={data} buildings={buildings} selection={live} onReveal={reveal} now={now} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

function Building(props: {
  building: BuildingModel;
  pins: Pins;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  now: number;
}): ReactNode {
  const { building, pins, selection, onSelect } = props;
  const subsidiary = building.subsidiary;
  const here = pins.get(`b:${building.id}`);
  const charter = (here ?? []).some((item) => item.kind === 'charter');
  const signSelected = selection?.kind === 'building' && selection.unit === building.id;
  const missing = subsidiary ? !subsidiary.exists : false;

  const classes = [
    'bldg',
    `bldg--${building.kind}`,
    `roof-${building.roof}`,
    // Buildings are as wide as their rooms need: two floors of rooms, 2–4 across.
    building.kind === 'subsidiary' && !building.archived ? `bldg--cols-${Math.min(4, Math.max(2, Math.ceil(building.rooms.length / 2)))}` : '',
    building.archived ? 'bldg--boarded' : '',
    charter ? 'bldg--scaffold' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const signLabel =
    `${building.name}, ${building.subtitle}.` +
    (building.archived ? ' Archived and boarded up.' : '') +
    (missing ? ' Vault missing.' : '') +
    markerWords(here) +
    ' Inspect building.';

  return (
    <article className={classes} aria-label={building.name}>
      <div className="bldg__top">
        <Markers items={here} only={['drift']} />
        <button type="button" className="bldg__sign" aria-pressed={signSelected} aria-label={signLabel} onClick={() => onSelect({ kind: 'building', unit: building.id })}>
          <span className="bldg__name">{building.name}</span>
          <span className="bldg__sub">{building.subtitle}</span>
        </button>
        {charter && (
          <span className="bldg__construction">
            <Markers items={here} only={['charter']} />
            <span className="bldg__construction-text">charter unfilled</span>
          </span>
        )}
        {missing && <Marker kind="missing" label="Vault missing on disk" urgent />}
      </div>

      <div className="bldg__body">
        {building.archived ? (
          <div className="bldg__boards">
            <span className="bldg__boards-text">
              archived{subsidiary?.archived ? ` ${subsidiary.archived}` : ''} · {plural(building.rooms.length, 'room')} boarded up
            </span>
          </div>
        ) : building.kind === 'subsidiary' ? (
          building.rooms.length === 0 ? (
            <p className="bldg__empty">
              No departments in org.json. Add one with <code>org new-department</code> and a room opens here.
            </p>
          ) : (
            <div className="bldg__rooms">
              {building.rooms.map((room) => (
                <Room
                  key={room.id}
                  building={building}
                  room={room}
                  items={pins.get(`r:${building.id}:${room.id}`)}
                  selected={selection?.kind === 'room' && selection.unit === building.id && selection.department === room.id}
                  onSelect={() => onSelect({ kind: 'room', unit: building.id, department: room.id })}
                />
              ))}
            </div>
          )
        ) : (
          <OpenPlan building={building} pins={pins} selection={selection} onSelect={onSelect} />
        )}

        <Lobby building={building} pins={pins} selection={selection} onSelect={onSelect} />
      </div>
    </article>
  );
}

function Room(props: {
  building: BuildingModel;
  room: RoomModel;
  items: AttentionItem[] | undefined;
  selected: boolean;
  onSelect: () => void;
}): ReactNode {
  const { building, room, items } = props;
  const activity = room.activity;
  const folderMissing = room.org?.folderExists === false;
  const label =
    `${room.name} room in ${building.name}. Agent ${room.agent}: ${room.statusText}.` +
    (activity?.lastTitle && room.pose !== 'empty' && room.pose !== 'vacant' ? ` Working on ${activity.lastTitle}.` : '') +
    (folderMissing ? ' Department folder missing.' : '') +
    (room.org === null ? ' Not listed in org.json.' : '') +
    markerWords(items);

  return (
    <button
      type="button"
      className={`room room--${room.pose}${folderMissing ? ' room--cracked' : ''}`}
      aria-pressed={props.selected}
      aria-label={label}
      onClick={props.onSelect}
    >
      <span className="room__wall">
        <span className="room__plate">{room.name}</span>
        <span className="room__pins" aria-hidden="true">
          <Markers items={items} except={room.pose === 'waiting' ? ['waiting-session'] : []} />
          {folderMissing && <Marker kind="missing" label="Department folder missing" urgent />}
        </span>
      </span>
      <DeskScene pose={room.pose} tint={room.tint} look={hashOf(`${building.id}/${room.id}`)} className="room__scene" />
      <span className="room__caption" aria-hidden="true">
        <span className={`room__status room__status--${room.pose}`}>{room.statusText}</span>
        {activity?.lastTitle && room.pose !== 'empty' && room.pose !== 'vacant' && (
          <span className="room__doing">{activity.lastTitle}</span>
        )}
        {room.org === null && <span className="room__flag">not in org.json</span>}
      </span>
    </button>
  );
}

/** Head office and workshops: an open floor with one desk per live session. */
function OpenPlan(props: { building: BuildingModel; pins: Pins; selection: Selection | null; onSelect: (s: Selection) => void }): ReactNode {
  const { building } = props;
  if (building.desks.length === 0) {
    return (
      <p className="bldg__empty">
        {building.kind === 'hq'
          ? 'Nobody at head office right now. A session started in the HQ vault takes a desk here while it runs.'
          : `The workbench is free. A session started in ${building.name} takes a seat here while it runs.`}
      </p>
    );
  }
  return (
    <div className="bldg__desks">
      {building.desks.map((session) => (
        <Desk key={sessionKey(session)} building={building} session={session} pins={props.pins} selection={props.selection} onSelect={props.onSelect} />
      ))}
    </div>
  );
}

function Desk(props: {
  building: BuildingModel;
  session: PlacedSession;
  pins: Pins;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
}): ReactNode {
  const { building, session } = props;
  const key = sessionKey(session);
  const items = props.pins.get(`d:${building.id}:${key}`);
  const { pose, text } = DESK_POSE[session.status];
  const selected = props.selection?.kind === 'desk' && props.selection.unit === building.id && props.selection.session === key;
  return (
    <button
      type="button"
      className={`room room--desk room--${pose}`}
      aria-pressed={selected}
      aria-label={`Session at ${building.name}: ${session.title}. Status: ${text}.${markerWords(items)}`}
      onClick={() => props.onSelect({ kind: 'desk', unit: building.id, session: key })}
    >
      <span className="room__pins room__pins--float" aria-hidden="true">
        {/* The sprite's own bubble already says "waiting"; a second "!" is noise. */}
        <Markers items={items} except={pose === 'waiting' ? ['waiting-session'] : []} />
      </span>
      <DeskScene pose={pose} tint="worker" look={hashOf(key)} className="room__scene" />
      <span className="room__caption" aria-hidden="true">
        <span className={`room__status room__status--${pose}`}>{text}</span>
        <span className="room__doing">{session.title}</span>
      </span>
    </button>
  );
}

/** The ground floor: a door for notes, a mailbox for approvals, and anyone without a room. */
function Lobby(props: { building: BuildingModel; pins: Pins; selection: Selection | null; onSelect: (s: Selection) => void }): ReactNode {
  const { building, pins } = props;
  const here = pins.get(`b:${building.id}`);
  const lobbyDesks = building.kind === 'subsidiary' ? building.desks : [];
  const mail = (here ?? []).filter((item) => item.kind === 'approval').length;
  const doorLabel = markerWords((here ?? []).filter((item) => item.kind !== 'approval' && item.kind !== 'drift' && item.kind !== 'charter'));

  return (
    <div className="lobby">
      <span className={`lobby__mailbox${mail > 0 ? ' lobby__mailbox--full' : ''}`} role="img" aria-label={mail > 0 ? `Mailbox: ${plural(mail, 'pending approval')}` : 'Mailbox: empty'} title={mail > 0 ? plural(mail, 'pending approval') : 'No approvals waiting'}>
        <span className="lobby__flag" aria-hidden="true" />
        {mail > 0 && <span className="lobby__mail-n" aria-hidden="true">{mail}</span>}
      </span>
      <span className="lobby__door" role="img" aria-label={doorLabel ? `Door:${doorLabel}` : 'Door: nothing pinned'}>
        <span className="lobby__notes" aria-hidden="true">
          <Markers items={here} except={['approval', 'drift', 'charter']} />
        </span>
      </span>
      {lobbyDesks.length > 0 ? (
        <div className="lobby__desks">
          {lobbyDesks.map((session) => (
            <Desk key={sessionKey(session)} building={building} session={session} pins={pins} selection={props.selection} onSelect={props.onSelect} />
          ))}
        </div>
      ) : (
        <span className="lobby__label">{building.kind === 'subsidiary' ? 'lobby' : 'front door'}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspector: inline, beside the map (or below it on a phone)
// ---------------------------------------------------------------------------

function Inspector(props: {
  selection: Selection;
  buildings: BuildingModel[];
  data: HqOverview;
  org: OrgSnapshot;
  pins: Pins;
  now: number;
  onClose: () => void;
}): ReactNode {
  const { selection, buildings } = props;
  const building = buildings.find((b) => b.id === selection.unit);
  if (!building) return null;

  let body: ReactNode = null;
  let title = building.name;
  let kicker = building.subtitle;
  if (selection.kind === 'room') {
    const room = building.rooms.find((r) => r.id === selection.department);
    if (!room) return null;
    title = room.name;
    kicker = `${building.name} · room`;
    body = <RoomInspector building={building} room={room} items={props.pins.get(`r:${building.id}:${room.id}`)} org={props.org} now={props.now} />;
  } else if (selection.kind === 'desk') {
    const session = building.desks.find((s) => sessionKey(s) === selection.session);
    if (!session) return null;
    title = session.title;
    kicker = `${building.name} · desk`;
    body = <DeskInspector session={session} items={props.pins.get(`d:${building.id}:${selection.session}`)} now={props.now} />;
  } else {
    body = <BuildingInspector building={building} data={props.data} org={props.org} items={props.pins.get(`b:${building.id}`)} now={props.now} />;
  }

  return (
    <section className="inspector" aria-label={`Inspecting ${title}`}>
      <header className="inspector__head">
        <div className="inspector__titles">
          <span className="inspector__kicker">{kicker}</span>
          <h2 className="inspector__title">{title}</h2>
        </div>
        <button type="button" className="btn" onClick={props.onClose}>
          close
        </button>
      </header>
      {body}
    </section>
  );
}

function Block(props: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="ins-block">
      <h3 className="ins-block__label">{props.label}</h3>
      {props.children}
    </div>
  );
}

function NoteLink(props: { path: string; root: string; label: ReactNode }): ReactNode {
  return (
    <a href={obsidianHref(props.path)} title={`Open ${relativeTo(props.path, props.root)} in Obsidian`}>
      {props.label} ↗
    </a>
  );
}

function AttentionList(props: { items: AttentionItem[] | undefined; root: string; now: number }): ReactNode {
  const items = props.items ?? [];
  if (items.length === 0) return null;
  return (
    <Block label="Pinned here">
      <ul className="ins-list">
        {items.map((item) => (
          <li key={item.id} className="ins-pin">
            <Marker kind={item.kind as MarkerKind} label={KIND_WORDS[item.kind][0]} urgent={LEVEL_RANK[item.level] > 0} />
            <span className="ins-pin__body">
              <span className="ins-pin__title">{item.title}</span>
              {item.detail && <span className="muted small"> — {item.detail}</span>}
              <span className="ins-pin__links small">
                {item.session && <a href={sessionHref(item.session)}>session →</a>}
                {item.path && <NoteLink path={item.path} root={props.root} label="open" />}
                {isTime(item.at) && <span className="faint">{relativeTime(item.at, props.now)}</span>}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Block>
  );
}

function kpiFill(scorecard: OrgDepartment['scorecard']): { filled: number; total: number } | null {
  if (!scorecard) return null;
  const filled = scorecard.kpis.filter((kpi) => (kpi.latest ?? '').trim() !== '').length;
  return { filled, total: scorecard.kpis.length };
}

function RoomInspector(props: {
  building: BuildingModel;
  room: RoomModel;
  items: AttentionItem[] | undefined;
  org: OrgSnapshot;
  now: number;
}): ReactNode {
  const { building, room, org, now } = props;
  const activity = room.activity;
  const fill = kpiFill(room.org?.scorecard ?? null);
  const charter = building.subsidiary?.charter ?? null;

  return (
    <>
      <div className="ins-portrait">
        <DeskScene pose={room.pose} tint={room.tint} look={hashOf(`${building.id}/${room.id}`)} className="ins-portrait__scene" />
        <dl className="kv">
          <dt>agent</dt>
          <dd>
            <span className="mono">{room.agent}</span>
            {room.org && !room.org.agentDefined && (
              <>
                {' '}
                <Badge tone="error" title="No agent definition file for this department">
                  not defined
                </Badge>
              </>
            )}
          </dd>
          <dt>status</dt>
          <dd>{activity?.status ? <StatusDot status={activity.status} /> : <span className="muted">{room.statusText}</span>}</dd>
          <dt>this week</dt>
          <dd>{activity && activity.runs7d > 0 ? plural(activity.runs7d, 'run') : <span className="faint">no runs</span>}</dd>
          <dt>last run</dt>
          <dd>
            {activity?.lastActivityAt ? (
              <span title={activity.lastActivityAt}>{relativeTime(activity.lastActivityAt, now)}</span>
            ) : (
              <span className="faint">never</span>
            )}
          </dd>
        </dl>
      </div>

      {room.org === null && (
        <Note tone="warn">Sessions were placed in this department, but org.json does not list it.</Note>
      )}
      {room.org?.folderExists === false && <Note tone="error">The department folder is missing: {relativeTo(room.org.path, org.root)}</Note>}

      <Block label="What it is doing">
        {activity?.lastTitle ? (
          activity.lastSession ? (
            <a href={sessionHref(activity.lastSession)}>{activity.lastTitle} →</a>
          ) : (
            <span>{activity.lastTitle}</span>
          )
        ) : (
          <p className="faint small">
            Nothing yet. When the {room.agent} agent runs, its latest session's title shows here and links to the transcript.
          </p>
        )}
      </Block>

      <AttentionList items={props.items} root={org.root} now={now} />

      <Block label="Scorecard">
        {!room.org?.scorecard || !fill ? (
          <p className="faint small">No scorecard note for this department.</p>
        ) : (
          <>
            <div className="ins-kpi-fill">
              <Meter value={fill.filled} max={fill.total} title={`${fill.filled} of ${fill.total} KPIs have a latest value`} />
              <span className="small nowrap">
                {fill.filled}/{fill.total} measured
              </span>
              <NoteLink path={room.org.scorecard.path} root={org.root} label="scorecard" />
            </div>
            {room.org.scorecard.kpis.length > 0 && (
              <ul className="ins-kpis">
                {room.org.scorecard.kpis.map((kpi) => (
                  <li key={kpi.name}>
                    <span className="ins-kpis__name">{kpi.name}</span>
                    <span className="ins-kpis__value">
                      {(kpi.latest ?? '').trim() ? kpi.latest : <span className="faint">not measured</span>}
                      {kpi.target && <span className="faint"> / {kpi.target}</span>}
                      {kpi.verified && (kpi.latest ?? '').trim() && (
                        <span className={kpi.verified.trim().toLowerCase() === 'verified' ? 'faint' : 'ins-provisional'}> ({kpi.verified})</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Block>

      <Block label="Notes">
        <p className="ins-links small">
          {charter ? <NoteLink path={charter.path} root={org.root} label="charter" /> : <span className="faint">no charter note</span>}
          {room.org && <NoteLink path={room.org.path} root={org.root} label="department folder" />}
        </p>
      </Block>
    </>
  );
}

function DeskInspector(props: { session: PlacedSession; items: AttentionItem[] | undefined; now: number }): ReactNode {
  const { session, now } = props;
  const model = session.models[session.models.length - 1] ?? null;
  return (
    <>
      <div className="ins-portrait">
        <DeskScene pose={DESK_POSE[session.status].pose} tint="worker" look={hashOf(sessionKey(session))} className="ins-portrait__scene" />
        <dl className="kv">
          <dt>status</dt>
          <dd>
            <StatusDot status={session.status} />
          </dd>
          <dt>running</dt>
          <dd>{duration(now - Date.parse(session.startedAt))}</dd>
          <dt>last</dt>
          <dd>{relativeTime(session.lastActivityAt, now)}</dd>
          <dt>cost</dt>
          <dd>
            <CostFigure cost={session.cost} />
            {session.subagentCount > 0 && (
              <span className="faint small">
                {' '}
                + <CostFigure cost={session.subagentCost} /> in {plural(session.subagentCount, 'sub-agent')}, counted separately
              </span>
            )}
          </dd>
        </dl>
      </div>
      <dl className="kv">
        <dt>project</dt>
        <dd className="mono small">{session.projectLabel}</dd>
        {model && (
          <>
            <dt>model</dt>
            <dd className="mono small">{model}</dd>
          </>
        )}
        {session.errorCount > 0 && (
          <>
            <dt>errors</dt>
            <dd>{session.errorCount}</dd>
          </>
        )}
      </dl>
      <AttentionList items={props.items} root="" now={now} />
      <p className="small">
        <a href={sessionHref(session)}>Open the session →</a>
      </p>
    </>
  );
}

function BuildingInspector(props: {
  building: BuildingModel;
  data: HqOverview;
  org: OrgSnapshot;
  items: AttentionItem[] | undefined;
  now: number;
}): ReactNode {
  const { building, org, now } = props;
  const subsidiary = building.subsidiary;
  const unit = building.unit;
  const tool = building.kind === 'tooling' ? org.tooling.find((t) => t.id === building.id) : undefined;
  const vaultPath = subsidiary?.path ?? (building.kind === 'hq' ? org.hq.path : (tool?.path ?? null));
  const changelog = subsidiary ? subsidiary.changelog : building.kind === 'hq' ? org.hq.changelog : [];
  const pending = subsidiary ? subsidiary.approvals.filter(isPending) : [];
  const live = unit?.live ?? [];
  const inbox = subsidiary ? subsidiary.inbox : building.kind === 'hq' ? org.hq.inbox : [];
  const proposals = subsidiary ? subsidiary.proposals : building.kind === 'hq' ? org.hq.proposals : [];

  return (
    <>
      <dl className="kv">
        {subsidiary && (
          <>
            <dt>status</dt>
            <dd>
              {subsidiary.status}
              {subsidiary.created && <span className="faint"> · created {subsidiary.created}</span>}
              {subsidiary.archived && <span className="faint"> · archived {subsidiary.archived}</span>}
            </dd>
            <dt>charter</dt>
            <dd>
              {subsidiary.charter === null ? (
                <span className="faint">no charter note</span>
              ) : (
                <>
                  {subsidiary.charter.filled ? 'filled in' : <Badge tone="warn">not filled in</Badge>}{' '}
                  <NoteLink path={subsidiary.charter.path} root={org.root} label="open" />
                </>
              )}
            </dd>
            <dt>review</dt>
            <dd>
              {subsidiary.lastReview ? (
                <NoteLink
                  path={subsidiary.lastReview.path}
                  root={org.root}
                  label={subsidiary.lastReview.updated ? relativeTime(subsidiary.lastReview.updated, now) : 'latest'}
                />
              ) : (
                <span className="faint">none yet</span>
              )}
            </dd>
          </>
        )}
        {tool?.role && (
          <>
            <dt>role</dt>
            <dd>{tool.role}</dd>
          </>
        )}
        <dt>7 days</dt>
        <dd>
          {unit ? (
            <>
              <Money
                usd={unit.cost7d.usd}
                approximate={unit.cost7d.approximate}
                reason={`A session in ${building.name} this week has an estimated, incomplete or disputed cost.`}
              />{' '}
              <span className="faint">over {plural(unit.sessions7d, 'session')}</span>
            </>
          ) : (
            <span className="faint">no sessions placed here</span>
          )}
        </dd>
        {vaultPath && (
          <>
            <dt>{building.kind === 'tooling' ? 'repo' : 'vault'}</dt>
            <dd>
              {building.kind === 'tooling' ? (
                <span className="mono small">{vaultPath}</span>
              ) : (
                <NoteLink path={vaultPath} root={org.root} label={<span className="mono small">{relativeTo(vaultPath, org.root) || vaultPath}</span>} />
              )}
              {subsidiary && !subsidiary.exists && (
                <>
                  {' '}
                  <Badge tone="error">missing</Badge>
                </>
              )}
            </dd>
          </>
        )}
      </dl>

      <AttentionList items={props.items} root={org.root} now={now} />

      {subsidiary && (
        <Block label={`Mailbox · ${plural(pending.length, 'pending approval')}`}>
          {pending.length === 0 ? (
            <p className="faint small">Empty. A request filed in 07 System/Approvals with status: pending lands here.</p>
          ) : (
            <ul className="ins-list">
              {pending.map((approval) => {
                const due = approval.due
                  ? Number.isFinite(Date.parse(approval.due))
                    ? dueLabel(approval.due, now)
                    : { text: `due ${approval.due}`, overdue: false }
                  : null;
                return (
                  <li key={approval.path}>
                    <NoteLink path={approval.path} root={org.root} label={approval.title} />
                    <span className="ins-meta small">
                      {approval.department && <span>{subsidiary.departments.find((d) => d.id === approval.department)?.name ?? approval.department}</span>}
                      {approval.action && <span>{approval.action}</span>}
                      {approval.amountUsd !== null && (
                        <Money usd={approval.amountUsd} approximate reason="Provisional: the amount as the requesting agent wrote it. Not verified." />
                      )}
                      {due && <span className={due.overdue ? 'ins-overdue' : undefined}>{due.text}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Block>
      )}

      {subsidiary && (
        <Block label="Drift">
          {subsidiary.drift.length === 0 ? (
            <p className="faint small">None — org.json and the vault agree.</p>
          ) : (
            <ul className="ins-list">
              {subsidiary.drift.map((issue, index) => (
                <li key={`${issue.code}-${index}`}>
                  <Badge tone={issue.level === 'error' ? 'error' : issue.level === 'warn' ? 'warn' : undefined}>
                    {issue.level === 'info' ? 'note' : issue.level}
                  </Badge>{' '}
                  {issue.message}
                </li>
              ))}
            </ul>
          )}
        </Block>
      )}

      {subsidiary && building.archived && (
        <Block label="Rooms">
          <p className="small muted">{subsidiary.departments.map((d) => d.name).join(' · ') || 'none'}</p>
        </Block>
      )}

      <Block label={`At work now · ${live.length}`}>
        {live.length === 0 ? (
          <p className="faint small">Nobody. A session running in this {building.kind === 'tooling' ? 'repo' : 'vault'} would be listed here.</p>
        ) : (
          <ul className="ins-list">
            {live.map((session) => (
              <li key={sessionKey(session)} className="ins-session">
                <StatusDot status={session.status} />
                <a href={sessionHref(session)} className="truncate" title={session.title}>
                  {session.title}
                </a>
                <CostFigure cost={session.cost} />
              </li>
            ))}
          </ul>
        )}
      </Block>

      {(inbox.length > 0 || proposals.length > 0) && (
        <Block label="On the door">
          <ul className="ins-list">
            {[...inbox.map((note) => ({ note, what: 'inbox' })), ...proposals.map((note) => ({ note, what: 'proposal' }))]
              .slice(0, 6)
              .map(({ note, what }) => (
                <li key={note.path}>
                  <span className="faint small">{what}</span> <NoteLink path={note.path} root={org.root} label={note.title} />
                </li>
              ))}
          </ul>
          {inbox.length + proposals.length > 6 && <p className="faint small">and {inbox.length + proposals.length - 6} more</p>}
        </Block>
      )}

      {building.kind === 'hq' && (
        <Block label="Recent decisions">
          <NoteList notes={org.hq.decisions.slice(0, 4)} root={org.root} empty="No decision notes in 05 Decisions yet." />
        </Block>
      )}

      {building.kind !== 'tooling' && (
        <Block label="Recent changes">
          {changelog.length === 0 ? (
            <p className="faint small">No entries in this vault's CHANGELOG.md yet.</p>
          ) : (
            <ul className="ins-list">
              {changelog.slice(0, 5).map((entry, index) => (
                <li key={`${entry.date}-${index}`} className="small">
                  <span className="faint nowrap">{entry.date}</span> <ChangelogText text={entry.text} />
                </li>
              ))}
            </ul>
          )}
        </Block>
      )}
    </>
  );
}

function NoteList(props: { notes: OrgNote[]; root: string; empty: string }): ReactNode {
  if (props.notes.length === 0) return <p className="faint small">{props.empty}</p>;
  return (
    <ul className="ins-list">
      {props.notes.map((note) => (
        <li key={note.path}>
          <NoteLink path={note.path} root={props.root} label={note.title} />
          {note.updated && <span className="faint small"> {note.updated}</span>}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Notice board: everything that needs Connor, each pinned to its place
// ---------------------------------------------------------------------------

const BOARD_CAP = 6;
const LEVEL_WORD: Record<IssueLevel, string> = { error: 'urgent', warn: 'needs you', info: 'note' };

function NoticeBoard(props: {
  data: HqOverview;
  buildings: BuildingModel[];
  selection: Selection | null;
  onReveal: (selection: Selection) => void;
  now: number;
}): ReactNode {
  const { data, buildings, now } = props;
  const [showInfo, setShowInfo] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const root = data.org?.root ?? '';

  const urgent = data.attention.filter((item) => LEVEL_RANK[item.level] > 0);
  const notes = data.attention.length - urgent.length;
  // Notes are worth seeing, not worth crowding out an approval: folded by default.
  const listed = showInfo ? data.attention : urgent;
  const shown = showAll ? listed : listed.slice(0, BOARD_CAP);

  const where = (item: AttentionItem): string => {
    const building = buildings.find((b) => b.id === item.unit);
    if (!building) return 'org-wide';
    const room = item.department ? building.rooms.find((r) => r.id === item.department) : undefined;
    return room ? `${building.name} · ${room.name}` : item.department ? `${building.name} · ${item.department}` : building.name;
  };

  return (
    <section className="board" aria-labelledby="board-title">
      <header className="board__head">
        <h2 id="board-title">Notice board</h2>
        <span className="board__count">
          {urgent.length === 0 ? 'nothing urgent' : `${urgent.length} need${urgent.length === 1 ? 's' : ''} you`}
        </span>
      </header>

      {data.attention.length === 0 ? (
        <p className="board__empty">
          Nothing pinned. Pending approvals, agents waiting on a reply, sessions that ended in errors, drift, unfiled inbox
          notes, proposals, unfilled charters and overdue reviews would be pinned here.
        </p>
      ) : shown.length === 0 ? (
        <p className="board__empty">Nothing needs you right now.</p>
      ) : (
        <ul className="board__slips">
          {shown.map((item) => {
            const { selection } = locate(item, buildings);
            const approval =
              item.kind === 'approval' && item.path
                ? data.org?.subsidiaries.find((s) => s.id === item.unit)?.approvals.find((a) => a.path === item.path)
                : undefined;
            // A free-text due ("before the 1.0 submission") is already in the detail.
            const due = approval?.due && Number.isFinite(Date.parse(approval.due)) ? dueLabel(approval.due, now) : null;
            const here = selection !== null && sameSelection(selection, props.selection);
            return (
              <li key={item.id} className={`slip slip--${item.level}${here ? ' slip--here' : ''}`}>
                <Marker kind={item.kind as MarkerKind} label={KIND_WORDS[item.kind][0]} urgent={LEVEL_RANK[item.level] > 0} />
                <div className="slip__body">
                  <span className="slip__meta">
                    <span className="slip__level">{LEVEL_WORD[item.level]}</span>
                    <span className="slip__where">{where(item)}</span>
                  </span>
                  {selection ? (
                    <button type="button" className="slip__title" onClick={() => props.onReveal(selection)} title="Show it on the map">
                      {item.title}
                    </button>
                  ) : (
                    <span className="slip__title">{item.title}</span>
                  )}
                  {item.detail && <span className="slip__detail" title={item.detail}>{item.detail}</span>}
                  <span className="slip__links">
                    {due ? (
                      <span className={due.overdue ? 'ins-overdue' : undefined}>{due.text}</span>
                    ) : (
                      isTime(item.at) && <span title={item.at}>{relativeTime(item.at, now)}</span>
                    )}
                    {item.session && <a href={sessionHref(item.session)}>session →</a>}
                    {item.path && <NoteLink path={item.path} root={root} label="open" />}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="board__foot">
        {listed.length > BOARD_CAP && (
          <button type="button" className="btn btn--plain small" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'show fewer' : `show ${listed.length - BOARD_CAP} more`}
          </button>
        )}
        {notes > 0 && (
          <button type="button" className="btn btn--plain small" onClick={() => setShowInfo((v) => !v)} aria-expanded={showInfo}>
            {showInfo ? 'fold notes away' : `unfold ${plural(notes, 'note')}`}
          </button>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Logbook: the org's changelogs, merged
// ---------------------------------------------------------------------------

type ActivityKey = 'date' | 'unit' | 'actor' | 'text';
type IndexedEntry = ChangelogEntry & { seq: number };

/**
 * Changelog lines are markdown written for Obsidian. Show `[[Note|alias]]` as its
 * text, drop `**bold**` markers, and show backticks as code; nothing else is interpreted.
 */
function ChangelogText(props: { text: string }): ReactNode {
  const unlinked = props.text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => alias ?? target).replace(/\*\*([^*]+)\*\*/g, '$1');
  const parts = unlinked.split('`');
  // An unmatched backtick means the split would turn trailing prose into code.
  if (parts.length % 2 === 0) return <span className="hq-text">{unlinked}</span>;
  return (
    <span className="hq-text">
      {parts.map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : part))}
    </span>
  );
}

function Logbook(props: { data: HqOverview; org: OrgSnapshot }): ReactNode {
  const { data, org } = props;
  const [units, setUnits] = useState<string[]>([]);
  const sort = useSort<ActivityKey>('date');

  const names = new Map<string, string>();
  for (const subsidiary of org.subsidiaries) names.set(subsidiary.id, subsidiary.name);
  for (const unit of data.units) names.set(unit.id, unit.name);
  const unitName = (id: string): string => names.get(id) ?? (id === 'hq' ? 'HQ' : id);

  // Merge newest first; a stable sort keeps each vault's within-day order.
  const merged: IndexedEntry[] = [org.hq.changelog, ...org.subsidiaries.map((s) => s.changelog)]
    .flat()
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.date === b.entry.date ? a.index - b.index : a.entry.date < b.entry.date ? 1 : -1))
    .map(({ entry }, seq) => ({ ...entry, seq }));

  const unitIds = [...new Set(merged.map((e) => e.unit))];
  const shown = units.length === 0 ? merged : merged.filter((e) => units.includes(e.unit));

  const columns: Column<IndexedEntry, ActivityKey>[] = [
    { key: 'date', header: 'date', render: (row) => <span className="nowrap muted">{row.date}</span> },
    { key: 'unit', header: 'where', wideOnly: true, render: (row) => <Badge>{unitName(row.unit)}</Badge> },
    { key: 'actor', header: 'who', wideOnly: true, render: (row) => <span className="muted nowrap">{row.actor}</span> },
    {
      key: 'text',
      header: 'what',
      render: (row) => (
        <>
          <span className="t__narrow faint small">
            {unitName(row.unit)} · {row.actor}
          </span>
          <ChangelogText text={row.text} />
        </>
      ),
    },
  ];

  return (
    <Section
      title="Logbook"
      count={merged.length}
      note="from each vault's CHANGELOG.md"
      actions={
        unitIds.length > 1 ? (
          <FilterPills
            label="where"
            options={unitIds.map((id) => ({ value: id, label: unitName(id), count: merged.filter((e) => e.unit === id).length }))}
            active={units}
            onToggle={(value) =>
              setUnits((current) => (current.includes(value) ? current.filter((v) => v !== value) : [...current, value]))
            }
          />
        ) : undefined
      }
    >
      <DataTable
        rows={sort.sort(shown, (row, key) =>
          // Within a day, keep each changelog's own (newest-first) order.
          key === 'date' ? `${row.date}|${String(1e6 - row.seq).padStart(7, '0')}` : key === 'unit' ? unitName(row.unit) : key === 'actor' ? row.actor : row.text,
        )}
        columns={columns}
        rowKey={(row) => `${row.unit}:${row.seq}`}
        sortKey={sort.key}
        sortDirection={sort.direction}
        onSort={sort.toggle}
        pageSize={8}
        compact
        empty="No changelog entries yet. Lines of the form “- YYYY-MM-DD — actor — what” in any vault's CHANGELOG.md show up here."
      />
    </Section>
  );
}

// Re-exported for the rail, which counts the same thing the notice board shows.
export function urgentCount(data: HqOverview | null): number {
  return data ? data.attention.filter((item) => LEVEL_RANK[item.level] > 0).length : 0;
}

export function orgWorking(data: HqOverview | null): number {
  return data ? data.units.reduce((sum, unit) => sum + unit.live.filter((s) => s.status === 'active').length, 0) : 0;
}
