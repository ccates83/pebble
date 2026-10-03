import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import type { AttentionItem, AttentionKind } from '@pebble/core';
import {
  COOLER,
  MailboxArt,
  Marker,
  PLANT_LEAVES,
  PLANT_POT,
  Pixels,
  SEAT_X,
  SEAT_Y,
  SeatedSprite,
  StandSprite,
  StationArt,
  WalkSprite,
  lookClasses,
  styleOf,
  type Facing,
  type MarkerKind,
  type Pose,
  type SeatedPose,
} from '../components/sprites.tsx';
import { isPending, kindSummary, markerWords, plural, type Pins, type Selection, type StationModel, type UnitModel } from './hqModel.ts';

/*
 * The office map: one room per unit, seen from a 3/4 top-down view.
 *
 * Geometry is in art pixels. A room is drawn once as an SVG (floor, walls,
 * door, desks, decor) and scaled to its column with crisp edges; HTML sits on
 * top at the same art coordinates for everything you can click or read. The
 * only inline styles are custom properties carrying positions and sizes in art
 * pixels (`--x`, `--y`, `--w`, `--h`, `--t`, `--z`); office.css turns them into
 * layout with one `--px` unit per room.
 *
 * Characters walk. When the data shows someone new at a desk they come in at
 * the door and walk to their chair; when the data shows them gone they stand,
 * walk out and disappear. Nobody walks anywhere the data did not say.
 */

// ---------------------------------------------------------------------------
// Geometry, in art pixels
// ---------------------------------------------------------------------------

const WALL = 6;
const BACK = 44;
const CORRIDOR = 22;
const CELL_W = 44;
const ROW_H = 66;
const RIGHT = 16;
const FRONT = 26;
/** Walking speed, art pixels per second. */
const SPEED = 72;

interface Geometry {
  cols: number;
  rows: number;
  count: number;
  w: number;
  h: number;
}

function geometry(count: number, cols: number): Geometry {
  const rows = Math.max(1, Math.ceil(count / cols));
  return { cols, rows, count: rows * cols, w: WALL + CORRIDOR + cols * CELL_W + RIGHT + WALL, h: BACK + rows * ROW_H + FRONT };
}

function stationAt(index: number, cols: number): { x: number; y: number; row: number } {
  const row = Math.floor(index / cols);
  return { x: WALL + CORRIDOR + (index % cols) * CELL_W, y: BACK + 2 + row * ROW_H, row };
}

interface Point {
  x: number;
  y: number;
}

const DOOR_X = WALL + CORRIDOR / 2;

/** The walk in, as waypoints for the feet: outside the door, up the corridor, along the row, to the chair. */
function pathIn(index: number, geo: Geometry): Point[] {
  const at = stationAt(index, geo.cols);
  const seatX = at.x + SEAT_X + 6;
  const lane = at.y + 62;
  return [
    { x: DOOR_X, y: geo.h + 22 },
    { x: DOOR_X, y: lane },
    { x: seatX, y: lane },
    { x: seatX, y: at.y + 44 },
  ];
}

function seatPoint(index: number, geo: Geometry): Point {
  const at = stationAt(index, geo.cols);
  return { x: at.x + SEAT_X + 6, y: at.y + SEAT_Y + 24 };
}

function vars(values: Record<string, number>): CSSProperties {
  const style: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) style[`--${name}`] = String(Math.round(value * 100) / 100);
  return style as CSSProperties;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------------------------------------------------------------------------
// The cast: who is walking in, sitting, or walking out
// ---------------------------------------------------------------------------

interface Occupant {
  id: string;
  index: number;
  pose: SeatedPose;
  tint: number | 'worker';
  look: number;
}

interface Walker extends Occupant {
  phase: 'in' | 'seated' | 'out';
  /** Milliseconds to wait at the door: the first-load entrance is staggered. */
  delay: number;
  /** Bumped when someone who was leaving comes back, so their walk restarts. */
  gen: number;
}

/*
 * Who was seated in each room the last time this page drew it. It outlives a
 * remount (navigating to Usage and back, a room changing column), so a remount
 * diffs against what you last saw instead of replaying the entrance or
 * forgetting someone left.
 */
const castMemory = new Map<string, Map<string, Occupant>>();
let entranceShown = false;

function occupantsOf(stations: StationModel[]): Occupant[] {
  return stations.flatMap((station) =>
    station.occupant && (station.pose === 'active' || station.pose === 'waiting' || station.pose === 'idle')
      ? [{ id: station.occupant, index: station.index, pose: station.pose, tint: station.tint, look: station.look }]
      : [],
  );
}

function initialCast(roomId: string, occupants: Occupant[], entranceBase: number): Walker[] {
  const reduce = prefersReducedMotion();
  const remembered = castMemory.get(roomId);
  if (!remembered) {
    // First page load: everyone already live walks in, staggered. A room seen
    // for the first time later (say, an archived one just shown) is not an
    // arrival, so its people are simply there.
    const parade = !entranceShown && !reduce;
    return occupants.map((occupant, index) => ({
      ...occupant,
      phase: parade ? 'in' : 'seated',
      delay: parade ? Math.min((entranceBase + index) * 170, 2200) : 0,
      gen: 0,
    }));
  }
  const present = new Set(occupants.map((o) => o.id));
  const walkers: Walker[] = occupants.map((occupant) => ({
    ...occupant,
    phase: remembered.has(occupant.id) || reduce ? 'seated' : 'in',
    delay: 0,
    gen: 0,
  }));
  if (!reduce) {
    for (const gone of remembered.values()) {
      if (!present.has(gone.id)) walkers.push({ ...gone, phase: 'out', delay: 0, gen: 0 });
    }
  }
  return walkers;
}

function reconcile(current: Walker[], occupants: Occupant[]): Walker[] {
  const reduce = prefersReducedMotion();
  const pending = new Map(occupants.map((o) => [o.id, o]));
  const next: Walker[] = [];
  for (const walker of current) {
    const occupant = pending.get(walker.id);
    pending.delete(walker.id);
    if (walker.phase === 'out') {
      // Came back before reaching the door: walk in again.
      next.push(occupant ? { ...occupant, phase: reduce ? 'seated' : 'in', delay: 0, gen: walker.gen + 1 } : walker);
    } else if (occupant) {
      next.push({ ...walker, ...occupant });
    } else if (!reduce) {
      next.push({ ...walker, phase: 'out', delay: 0 });
    }
  }
  for (const occupant of pending.values()) next.push({ ...occupant, phase: reduce ? 'seated' : 'in', delay: 0, gen: 0 });
  return next;
}

function useCast(roomId: string, occupants: Occupant[], entranceBase: number): [Walker[], (walker: Walker) => void] {
  const [walkers, setWalkers] = useState<Walker[]>(() => initialCast(roomId, occupants, entranceBase));
  const signature = occupants.map((o) => `${o.id}@${o.index}:${o.pose}`).join('|');
  const latest = useRef(occupants);
  latest.current = occupants;

  // Diff the previous seating against the next read. Arrivals and departures
  // come only from here, i.e. only from the data.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setWalkers((current) => reconcile(current, latest.current));
  }, [signature]);

  useEffect(() => {
    castMemory.set(roomId, new Map(walkers.filter((w) => w.phase !== 'out').map((w) => [w.id, { id: w.id, index: w.index, pose: w.pose, tint: w.tint, look: w.look }])));
  }, [roomId, walkers]);

  const finished = useCallback((done: Walker) => {
    setWalkers((current) =>
      done.phase === 'out'
        ? current.filter((w) => !(w.id === done.id && w.phase === 'out' && w.gen === done.gen))
        : current.map((w) => (w.id === done.id && w.phase === 'in' && w.gen === done.gen ? { ...w, phase: 'seated' } : w)),
    );
  }, []);

  return [walkers, finished];
}

function facingOf(from: Point, to: Point): { facing: Facing; left: boolean } {
  if (to.y < from.y) return { facing: 'up', left: false };
  if (to.y > from.y) return { facing: 'down', left: false };
  return { facing: 'side', left: to.x < from.x };
}

function legMs(from: Point, to: Point): number {
  return (Math.abs(to.x - from.x) + Math.abs(to.y - from.y)) / SPEED * 1000;
}

function WalkerSprite(props: { walker: Walker; geo: Geometry; onDone: (walker: Walker) => void }): ReactNode {
  const { walker, geo, onDone } = props;
  const style = styleOf(walker.look);
  const dress = lookClasses(walker.tint, walker.look);
  const path = walker.phase === 'in' ? pathIn(walker.index, geo) : walker.phase === 'out' ? [...pathIn(walker.index, geo)].reverse() : [];
  const [leg, setLeg] = useState(0);
  const last = path.length - 1;

  useEffect(() => {
    if (walker.phase === 'seated') return;
    const from = path[Math.max(0, leg - 1)];
    const to = path[leg];
    // Leg 0 is the wait: at the door for an entrance, or a beat on your feet before leaving.
    const wait = leg === 0 ? (walker.phase === 'in' ? walker.delay + 60 : 450) : from && to ? legMs(from, to) : 0;
    const timer = window.setTimeout(() => (leg < last ? setLeg(leg + 1) : onDone(walker)), wait);
    return () => window.clearTimeout(timer);
    // The path is derived from the walker; the leg is the only clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leg, walker.phase, walker.gen]);

  if (walker.phase === 'seated') {
    const seat = seatPoint(walker.index, geo);
    return (
      <div className={`walker walker--seated ${dress}`} style={vars({ x: seat.x, y: seat.y, z: seat.y })}>
        <SeatedSprite pose={walker.pose} style={style} />
      </div>
    );
  }

  const here = path[leg] ?? path[0] ?? { x: 0, y: 0 };
  const before = path[Math.max(0, leg - 1)] ?? here;
  const moving = leg > 0;
  const { facing, left } = moving ? facingOf(before, here) : { facing: (walker.phase === 'in' ? 'up' : 'down') as Facing, left: false };
  return (
    <div
      className={`walker walker--${moving ? 'walking' : 'standing'}${left ? ' walker--left' : ''} ${dress}`}
      style={vars({ x: here.x, y: here.y, z: here.y, t: moving ? legMs(before, here) : 0 })}
    >
      {moving ? <WalkSprite facing={facing} style={style} /> : <StandSprite facing={facing} style={style} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The map: rooms packed into columns
// ---------------------------------------------------------------------------

export function OfficeMap(props: {
  units: UnitModel[];
  pins: Pins;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  showArchived: boolean;
  onToggleArchived: () => void;
}): ReactNode {
  const { units, pins, selection, onSelect } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    entranceShown = true;
  }, []);

  const archivedCount = units.filter((u) => u.archived).length;
  const shown = units.filter((u) => !u.archived || props.showArchived);
  const subsidiaries = shown.filter((u) => u.kind === 'subsidiary');

  // Columns of rooms, and desks per row, from the space available. Every room
  // has the same width in art pixels, so every room has the same pixel scale.
  const columns = width >= 1180 ? 3 : width >= 620 ? 2 : 1;
  const columnWidth = width > 0 ? (width - (columns - 1) * 16) / columns : 400;
  const cols = columnWidth < 360 ? 3 : 4;

  // Greedy packing: each room goes to the shortest column so far. Rooms are
  // all the same width, so height in art pixels is a fair comparison, and the
  // columns stay flush at the top with no ragged gaps between rooms.
  const stacks: UnitModel[][] = Array.from({ length: columns }, () => []);
  const heights = new Array<number>(columns).fill(0);
  const entranceBase = new Map<string, number>();
  let seen = 0;
  for (const unit of shown) {
    const target = heights.indexOf(Math.min(...heights));
    stacks[target]?.push(unit);
    heights[target] = (heights[target] ?? 0) + geometry(unit.stations.length, cols).h + 24;
    entranceBase.set(unit.id, seen);
    seen += unit.stations.filter((s) => s.occupant).length;
  }

  return (
    <div className="map" aria-label="Office map">
      <div className="map__rooms" ref={ref}>
        {stacks.map((stack, index) => (
          <div key={index} className="map__col">
            {stack.map((unit) => (
              <Room key={unit.id} unit={unit} cols={cols} pins={pins} selection={selection} onSelect={onSelect} entranceBase={entranceBase.get(unit.id) ?? 0} />
            ))}
          </div>
        ))}
      </div>
      {subsidiaries.length === 0 && (
        <p className="map__empty">
          {archivedCount > 0
            ? 'Every subsidiary in org.json is archived.'
            : 'No subsidiaries in org.json yet. Add one with org new-subsidiary and its room opens here.'}
        </p>
      )}
      {archivedCount > 0 && (
        <div className="map__foot">
          <button type="button" className="pill" aria-pressed={props.showArchived} onClick={props.onToggleArchived}>
            show archived
            <span className="pill__n">{archivedCount}</span>
          </button>
          <span className="map__foot-note">{props.showArchived ? 'boarded up, still inspectable' : 'hidden'}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A room
// ---------------------------------------------------------------------------

function Markers(props: { items: AttentionItem[] | undefined; only?: AttentionKind[]; except?: AttentionKind[] }): ReactNode {
  const items = (props.items ?? []).filter((item) => (!props.only || props.only.includes(item.kind)) && !(props.except ?? []).includes(item.kind));
  if (items.length === 0) return null;
  return (
    <>
      {kindSummary(items).map((entry) => (
        <Marker key={entry.kind} kind={entry.kind as MarkerKind} count={entry.count} urgent={entry.urgent} label={entry.label} />
      ))}
    </>
  );
}

const DOOR_KINDS: AttentionKind[] = ['session-errors', 'waiting-session', 'org-issue'];
const BOARD_KINDS: AttentionKind[] = ['inbox', 'proposal'];

function Room(props: {
  unit: UnitModel;
  cols: number;
  pins: Pins;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  entranceBase: number;
}): ReactNode {
  const { unit, cols, pins, selection, onSelect } = props;
  const [walkers, finished] = useCast(unit.id, occupantsOf(unit.stations), props.entranceBase);

  // Desks: the model's, plus any seat someone is still walking out of, plus
  // free hot desks to finish the last row.
  const needed = Math.max(unit.stations.length, ...walkers.map((w) => w.index + 1));
  const geo = geometry(needed, cols);
  const stations: StationModel[] = [...unit.stations];
  for (let index = stations.length; index < geo.count; index += 1) {
    if (unit.archived && unit.kind === 'subsidiary' && index >= needed) break;
    const seat = index - unit.depts.length;
    stations.push({ key: `h:${seat}`, index, kind: 'hot', dept: null, session: null, pose: 'empty', statusText: 'free hot desk', caption: 'free', plate: 'hot desk', tint: 'worker', look: 0, occupant: null });
  }

  // The monitor follows whoever is actually in the chair, so it lights up as they sit.
  const seated = new Map(walkers.filter((w) => w.phase === 'seated').map((w) => [w.index, w.pose]));

  const here = pins.get(`u:${unit.id}`);
  const subsidiary = unit.subsidiary;
  const charter = (here ?? []).some((item) => item.kind === 'charter');
  const drift = (here ?? []).some((item) => item.kind === 'drift');
  const missing = subsidiary ? !subsidiary.exists : false;
  const pending = subsidiary ? subsidiary.approvals.filter(isPending).length : 0;
  const notes = (here ?? []).filter((item) => BOARD_KINDS.includes(item.kind));
  const signSelected = selection?.kind === 'unit' && selection.unit === unit.id;
  const free = stations.filter((s) => s.kind === 'hot' && !s.session).length;

  const signLabel =
    `${unit.name}, ${unit.subtitle}.` +
    (unit.archived ? ' Archived and boarded up.' : '') +
    (missing ? ' Vault missing.' : '') +
    (unit.archived ? '' : ` ${plural(free, 'free hot desk')}.`) +
    markerWords(here) +
    ' Inspect room.';

  const classes = ['room', `fl-${unit.floor}`, `room--${unit.kind}`, unit.archived ? 'room--boarded' : '', charter ? 'room--charter' : ''].filter(Boolean).join(' ');

  return (
    <article className={classes} aria-label={`${unit.name} room`}>
      <div className="scene" style={vars({ 'room-w': geo.w, 'room-h': geo.h })}>
        <RoomArt unit={unit} geo={geo} stations={stations} seated={seated} notes={notes.length} charter={charter} />

        <div className="cast" aria-hidden="true">
          {walkers.map((walker) => (
            <WalkerSprite key={`${walker.id}:${walker.phase}:${walker.gen}`} walker={walker} geo={geo} onDone={finished} />
          ))}
        </div>

        <div className="scene__ui">
          <button
            type="button"
            className="room__sign at"
            style={vars({ x: geo.w / 2, y: 7 })}
            aria-pressed={signSelected}
            aria-label={signLabel}
            onClick={() => onSelect({ kind: 'unit', unit: unit.id })}
          >
            <span className="room__name">{unit.name}</span>
            <span className="room__sub">{unit.archived ? `archived${subsidiary?.archived ? ` ${subsidiary.archived}` : ''}` : unit.subtitle}</span>
            {missing && (
              <span className="room__crack" aria-hidden="true">
                <Marker kind="missing" label="Vault missing on disk" urgent />
              </span>
            )}
          </button>

          {notes.length > 0 && (
            <span className="room__board at" style={vars({ x: WALL + 30, y: 6 })}>
              <Markers items={notes} />
            </span>
          )}
          {(here ?? []).some((item) => item.kind === 'review-overdue') && (
            <span className="room__calendar at" style={vars({ x: geo.w - WALL - 50, y: 10 })}>
              <Markers items={here} only={['review-overdue']} />
            </span>
          )}
          {drift && (
            <span className="room__web at" style={vars({ x: geo.w - WALL - 14, y: 4 })}>
              <Markers items={here} only={['drift']} />
            </span>
          )}
          {charter && (
            <span className="room__tape at" style={vars({ x: geo.w / 2, y: BACK - 13 })}>
              <Markers items={here} only={['charter']} />
              <span className="room__tape-text">charter unfilled</span>
            </span>
          )}

          {stations.map((station) => (
            <Station key={station.key} unit={unit} station={station} cols={cols} pins={pins} selection={selection} onSelect={onSelect} />
          ))}

          <span
            className={`mailbox at${pending > 0 ? ' mailbox--full' : ''}`}
            style={vars({ x: WALL + CORRIDOR + 4, y: geo.h - 24 })}
            role="img"
            aria-label={pending > 0 ? `Mailbox: ${plural(pending, 'pending approval')}` : 'Mailbox: no approvals waiting'}
            title={pending > 0 ? plural(pending, 'pending approval') : 'No approvals waiting'}
          >
            <MailboxArt full={pending > 0} />
            {pending > 0 && (
              <span className="mailbox__n" aria-hidden="true">
                {pending}
              </span>
            )}
          </span>
          {(here ?? []).some((item) => DOOR_KINDS.includes(item.kind)) && (
            <span className="room__door at" style={vars({ x: WALL + CORRIDOR + 24, y: geo.h - 22 })} role="group" aria-label={`By the door:${markerWords((here ?? []).filter((i) => DOOR_KINDS.includes(i.kind)))}`}>
              <Markers items={here} only={DOOR_KINDS} />
            </span>
          )}
        </div>
      </div>
      <RoomNote unit={unit} />
    </article>
  );
}

function RoomNote(props: { unit: UnitModel }): ReactNode {
  const { unit } = props;
  if (unit.archived) return null;
  if (unit.kind === 'subsidiary' && unit.depts.length === 0) {
    return <p className="room__note">No departments in org.json. Add one with org new-department and a desk with its nameplate appears here.</p>;
  }
  if (unit.kind !== 'subsidiary' && unit.desks.length === 0) {
    return (
      <p className="room__note">
        {unit.kind === 'hq'
          ? 'Nobody at head office. A session started in the HQ vault walks in and takes a hot desk while it runs.'
          : `The workshop is empty. A session started in ${unit.name} walks in and takes a bench while it runs.`}
      </p>
    );
  }
  return null;
}

function Station(props: {
  unit: UnitModel;
  station: StationModel;
  cols: number;
  pins: Pins;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
}): ReactNode {
  const { unit, station, cols, pins, selection, onSelect } = props;
  const at = stationAt(station.index, cols);
  const box = vars({ x: at.x, y: at.y, w: CELL_W, h: 58 });
  const labels = (
    <span className="station__labels" aria-hidden="true">
      <span className="station__plate">{station.plate}</span>
      <span className={`station__status station__status--${station.pose}`}>{station.caption}</span>
    </span>
  );

  if (station.kind === 'dept' && station.dept && !unit.archived) {
    const dept = station.dept;
    const items = pins.get(`r:${unit.id}:${dept.id}`);
    const folderMissing = dept.org?.folderExists === false;
    const working = dept.activity?.lastTitle && (station.pose === 'active' || station.pose === 'waiting' || station.pose === 'idle');
    const label =
      `${dept.name} desk in ${unit.name}. Agent ${dept.agent}: ${station.statusText}.` +
      (working ? ` Working on ${dept.activity?.lastTitle}.` : '') +
      (folderMissing ? ' Department folder missing.' : '') +
      (dept.org === null ? ' Not listed in org.json.' : '') +
      markerWords(items);
    return (
      <button
        type="button"
        className={`station at at--box station--${station.pose}${dept.org === null ? ' station--unlisted' : ''}`}
        style={box}
        aria-pressed={selection?.kind === 'dept' && selection.unit === unit.id && selection.department === dept.id}
        aria-label={label}
        title={`${dept.name}: ${station.statusText}`}
        onClick={() => onSelect({ kind: 'dept', unit: unit.id, department: dept.id })}
      >
        <span className="station__pins" aria-hidden="true">
          {/* A waiting character already wears its own "!" bubble. */}
          <Markers items={items} except={station.pose === 'waiting' ? ['waiting-session'] : []} />
          {folderMissing && <Marker kind="missing" label="Department folder missing" urgent />}
        </span>
        {labels}
      </button>
    );
  }

  if (station.kind === 'hot' && station.session) {
    const session = station.session;
    const key = `${session.adapter}:${session.id}`;
    const items = pins.get(`d:${unit.id}:${key}`);
    return (
      <button
        type="button"
        className={`station at at--box station--hot station--${station.pose}`}
        style={box}
        aria-pressed={selection?.kind === 'desk' && selection.unit === unit.id && selection.session === key}
        aria-label={`Hot desk in ${unit.name}: ${session.title}. Status: ${station.statusText}.${markerWords(items)}`}
        title={`${session.title}: ${station.statusText}`}
        onClick={() => onSelect({ kind: 'desk', unit: unit.id, session: key })}
      >
        <span className="station__pins" aria-hidden="true">
          <Markers items={items} except={station.pose === 'waiting' ? ['waiting-session'] : []} />
        </span>
        {labels}
      </button>
    );
  }

  // A free hot desk, or a desk in a closed room: furniture, not a control.
  return (
    <span className={`station at at--box station--${station.kind === 'hot' ? 'free' : 'closed'}`} style={box} aria-hidden="true">
      {labels}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The room's art: floor, walls, door, desks and decor, in one SVG
// ---------------------------------------------------------------------------

function Rect(props: { x: number; y: number; w: number; h: number; c: string }): ReactNode {
  return <rect className={`px-${props.c}`} x={props.x} y={props.y} width={props.w} height={props.h} />;
}

function RoomArt(props: { unit: UnitModel; geo: Geometry; stations: StationModel[]; seated: Map<number, SeatedPose>; notes: number; charter: boolean }): ReactNode {
  const { unit, geo, stations, seated } = props;
  const id = useId().replace(/:/g, '');
  const { w, h } = geo;
  const windowX = w - WALL - 38;
  const boarded = unit.archived;

  return (
    <svg className="scene__art" viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      <defs>
        <pattern id={`${id}-floor`} width={16} height={16} patternUnits="userSpaceOnUse">
          <rect className="px-fa" width={16} height={16} />
          <rect className="px-fb" width={8} height={8} />
          <rect className="px-fb" x={8} y={8} width={8} height={8} />
          <rect className="px-fl" x={0} y={15} width={16} height={1} />
        </pattern>
        <pattern id={`${id}-tape`} width={8} height={6} patternUnits="userSpaceOnUse">
          <rect className="px-x" width={8} height={6} />
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <rect key={row} className="px-o" x={(row + 8 - 3) % 8} y={row} width={3} height={1} />
          ))}
          {/* The stripe wrapping round the tile's edge. */}
          {[1, 2].map((row) => (
            <rect key={`w${row}`} className="px-o" x={0} y={row} width={row} height={1} />
          ))}
        </pattern>
      </defs>

      {/* Floor, and the back wall seen face on. */}
      <rect x={0} y={0} width={w} height={h} fill={`url(#${id}-floor)`} />
      <Rect x={0} y={0} w={w} h={BACK} c="wall" />
      <Rect x={0} y={BACK - 15} w={w} h={13} c="wall-low" />
      <Rect x={0} y={BACK - 16} w={w} h={1} c="wall-trim" />
      <Rect x={0} y={BACK - 2} w={w} h={2} c="wall-trim" />
      <Rect x={0} y={BACK} w={w} h={2} c="shade" />

      {/* Notice board: one paper per note, up to four, cork when there are none. */}
      <Rect x={WALL + 3} y={9} w={40} h={22} c="L" />
      <Rect x={WALL + 4} y={10} w={38} h={20} c="y" />
      {Array.from({ length: Math.min(props.notes, 4) }, (_, index) => (
        <g key={index}>
          <Rect x={WALL + 7 + index * 9} y={13 + (index % 2) * 3} w={7} h={9} c="t" />
          <Rect x={WALL + 8 + index * 9} y={16 + (index % 2) * 3} w={5} h={1} c="T" />
          <Rect x={WALL + 8 + index * 9} y={18 + (index % 2) * 3} w={4} h={1} c="T" />
          <Rect x={WALL + 10 + index * 9} y={12 + (index % 2) * 3} w={1} h={2} c="R" />
        </g>
      ))}

      {/* A window with the sky in it: day, or night with stars. */}
      <Rect x={windowX} y={8} w={32} h={22} c="o" />
      <Rect x={windowX + 1} y={9} w={30} h={20} c="sky" />
      <Rect x={windowX + 4} y={12} w={1} h={1} c="star" />
      <Rect x={windowX + 22} y={11} w={1} h={1} c="star" />
      <Rect x={windowX + 12} y={20} w={1} h={1} c="star" />
      <Rect x={windowX + 26} y={23} w={1} h={1} c="star" />
      <Rect x={windowX + 15} y={9} w={2} h={20} c="wall-trim" />
      <Rect x={windowX + 1} y={18} w={30} h={2} c="wall-trim" />
      <Rect x={windowX - 1} y={29} w={34} h={2} c="L" />
      {boarded && (
        <>
          <Rect x={windowX - 2} y={12} w={36} h={3} c="D" />
          <Rect x={windowX - 2} y={22} w={36} h={3} c="D" />
        </>
      )}

      {props.charter && (
        <>
          <rect x={WALL} y={BACK - 13} width={w - 2 * WALL} height={6} fill={`url(#${id}-tape)`} />
          <Rect x={WALL} y={BACK - 14} w={w - 2 * WALL} h={1} c="o" />
          <Rect x={WALL} y={BACK - 7} w={w - 2 * WALL} h={1} c="o" />
        </>
      )}

      {/* Desks. */}
      {stations.map((station) => {
        const at = stationAt(station.index, geo.cols);
        const sitting = seated.get(station.index);
        const screen: Pose = station.pose === 'vacant' ? 'vacant' : (sitting ?? 'empty');
        return <StationArt key={station.key} x={at.x} y={at.y} screen={screen} occupied={sitting !== undefined} />;
      })}

      {/* Decor: a plant in the far corner, a water cooler by the front. */}
      <g className="plant">
        <Pixels grid={PLANT_LEAVES} x={w - WALL - 13} y={BACK + 1} className="plant__leaves" />
        <Pixels grid={PLANT_POT} x={w - WALL - 13} y={BACK + 8} />
      </g>
      {geo.rows > 1 && (
        <g className="plant plant--late">
          <Pixels grid={PLANT_LEAVES} x={w - WALL - 13} y={BACK + ROW_H + 10} className="plant__leaves" />
          <Pixels grid={PLANT_POT} x={w - WALL - 13} y={BACK + ROW_H + 17} />
        </g>
      )}
      <g className="cooler">
        <Pixels grid={COOLER} x={w - WALL - 13} y={h - 6 - 18} />
        <rect className="px-i cooler__bubble" x={w - WALL - 9} y={h - 6 - 13} width={1} height={1} />
      </g>

      {/* Side and front walls, seen from above, with the door in the front. */}
      <Rect x={0} y={0} w={WALL} h={h} c="wall-top" />
      <Rect x={w - WALL} y={0} w={WALL} h={h} c="wall-top" />
      <Rect x={0} y={0} w={w} h={5} c="wall-top" />
      <Rect x={WALL} y={5} w={w - 2 * WALL} h={1} c="wall-trim" />
      <Rect x={0} y={h - 6} w={WALL} h={6} c="wall-top" />
      <Rect x={WALL + CORRIDOR} y={h - 6} w={w - WALL - CORRIDOR} h={6} c="wall-top" />
      <Rect x={WALL + 3} y={h - 11} w={CORRIDOR - 6} h={5} c="rug" />
      <Rect x={WALL + 4} y={h - 10} w={CORRIDOR - 8} h={3} c="rug-edge" />
      <Rect x={WALL - 1} y={h - 8} w={2} h={8} c="wall-trim" />
      <Rect x={WALL + CORRIDOR - 1} y={h - 8} w={2} h={8} c="wall-trim" />
      {boarded && (
        <>
          <Rect x={WALL - 2} y={h - 9} w={CORRIDOR + 4} h={3} c="D" />
          <Rect x={WALL - 2} y={h - 4} w={CORRIDOR + 4} h={3} c="D" />
          <rect className="px-boarded" x={0} y={0} width={w} height={h} />
        </>
      )}
      <Rect x={0} y={0} w={w} h={1} c="o" />
      <Rect x={0} y={0} w={1} h={h} c="o" />
      <Rect x={w - 1} y={0} w={1} h={h} c="o" />
      <Rect x={0} y={h - 1} w={WALL} h={1} c="o" />
      <Rect x={WALL + CORRIDOR} y={h - 1} w={w - WALL - CORRIDOR} h={1} c="o" />
    </svg>
  );
}
