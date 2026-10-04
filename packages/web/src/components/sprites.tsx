import type { ReactElement, ReactNode } from 'react';

/*
 * The office's pixel art: hand-drawn grids in code, no image assets, nothing
 * fetched, no library.
 *
 * A sprite is an array of equal-length strings, one character per pixel. `.`
 * is transparent; every other character is a palette slot, rendered as an SVG
 * <rect> with the class `px-<char>`. office.css maps each class to a token
 * (`--px-*`, a skin or hair tone, or the wearer's department tint), so no
 * sprite sets a colour and the night theme is a stylesheet concern. Runs of
 * one colour on a row become one rect, and every SVG here renders with
 * `shape-rendering: crispEdges`.
 *
 * Sprites are decoration: each one is aria-hidden, and whatever renders it
 * says the same thing in words.
 *
 * Palette:
 *   o outline   e eye      s skin     h hair     r blush    w white
 *   c shirt     C shirt shade         p trousers f shoes
 *   k chair     K chair shade         d desk top D desk front L desk dark
 *   m CRT case  M CRT shade           n screen   g code     b keys
 *   t paper     T paper shade         u mug      l leaf     v leaf shade
 *   q pot       a water    i glow     G metal    R red      B mailbox
 *   x hazard    y cork     z sign ink
 */

export type Grid = readonly string[];

/** What a workstation shows. `empty` is a desk with nobody at it; `vacant` has no agent at all. */
export type Pose = 'active' | 'waiting' | 'idle' | 'empty' | 'vacant';
export type SeatedPose = 'active' | 'waiting' | 'idle';
export type Facing = 'up' | 'down' | 'side';

/** A small, stable hash so a character keeps its look across reloads. */
export function hashOf(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** A grid as rects, one per horizontal run of a colour. */
export function Pixels(props: { grid: Grid; x?: number; y?: number; className?: string }): ReactNode {
  const { grid, x = 0, y = 0 } = props;
  const rects: ReactElement[] = [];
  grid.forEach((row, ry) => {
    let start = 0;
    for (let rx = 1; rx <= row.length; rx += 1) {
      if (rx < row.length && row[rx] === row[start]) continue;
      const slot = row[start];
      if (slot !== '.' && slot !== undefined) {
        rects.push(<rect key={`${ry}-${start}`} className={`px-${slot}`} x={x + start} y={y + ry} width={rx - start} height={1} />);
      }
      start = rx;
    }
  });
  return props.className ? <g className={props.className}>{rects}</g> : <>{rects}</>;
}

/** Mirror a grid left to right. */
function mirror(grid: Grid): Grid {
  return grid.map((row) => [...row].reverse().join(''));
}

// ---------------------------------------------------------------------------
// Characters: 12 pixels wide. A head (8 rows) on a body (12 rows standing).
// Three hairstyles, three facings. Colour comes from classes on the wearer.
// ---------------------------------------------------------------------------

const HEADS: Record<Facing, readonly Grid[]> = {
  down: [
    ['...oooooo...', '..ohhhhhho..', '.ohhhhhhhho.', '.ohhhhhhhho.', '.ohssssssho.', '.osesssseso.', '.orssssssro.', '..osssssso..'],
    ['...oooooo...', '..ohhhhhho..', '.ohhhhhhhho.', '.ohhhhhhhho.', '.ohhsssshho.', '.ohesssseho.', '.ohrssssrho.', '.ohossssoho.'],
    ['..oooooooo..', '.ohhhhhhhho.', 'ohhhhhhhhhho', 'ohhhhhhhhhho', 'ohssssssssho', '.osesssseso.', '.orssssssro.', '..osssssso..'],
  ],
  up: [
    ['...oooooo...', '..ohhhhhho..', '.ohhhhhhhho.', '.ohhhhhhhho.', '.ohhhhhhhho.', '.ohhhhhhhho.', '.oshhhhhhso.', '..ohhhhhho..'],
    ['...oooooo...', '..ohhhhhho..', '.ohhhhhhhho.', '.ohhhhhhhho.', '.ohhhhhhhho.', '.ohhhhhhhho.', '.ohhhhhhhho.', '.ohhhhhhhho.'],
    ['..oooooooo..', '.ohhhhhhhho.', 'ohhhhhhhhhho', 'ohhhhhhhhhho', 'ohhhhhhhhhho', '.ohhhhhhhho.', '.oshhhhhhso.', '..ohhhhhho..'],
  ],
  side: [
    ['...oooooo...', '..ohhhhhho..', '.ohhhhhhhho.', '.ohhhhhhhho.', '.ohhhhsssso.', '.ohhsssseso.', '.ohsssssrso.', '..osssssso..'],
    ['...oooooo...', '..ohhhhhho..', '.ohhhhhhhho.', '.ohhhhhhhho.', '.ohhhhsssso.', '.ohhhssseso.', '.ohhhssssro.', '.ohhhosssso.'],
    ['..oooooooo..', '.ohhhhhhhho.', 'ohhhhhhhhhho', 'ohhhhhhhhhho', 'ohhhhhsssso.', '.ohhsssseso.', '.ohsssssrso.', '..osssssso..'],
  ],
};

function head(facing: Facing, style: number): Grid {
  const heads = HEADS[facing];
  return heads[style % heads.length] ?? heads[0] ?? [];
}

const TORSO_FRONT: Grid = ['..occwwcco..', '.occcccccco.', '.occcccccco.', '.oCccccccCo.', '.osCccccCso.', '..oppppppo..', '..oppppppo..'];
const TORSO_BACK: Grid = ['..occcccco..', '.occcccccco.', '.occcccccco.', '.oCccccccCo.', '.osCccccCso.', '..oppppppo..', '..oppppppo..'];
const TORSO_SIDE: Grid = ['...occcco...', '...occccco..', '...occccco..', '...oCCccco..', '...oCsccco..', '...oppppo...', '...oppppo...'];

const LEGS_STAND: Grid = ['..oppooppo..', '..oppooppo..', '..oppooppo..', '..offooffo..', '..ooo..ooo..'];
const LEGS_STEP_L: Grid = ['..oppooppo..', '..oppooffo..', '..oppo.ooo..', '..offo......', '..oooo......'];
const LEGS_STEP_R: Grid = mirror(LEGS_STEP_L);
const LEGS_SIDE_STAND: Grid = ['...oppppo...', '...oppppo...', '...oppppo...', '...offfffo..', '...ooooooo..'];
const LEGS_SIDE_STRIDE: Grid = ['..oppoppo...', '.oppo.oppo..', '.opo...opo..', 'offo...offo.', 'oooo...oooo.'];

/** The office chair from behind, as drawn at an empty desk and over a seated back. */
const CHAIR_BACK: Grid = [
  'oooooooooooo',
  'okkkkkkkkkko',
  'okKKKKKKKKko',
  'okKKKKKKKKko',
  'okKKKKKKKKko',
  'okkkkkkkkkko',
  'oooooooooooo',
  '.....oo.....',
  '..oooooooo..',
  '..o.o..o.o..',
];

function standing(facing: Facing, style: number, legs: Grid): Grid {
  const torso = facing === 'down' ? TORSO_FRONT : facing === 'up' ? TORSO_BACK : TORSO_SIDE;
  return [...head(facing, style), ...torso, ...legs];
}

/** Walk cycles, as frames laid side by side: four for front and back, two for the side. */
function walkFrames(facing: Facing, style: number): Grid[] {
  if (facing === 'side') return [standing('side', style, LEGS_SIDE_STRIDE), standing('side', style, LEGS_SIDE_STAND)];
  return [
    standing(facing, style, LEGS_STEP_L),
    standing(facing, style, LEGS_STAND),
    standing(facing, style, LEGS_STEP_R),
    standing(facing, style, LEGS_STAND),
  ];
}

const TYPING_TORSO: Grid = ['..occcccco..', 'socccccccco.', '.occcccccco.', '.oCccccccCos', '.occcccccco.', '.occcccccco.'];

/** Seated, 12 x 24: the back of a typist, a slumped sleeper, or someone turned round to face you. */
function seatedFrames(pose: SeatedPose, style: number): Grid[] {
  if (pose === 'active') {
    const frame = [...head('up', style), ...TYPING_TORSO, ...CHAIR_BACK];
    return [frame, mirror(frame)];
  }
  if (pose === 'idle') {
    const blank = '............';
    return [[blank, blank, ...head('up', style), '.occcccccco.', '.oCccccccCo.', '.oCccccccCo.', '.osCccccCso.', ...CHAIR_BACK]];
  }
  // Waiting: turned round in the chair, hands in lap, facing the viewer.
  return [
    [
      ...head('down', style),
      '..occwwcco..',
      'koccccccccok',
      'koccccccccok',
      'koCccccccCok',
      'kosCccccCsok',
      'kooppppppook',
      'oKoppppppoKo',
      'oKoppooppoKo',
      'oKoffooffoKo',
      'oooooooooooo',
      '.....oo.....',
      '..oooooooo..',
      '..o.o..o.o..',
      '............',
      '............',
      '............',
    ],
  ];
}

// Rendered sheets are cached: every character with the same hairstyle shares
// them, and colour comes from the wearer's classes.
const sheetCache = new Map<string, ReactNode>();

function sheet(key: string, frames: () => Grid[], width: number): ReactNode {
  const cached = sheetCache.get(key);
  if (cached) return cached;
  const made = frames().map((grid, index) => <Pixels key={index} grid={grid} x={index * width} />);
  sheetCache.set(key, made);
  return made;
}

/** A character walking: a strip of frames that CSS steps through. */
export function WalkSprite(props: { facing: Facing; style: number }): ReactNode {
  const count = props.facing === 'side' ? 2 : 4;
  return (
    <svg className={`spr-walk spr-walk--${count}`} viewBox="0 0 12 20" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      <g className="spr-sheet">{sheet(`walk-${props.facing}-${props.style % 3}`, () => walkFrames(props.facing, props.style), 12)}</g>
    </svg>
  );
}

/** A character standing still, for the beat between rising from a chair and walking off. */
export function StandSprite(props: { facing: Facing; style: number }): ReactNode {
  return (
    <svg className="spr-stand" viewBox="0 0 12 20" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      {sheet(`stand-${props.facing}-${props.style % 3}`, () => [standing(props.facing, props.style, props.facing === 'side' ? LEGS_SIDE_STAND : LEGS_STAND)], 12)}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Little glyphs: the "!" bubble, the drifting Z, the VACANT sign's letters
// ---------------------------------------------------------------------------

const BUBBLE: Grid = ['.ooooooo.', 'ottttttto', 'otttzttto', 'otttzttto', 'otttzttto', 'ottttttto', 'otttzttto', 'ottttttto', '.ootoooo.', '..oto....', '..oo.....'];
const ZED: Grid = ['zzzz', '..z.', '.z..', 'zzzz'];

/**
 * A seated character: typing, turned round with a "!" over its head, or slumped
 * asleep. The frame strip sits in its own 12 x 24 viewport so the bubble and
 * the Zs can float outside it without the next frame showing.
 */
export function SeatedSprite(props: { pose: SeatedPose; style: number }): ReactNode {
  const frames = props.pose === 'active' ? 2 : 1;
  return (
    <svg className={`spr-seat spr-seat--${props.pose}`} viewBox="-6 -12 24 36" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      <svg x={0} y={0} width={12} height={24} viewBox="0 0 12 24" overflow="hidden">
        <g className={frames > 1 ? 'spr-sheet spr-sheet--type' : 'spr-sheet'}>
          {sheet(`seat-${props.pose}-${props.style % 3}`, () => seatedFrames(props.pose, props.style), 12)}
        </g>
      </svg>
      {props.pose === 'waiting' && <Pixels grid={BUBBLE} x={6} y={-12} className="spr-bubble" />}
      {props.pose === 'idle' && (
        <g className="spr-zz">
          <Pixels grid={ZED} x={12} y={-9} className="spr-z spr-z--1" />
          <Pixels grid={ZED} x={12} y={-9} className="spr-z spr-z--2" />
        </g>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Kids: a sub-agent, drawn as a small character standing at its parent's desk.
// 8 pixels wide, 13 tall: a 6-row head on a 7-row body. Same palette slots as
// the grown-ups, so lookClasses dresses them the same way.
// ---------------------------------------------------------------------------

const KID_HEADS: Record<Facing, readonly Grid[]> = {
  down: [
    ['..oooo..', '.ohhhho.', 'ohhhhhho', 'ohssssho', 'osesseso', '.orssro.'],
    ['..oooo..', '.ohhhho.', 'ohhhhhho', 'ohhsshho', 'ohesseho', 'ohrssrho'],
    ['.o.oo.o.', 'ohohhoho', 'ohhhhhho', 'ohssssho', 'osesseso', '.orssro.'],
  ],
  up: [
    ['..oooo..', '.ohhhho.', 'ohhhhhho', 'ohhhhhho', 'ohhhhhho', '.ohhhho.'],
    ['..oooo..', '.ohhhho.', 'ohhhhhho', 'ohhhhhho', 'ohhhhhho', 'ohhhhhho'],
    ['.o.oo.o.', 'ohohhoho', 'ohhhhhho', 'ohhhhhho', 'oshhhhso', '.ohhhho.'],
  ],
  side: [
    ['..oooo..', '.ohhhho.', 'ohhhhhho', 'ohhhssso', 'ohhsseso', '.ohssso.'],
    ['..oooo..', '.ohhhho.', 'ohhhhhho', 'ohhhssso', 'ohhhseso', 'ohhossso'],
    ['.o.oo.o.', 'ohohhoho', 'ohhhhhho', 'ohhhssso', 'ohhsseso', '.ohssso.'],
  ],
};

function kidHead(facing: Facing, style: number): Grid {
  const heads = KID_HEADS[facing];
  return heads[style % heads.length] ?? heads[0] ?? [];
}

const KID_TORSO: Grid = ['.occcco.', 'occcccco', 'oCccccCo'];
const KID_TORSO_SIDE: Grid = ['..occo..', '..occco.', '..oCcco.'];
const KID_LEGS: Grid = ['.oppppo.', '.opoopo.', '.ofoofo.', '.oo..oo.'];
const KID_LEGS_STEP: Grid = ['.oppppo.', '.opoofo.', '.ofo.oo.', '.oo.....'];
const KID_LEGS_SIDE: Grid = ['..oppo..', '..oppo..', '..offfo.', '..ooooo.'];
const KID_LEGS_STRIDE: Grid = ['.oppppo.', 'opo..opo', 'ofo..ofo', 'oo....oo'];
/** Arms up at the desk, reaching for the keyboard; mirrored for the second frame. */
const KID_TORSO_REACH: Grid = ['socccco.', '.occccos', '.oCccCo.'];

function kidStanding(facing: Facing, style: number, legs: Grid): Grid {
  return [...kidHead(facing, style), ...(facing === 'side' ? KID_TORSO_SIDE : KID_TORSO), ...legs];
}

/** A two-frame walk for every facing: legs apart, then together (or the mirrored step). */
function kidWalkFrames(facing: Facing, style: number): Grid[] {
  if (facing === 'side') return [kidStanding('side', style, KID_LEGS_STRIDE), kidStanding('side', style, KID_LEGS_SIDE)];
  return [kidStanding(facing, style, KID_LEGS_STEP), kidStanding(facing, style, mirror(KID_LEGS_STEP))];
}

/** At the desk, 8 x 13: busy with its back to you, turned round to ask, or sat on the floor. */
function kidFrames(pose: SeatedPose, style: number): Grid[] {
  if (pose === 'active') {
    const frame = [...kidHead('up', style), ...KID_TORSO_REACH, ...KID_LEGS];
    return [frame, mirror(frame)];
  }
  if (pose === 'idle') {
    // Sat on the floor, knees up, facing you.
    const blank = '........';
    return [[blank, blank, blank, ...kidHead('down', style), 'occcccco', 'oCccccCo', 'offppffo', '.oooooo.']];
  }
  return [kidStanding('down', style, KID_LEGS)];
}

const KID_BUBBLE: Grid = ['ooooo', 'otzto', 'otzto', 'ottto', 'otzto', 'ooooo', '.oo..'];

/** A sub-agent at its parent's desk, in a 16 x 21 viewport with headroom for the "!" and the Zs. */
export function KidSprite(props: { pose: SeatedPose; style: number }): ReactNode {
  const frames = props.pose === 'active' ? 2 : 1;
  return (
    <svg className={`spr-kid spr-kid--${props.pose}`} viewBox="-4 -8 16 21" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      <svg x={0} y={0} width={8} height={13} viewBox="0 0 8 13" overflow="hidden">
        <g className={frames > 1 ? 'spr-sheet spr-sheet--kid' : 'spr-sheet'}>{sheet(`kid-${props.pose}-${props.style % 3}`, () => kidFrames(props.pose, props.style), 8)}</g>
      </svg>
      {props.pose === 'waiting' && <Pixels grid={KID_BUBBLE} x={5} y={-8} className="spr-bubble" />}
      {props.pose === 'idle' && (
        <g className="spr-zz">
          <Pixels grid={ZED} x={7} y={-3} className="spr-z spr-z--1" />
          <Pixels grid={ZED} x={7} y={-3} className="spr-z spr-z--2" />
        </g>
      )}
    </svg>
  );
}

/** A sub-agent walking to or from its parent's desk: a two-frame strip. */
export function KidWalkSprite(props: { facing: Facing; style: number }): ReactNode {
  return (
    <svg className="spr-walk spr-walk--kid" viewBox="0 0 8 13" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      <g className="spr-sheet">{sheet(`kidwalk-${props.facing}-${props.style % 3}`, () => kidWalkFrames(props.facing, props.style), 8)}</g>
    </svg>
  );
}

/** A sub-agent standing still, for the beat before it walks off. */
export function KidStandSprite(props: { facing: Facing; style: number }): ReactNode {
  return (
    <svg className="spr-stand" viewBox="0 0 8 13" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      {sheet(`kidstand-${props.facing}-${props.style % 3}`, () => [kidStanding(props.facing, props.style, props.facing === 'side' ? KID_LEGS_SIDE : KID_LEGS)], 8)}
    </svg>
  );
}

// 3x5 letters (N is four wide) for signs drawn in pixels rather than type.
const LETTERS: Record<string, Grid> = {
  V: ['z.z', 'z.z', 'z.z', 'z.z', '.z.'],
  A: ['.z.', 'z.z', 'zzz', 'z.z', 'z.z'],
  C: ['.zz', 'z..', 'z..', 'z..', '.zz'],
  N: ['z..z', 'zz.z', 'z.zz', 'z..z', 'z..z'],
  T: ['zzz', '.z.', '.z.', '.z.', '.z.'],
  '?': ['zz.', '..z', '.z.', '...', '.z.'],
  '!': ['z', 'z', 'z', '.', 'z'],
};

function PixelWord(props: { word: string; x: number; y: number }): ReactNode {
  let cursor = props.x;
  return (
    <>
      {[...props.word].map((letter, index) => {
        const grid = LETTERS[letter];
        if (!grid) return null;
        const at = cursor;
        cursor += (grid[0]?.length ?? 3) + 1;
        return <Pixels key={index} grid={grid} x={at} y={props.y} />;
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// A workstation: desk, CRT, keyboard and chair, 44 x 44, origin top-left.
// The seated character is drawn separately, over the chair, so it can walk.
// ---------------------------------------------------------------------------

export const STATION_W = 44;
export const STATION_H = 44;
/** Where a seated sprite's 12 x 24 box sits within a station. */
export const SEAT_X = 16;
export const SEAT_Y = 16;

function R(props: { x: number; y: number; w: number; h: number; c: string }): ReactNode {
  return <rect className={`px-${props.c}`} x={props.x} y={props.y} width={props.w} height={props.h} />;
}

const MUG: Grid = ['oooo.', 'ouuoo', 'ouuoo', 'oooo.'];
const PAPERS: Grid = ['ooooooo', 'ottttto', 'oTTTTTo', 'ottttto', 'ooooooo'];

/**
 * The furniture of one workstation. `screen` is what the CRT shows, which
 * follows whoever is actually sitting there; `occupied` hides the empty chair
 * because the seated sprite brings its own.
 */
export function StationArt(props: { x: number; y: number; screen: Pose; occupied: boolean }): ReactNode {
  const { x, y, screen } = props;
  if (screen === 'vacant') {
    // A dust sheet over desk and monitor, and a sign: nobody has been hired.
    return (
      <g className="st-art st-art--vacant" transform={`translate(${x} ${y})`}>
        <R x={3} y={33} w={38} h={2} c="shade" />
        <R x={2} y={26} w={40} h={7} c="D" />
        <R x={1} y={25} w={42} h={1} c="o" />
        <R x={1} y={26} w={1} h={7} c="o" />
        <R x={42} y={26} w={1} h={7} c="o" />
        <R x={1} y={33} w={42} h={1} c="o" />
        <R x={3} y={34} w={3} h={3} c="L" />
        <R x={38} y={34} w={3} h={3} c="L" />
        <Pixels
          x={1}
          y={2}
          grid={[
            '.............oooooooooo.....................',
            '...........ootttttttttoo....................',
            '..........otttttttttttTTo...................',
            '..........otttttttttttTTo...................',
            '..........ottttttttttttTo...................',
            '..........ottttttttttttTo...................',
            '..........ottttttttttttTo...................',
            '..........ottttttttttttTo...................',
            '..........ottttttttttttTo...................',
            '..........otttttttttttttTo..................',
            '.......ooootttttttttttttToooooo.............',
            '....oootttttttttttttttttttttttTooooo........',
            '..ootttttttttttttttttttttttttttttttTToo.....',
            '.otttttttttttttttttttttttttttttttttttTTo....',
            '.ottttttttttttttttttttttttttttttttttttTo....',
            '.oTtttttttttttttttttttttttttttttttttttTo....',
            '.oTTtttttTttttttttttTtttttttttttTtttTTTo....',
            '.oTTTTtTTTTTtTTTTtTTTTtTTTTTTtTTTTTTTTo.....',
            '..oooooooooooooooooooooooooooooooooooo......',
          ]}
        />
        <g className="st-sign">
          <R x={8} y={27} w={28} h={11} c="o" />
          <R x={9} y={28} w={26} h={9} c="t" />
          <PixelWord word="VACANT" x={10} y={30} />
        </g>
      </g>
    );
  }

  return (
    <g className={`st-art st-art--${screen}`} transform={`translate(${x} ${y})`}>
      <R x={3} y={33} w={38} h={2} c="shade" />
      {/* Desk: a top seen from above, a front face, two legs. */}
      <R x={1} y={15} w={42} h={19} c="o" />
      <R x={2} y={16} w={40} h={10} c="d" />
      <R x={2} y={26} w={40} h={1} c="L" />
      <R x={2} y={27} w={40} h={6} c="D" />
      <R x={30} y={29} w={8} h={2} c="L" />
      <R x={3} y={34} w={3} h={3} c="L" />
      <R x={38} y={34} w={3} h={3} c="L" />
      <Pixels grid={PAPERS} x={4} y={18} />
      <Pixels grid={MUG} x={34} y={18} />
      {screen === 'active' && <R x={35} y={16} w={1} h={1} c="steam" />}
      {/* Keyboard on the desk, in front of the monitor. */}
      <R x={15} y={22} w={14} h={3} c="o" />
      <R x={16} y={23} w={12} h={1} c="b" />
      {/* The CRT: a chunky case, a bezel and the screen. */}
      <R x={13} y={2} w={18} h={18} c="o" />
      <R x={14} y={3} w={16} h={16} c="m" />
      <R x={14} y={17} w={16} h={2} c="M" />
      <R x={15} y={4} w={14} h={11} c="M" />
      <rect className="px-n st-screen" x={16} y={5} width={12} height={9} />
      <R x={18} y={19} w={8} h={2} c="M" />
      <R x={26} y={16} w={2} h={1} c={screen === 'empty' ? 'M' : 'led'} />
      {screen === 'active' && (
        <g className="st-code">
          <R x={17} y={6} w={6} h={1} c="g" />
          <R x={18} y={8} w={8} h={1} c="g" />
          <R x={18} y={10} w={5} h={1} c="g" />
          <rect className="px-g st-cursor" x={24} y={10} width={2} height={2} />
        </g>
      )}
      {screen === 'waiting' && <PixelWord word="?" x={21} y={7} />}
      {screen === 'idle' && <R x={21} y={9} w={2} h={1} c="g" />}
      {screen === 'empty' && <R x={17} y={6} w={2} h={1} c="glint" />}
      {!props.occupied && <Pixels grid={CHAIR_BACK} x={SEAT_X} y={SEAT_Y + 14} />}
    </g>
  );
}

/** A workstation with its occupant, for the inspector: no walking, one frame. */
export function StationPortrait(props: { pose: Pose; tint: number | 'worker'; look: number; className?: string }): ReactNode {
  const seated = props.pose === 'active' || props.pose === 'waiting' || props.pose === 'idle';
  return (
    <svg
      className={['portrait', lookClasses(props.tint, props.look), props.className].filter(Boolean).join(' ')}
      viewBox="-4 -14 52 62"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="px-floor" x={-4} y={-14} width={52} height={62} />
      <StationArt x={0} y={0} screen={props.pose} occupied={seated} />
      {seated && (
        <g transform={`translate(${SEAT_X} ${SEAT_Y})`}>
          <g className={`spr-seat spr-seat--${props.pose}`}>
            <Pixels grid={seatedFrames(props.pose as SeatedPose, styleOf(props.look))[0] ?? []} />
            {props.pose === 'waiting' && <Pixels grid={BUBBLE} x={6} y={-12} className="spr-bubble" />}
            {props.pose === 'idle' && <Pixels grid={ZED} x={12} y={-9} className="spr-z" />}
          </g>
        </g>
      )}
    </svg>
  );
}

/** Hairstyle from a look hash. */
export function styleOf(look: number): number {
  return (look >> 5) % 3;
}

/** Classes that dress a character: department shirt, skin and hair, from a stable hash. */
export function lookClasses(tint: number | 'worker', look: number): string {
  const shirt = tint === 'worker' ? 'tint-worker' : `tint-${tint}`;
  return `${shirt} skin-${(look % 4) + 1} hair-${((look >> 2) % 5) + 1}`;
}

// ---------------------------------------------------------------------------
// Decor
// ---------------------------------------------------------------------------

export const PLANT_LEAVES: Grid = [
  '....vv....',
  '..vvllv.v.',
  '.vllllvvlv',
  'vlllvlllv.',
  '.vllvllllv',
  '..vlllvlv.',
  '...vllv...',
];
export const PLANT_POT: Grid = ['..oooooo..', '..oqqqqo..', '..oqqqqo..', '...oqqo...', '...oooo...'];

export const COOLER: Grid = [
  '..oooooo..',
  '.oaaaaaao.',
  '.oaiaaaao.',
  '.oaaaaaao.',
  '.oaaaaaao.',
  '..oaaaao..',
  '...oooo...',
  '.oooooooo.',
  '.owwwwwwo.',
  '.owRwwawo.',
  '.owwwwwwo.',
  '.oGGGGGGo.',
  '.owwwwwwo.',
  '.owwwwwwo.',
  '.owwwwwwo.',
  '.oooooooo.',
];

/** A mailbox on a post. The flag is up when there is mail: a shape, not a colour. */
export function MailboxArt(props: { full: boolean }): ReactNode {
  return (
    <svg className="mailbox__art" viewBox="0 0 14 16" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      <Pixels
        grid={[
          '.oooooooo.....',
          'oBBBBBBBBo....',
          'oBBBBBBBBo....',
          'oBoooooBBo....',
          'oBBBBBBBBo....',
          'oBBBBBBBBo....',
          'oooooooooo....',
          '....oLLo......',
          '....oLLo......',
          '....oLLo......',
          '....oLLo......',
          '....oLLo......',
          '....oLLo......',
          '...oooooo.....',
        ]}
      />
      {props.full ? (
        <Pixels grid={['ooo.', 'oRRo', 'oRRo', 'oGo.', 'oGo.', 'oGo.', 'ooo.']} x={9} y={0} />
      ) : (
        <Pixels grid={['....', '....', '....', 'oooo', 'oGRo', 'oooo']} x={9} y={2} />
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Markers: what an attention item looks like where it happened, 12 x 12
// ---------------------------------------------------------------------------

export type MarkerKind =
  | 'approval'
  | 'waiting-session'
  | 'session-errors'
  | 'drift'
  | 'inbox'
  | 'proposal'
  | 'charter'
  | 'review-overdue'
  | 'org-issue'
  | 'missing';

const MARKER_ART: Record<MarkerKind, Grid> = {
  // A letter with a wax seal: something to sign.
  approval: [
    '............',
    '............',
    'oooooooooooo',
    'oottttttttoo',
    'otottttttoto',
    'ottottttotto',
    'otttoRRottto',
    'ottttRRtttto',
    'otttttttttto',
    'oooooooooooo',
    '............',
    '............',
  ],
  // A speech bubble with a "!": an agent is waiting on a reply.
  'waiting-session': [
    '.oooooooooo.',
    'otttttttttto',
    'otttttztttto',
    'otttttztttto',
    'otttttztttto',
    'otttttttttto',
    'otttttztttto',
    'otttttttttto',
    '.ootooooooo.',
    '..oto.......',
    '..oo........',
    '............',
  ],
  // A rain cloud with a spark: something went wrong in a run.
  'session-errors': [
    '....oooo....',
    '..oouuuuoo..',
    '.ouuuuuuuuo.',
    'ouuuuuuuuuuo',
    'ouuuuuuuuuuo',
    '.oooooooooo.',
    '.....RR.....',
    '....RR......',
    '...RRRR.....',
    '.....RR.....',
    '....RR......',
    '............',
  ],
  // A cobweb in the corner: the structure has been left untended.
  drift: [
    'wwwwwwwwwwww',
    'ww...w....w.',
    'w.w..w...w..',
    'w..wwwwww...',
    'w..ww..w....',
    'wwww.w.w....',
    'w..w..ww....',
    'w..w..w.....',
    'w.w..w......',
    'w.w.w.......',
    'ww.w........',
    'w...........',
  ],
  // A note pinned up: something unfiled.
  inbox: [
    '.....RR.....',
    '..ooRRRRoo..',
    '..ottRRtto..',
    '..otttttto..',
    '..ozzzzzto..',
    '..otttttto..',
    '..ozzzzzzo..',
    '..otttttto..',
    '..ozzzztto..',
    '..otttttto..',
    '..oooooooo..',
    '............',
  ],
  // A sticky with a lightbulb: an idea waiting for a decision.
  proposal: [
    '.....RR.....',
    '.ooooRRoooo.',
    '.oxxxxxxxxo.',
    '.oxxxooxxxo.',
    '.oxxoiioxxo.',
    '.oxxoiioxxo.',
    '.oxxxooxxxo.',
    '.oxxxooxxxo.',
    '.oxxxxxxxxo.',
    '.oooooooooo.',
    '............',
    '............',
  ],
  // An A-frame "under construction" board.
  charter: [
    '............',
    'oooooooooooo',
    'oxxzzxxzzxxo',
    'oxzzxxzzxxzo',
    'ozzxxzzxxzzo',
    'oooooooooooo',
    '..oL....Lo..',
    '..oL....Lo..',
    '.oL......Lo.',
    '.oL......Lo.',
    'oL........Lo',
    'oo........oo',
  ],
  // A calendar page.
  'review-overdue': [
    '..o..o..o...',
    '.ooooooooooo',
    '.oRRRRRRRRRo',
    '.oRRRRRRRRRo',
    '.ooooooooooo',
    '.ottttttttto',
    '.otzztzzttto',
    '.ottttttttto',
    '.otzztzztzzo',
    '.ottttttttto',
    '.ooooooooooo',
    '............',
  ],
  // A crack: a folder or vault that should exist does not.
  missing: [
    '.....oo.....',
    '....oo......',
    '....o.......',
    '.....oo.....',
    '......oo....',
    '.....oo.....',
    '....oo......',
    '....o.......',
    '.....o......',
    '.....oo.....',
    '......o.....',
    '......o.....',
  ],
  'org-issue': [
    '.....oo.....',
    '....oxxo....',
    '....oxxo....',
    '...oxzzxo...',
    '...oxzzxo...',
    '..oxxzzxxo..',
    '..oxxzzxxo..',
    '.oxxxxxxxxo.',
    '.oxxxzzxxxo.',
    'oxxxxzzxxxxo',
    'oooooooooooo',
    '............',
  ],
};

/**
 * A marker with its meaning in words: `role="img"` with an aria-label, and the
 * same text as a tooltip. A count appears as a tag when there is more than one.
 */
export function Marker(props: { kind: MarkerKind; label: string; count?: number; urgent?: boolean }): ReactNode {
  const count = props.count ?? 1;
  return (
    <span className={`mk mk--${props.kind}${props.urgent ? ' mk--urgent' : ''}`} role="img" aria-label={props.label} title={props.label}>
      <svg viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
        <Pixels grid={MARKER_ART[props.kind]} />
      </svg>
      {count > 1 && <span className="mk__n">{count}</span>}
    </span>
  );
}
