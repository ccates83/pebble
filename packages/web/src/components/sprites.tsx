import type { ReactNode } from 'react';

/*
 * The office map's sprites: hand-drawn inline SVG, no image assets, no library.
 *
 * No sprite sets a colour. Every shape carries a class, and office.css maps the
 * class to a token — so the night theme, the department tints and the reduced-
 * motion poses all live in the stylesheet. Sprites are decoration: each one is
 * aria-hidden, and whatever renders it must say the same thing in words.
 */

/** What a desk shows. `empty` is a desk with nobody at it; `vacant` has no agent at all. */
export type Pose = 'active' | 'waiting' | 'idle' | 'empty' | 'vacant';

/** A small, stable hash so a character keeps its look across reloads. */
export function hashOf(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function Hair(props: { variant: number }): ReactNode {
  const cap = <path className="spr-hair" d="M30.6 26.5c-.6-6.4 3.6-10.6 9.4-10.6s10 4.2 9.4 10.6c-2.4-2.6-5.6-3.9-9.4-3.9s-7 1.3-9.4 3.9z" />;
  switch (props.variant % 4) {
    case 1:
      return (
        <>
          {cap}
          <circle className="spr-hair" cx="40" cy="15.2" r="3.6" />
        </>
      );
    case 2:
      return (
        <>
          {cap}
          <rect className="spr-hair" x="29.6" y="23" width="3.4" height="10" rx="1.7" />
          <rect className="spr-hair" x="47" y="23" width="3.4" height="10" rx="1.7" />
        </>
      );
    case 3:
      return <path className="spr-hair" d="M30.4 27c-1.2-7 3.4-11.4 9.6-11.4 6 0 10.6 4.2 9.6 10.6-1.6-1.4-3.2-2.2-5-2.6-.6 1.2-2 2-4.2 2-2.6 0-5-1-6.4-2.6-1.6.8-2.8 2.2-3.6 4z" />;
    default:
      return cap;
  }
}

function Character(props: { pose: 'active' | 'waiting' | 'idle'; look: number }): ReactNode {
  const { pose, look } = props;
  return (
    <g className="spr-who">
      <g className="spr-body">
        <rect className="spr-shirt" x="29.5" y="33" width="21" height="16" rx="7.5" />
        <path className="spr-collar" d="M36.5 33.4l3.5 3.4 3.5-3.4z" />
      </g>
      <g className="spr-head">
        <circle className="spr-skin" cx="40" cy="26" r="8.6" />
        <Hair variant={look >> 3} />
        {pose === 'idle' ? (
          <path className="spr-lid" d="M35 27.6q1.5 1.2 3 0M42 27.6q1.5 1.2 3 0" />
        ) : (
          <>
            <circle className="spr-eye" cx="36.6" cy="27.2" r="1.15" />
            <circle className="spr-eye" cx="43.4" cy="27.2" r="1.15" />
          </>
        )}
        <circle className="spr-cheek" cx="34.4" cy="30" r="1.6" />
        <circle className="spr-cheek" cx="45.6" cy="30" r="1.6" />
        {pose === 'waiting' && <ellipse className="spr-eye" cx="40" cy="31.4" rx="0.9" ry="1.1" />}
      </g>
      {pose === 'idle' ? (
        <rect className="spr-shirt spr-arm" x="31.5" y="41.2" width="17" height="4.4" rx="2.2" />
      ) : (
        <>
          <g className="spr-arm-l">
            <rect className="spr-shirt spr-arm" x="30.5" y="40.6" width="7" height="4.4" rx="2.2" />
            <circle className="spr-skin" cx="37.4" cy="43" r="1.8" />
          </g>
          <g className="spr-arm-r">
            <rect className="spr-shirt spr-arm" x="42.5" y="40.6" width="7" height="4.4" rx="2.2" />
            <circle className="spr-skin" cx="42.6" cy="43" r="1.8" />
          </g>
        </>
      )}
    </g>
  );
}

/**
 * One desk and whoever sits at it.
 *
 * `tint` picks the shirt (a department's colour, or the generic worker's), and
 * `look` varies skin, hair colour and hairstyle so a row of desks is a row of
 * people rather than one clone. Neither carries meaning.
 */
export function DeskScene(props: { pose: Pose; tint: number | 'worker'; look: number; className?: string }): ReactNode {
  const { pose, look } = props;
  const tint = props.tint === 'worker' ? 'tint-worker' : `tint-${props.tint}`;
  const classes = ['spr', `spr--${pose}`, tint, `skin-${(look % 4) + 1}`, `hair-${((look >> 2) % 5) + 1}`, props.className]
    .filter(Boolean)
    .join(' ');

  if (pose === 'vacant') {
    return (
      <svg className={classes} viewBox="0 0 80 60" aria-hidden="true" focusable="false">
        <ellipse className="spr-shadow" cx="40" cy="56.5" rx="30" ry="2.6" />
        <rect className="spr-box" x="8" y="40" width="16" height="14" rx="1.5" />
        <rect className="spr-box spr-box--top" x="11" y="29" width="12" height="11" rx="1.5" />
        <path className="spr-tape" d="M16 40v14M17 29v11" />
        <path className="spr-string" d="M33 4l-4 16M47 4l4 16" />
        <rect className="spr-sign" x="23" y="18" width="34" height="14" rx="3" />
        <text className="spr-sign-text" x="40" y="27.8" textAnchor="middle">
          VACANT
        </text>
        <circle className="spr-dust" cx="62" cy="53" r="2.2" />
        <circle className="spr-dust" cx="66" cy="54" r="1.4" />
      </svg>
    );
  }

  const seated = pose === 'active' || pose === 'waiting' || pose === 'idle';
  return (
    <svg className={classes} viewBox="0 0 80 60" aria-hidden="true" focusable="false">
      <ellipse className="spr-shadow" cx="40" cy="56.5" rx="31" ry="2.6" />
      {/* Chair back, behind whoever sits in it. Pushed in when nobody does. */}
      <rect className="spr-chair" x="29" y={seated ? 28 : 33} width="22" height="18" rx="5" />
      <rect className="spr-chair-shade" x="32" y={seated ? 30 : 35} width="16" height="3" rx="1.5" />
      {seated && <Character pose={pose} look={look} />}

      {/* Monitor on the left of the desk. */}
      <rect className="spr-metal" x="18.6" y="39" width="2.8" height="6" />
      <rect className="spr-monitor" x="11" y="29" width="18" height="12" rx="2.2" />
      <rect className="spr-screen" x="12.6" y="30.6" width="14.8" height="8.8" rx="1.2" />
      {pose === 'active' && (
        <g className="spr-code">
          <rect className="spr-code-line" x="14" y="32.2" width="8" height="1.4" rx="0.7" />
          <rect className="spr-code-line spr-code-line--2" x="15.6" y="34.6" width="9" height="1.4" rx="0.7" />
          <rect className="spr-code-line spr-code-line--3" x="14" y="37" width="6" height="1.4" rx="0.7" />
        </g>
      )}
      {pose === 'waiting' && <text className="spr-screen-q" x="20" y="38" textAnchor="middle">?</text>}

      {/* Desk. */}
      <rect className="spr-desk-top" x="7" y="44.5" width="66" height="4.6" rx="2" />
      <rect className="spr-desk" x="10" y="49" width="60" height="7" rx="1.5" />
      <rect className="spr-desk-drawer" x="51" y="50.6" width="15" height="3.6" rx="1" />

      {/* Mug and plant on the right. */}
      <rect className="spr-mug" x="55" y="38.6" width="6" height="6" rx="1.2" />
      <path className="spr-mug-handle" d="M61 40.2h1.2a1.6 1.6 0 010 3.2H61" />
      {pose === 'active' && <path className="spr-steam" d="M57 36.6q-1-1.4 0-2.8t0-2.8M59.4 36.6q-1-1.4 0-2.8t0-2.8" />}
      <rect className="spr-pot" x="64" y="39.4" width="7" height="5.2" rx="1.2" />
      <ellipse className="spr-leaf" cx="65.6" cy="36.4" rx="2.2" ry="3.6" />
      <ellipse className="spr-leaf spr-leaf--2" cx="69.4" cy="35.6" rx="2.2" ry="4" />

      {pose === 'waiting' && (
        <g className="spr-bubble">
          <path className="spr-bubble-bg" d="M52 3h13a4 4 0 014 4v8a4 4 0 01-4 4h-7l-4 4v-4h-2a4 4 0 01-4-4V7a4 4 0 014-4z" />
          <text className="spr-bubble-text" x="58.5" y="15.6" textAnchor="middle">
            !
          </text>
        </g>
      )}
      {pose === 'idle' && (
        <g className="spr-zz">
          <text className="spr-z spr-z--1" x="50" y="18">
            z
          </text>
          <text className="spr-z spr-z--2" x="56" y="11">
            z
          </text>
        </g>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Markers: what an attention item looks like where it happened
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

function MarkerArt(props: { kind: MarkerKind }): ReactNode {
  switch (props.kind) {
    case 'approval':
      // A letter with a wax seal: something to sign.
      return (
        <>
          <rect className="mk-paper" x="2.5" y="6" width="19" height="13" rx="2" />
          <path className="mk-line" d="M3 7l9 6.5L21 7" />
          <circle className="mk-seal" cx="12" cy="13.6" r="2.6" />
        </>
      );
    case 'waiting-session':
      return (
        <>
          <path className="mk-bubble" d="M5 3h14a3 3 0 013 3v8a3 3 0 01-3 3h-7l-4 4v-4H5a3 3 0 01-3-3V6a3 3 0 013-3z" />
          <text className="mk-glyph" x="12" y="14.6" textAnchor="middle">
            !
          </text>
        </>
      );
    case 'session-errors':
      // A little rain cloud with a spark: something went wrong in a run.
      return (
        <>
          <path className="mk-cloud" d="M6.5 15a4 4 0 01-.4-8 5.5 5.5 0 0110.6-1.2A4.2 4.2 0 0117.5 15z" />
          <path className="mk-bolt" d="M12.5 13.5l-2.5 4h3l-2 4.5" />
        </>
      );
    case 'drift':
      // A cobweb in the corner: the structure has been left untended.
      return (
        <>
          <path className="mk-web" d="M2 2l20 20M2 2l9 20M2 2l20 9M2 2v20M2 2h20" />
          <path className="mk-web" d="M2 8q3.5.5 6-6M2 14q7 1 12-12M2 20q10 1.5 18-18" />
        </>
      );
    case 'inbox':
      // A note pinned to the door.
      return (
        <>
          <rect className="mk-note" x="5" y="4" width="14" height="17" rx="1.2" transform="rotate(-6 12 12)" />
          <path className="mk-line" d="M8 10.5h8M8 13.5h8M8 16.5h5" transform="rotate(-6 12 12)" />
          <circle className="mk-pin" cx="12" cy="5" r="1.8" />
        </>
      );
    case 'proposal':
      // A pinned sticky with a lightbulb: an idea waiting for a decision.
      return (
        <>
          <rect className="mk-sticky" x="4.5" y="4" width="15" height="16" rx="1.2" transform="rotate(5 12 12)" />
          <circle className="mk-bulb" cx="12" cy="11.4" r="3.4" />
          <rect className="mk-line-fill" x="10.4" y="14.6" width="3.2" height="2.4" rx="0.6" />
          <circle className="mk-pin" cx="12" cy="5" r="1.8" />
        </>
      );
    case 'charter':
      // An A-frame "under construction" board.
      return (
        <>
          <path className="mk-leg" d="M6 22L9.5 9M18 22L14.5 9" />
          <rect className="mk-hazard" x="3" y="6" width="18" height="8" rx="1.2" />
          <path className="mk-stripe" d="M6 6l-3 5M11 6l-5 8M16 6l-5 8M21 6l-5 8M21 11l-2 3" />
        </>
      );
    case 'review-overdue':
      // A calendar page.
      return (
        <>
          <rect className="mk-paper" x="3.5" y="5" width="17" height="16" rx="2" />
          <rect className="mk-cal-top" x="3.5" y="5" width="17" height="5" rx="2" />
          <path className="mk-line" d="M8 3v4M16 3v4M7.5 14h3M13.5 14h3M7.5 17.5h3" />
        </>
      );
    case 'missing':
      // A crack in the wall: a folder or vault that should exist does not.
      return <path className="mk-crack" d="M12 2l-2 5 4 3-3 4 3 3-2 5" />;
    default:
      return (
        <>
          <path className="mk-bubble" d="M12 3l10 17H2z" />
          <text className="mk-glyph" x="12" y="18" textAnchor="middle">
            !
          </text>
        </>
      );
  }
}

/**
 * A marker with its meaning in words: `role="img"` with an aria-label, and the
 * same text as a tooltip. A count appears as a tag when there is more than one.
 */
export function Marker(props: { kind: MarkerKind; label: string; count?: number; urgent?: boolean }): ReactNode {
  const count = props.count ?? 1;
  return (
    <span
      className={`mk mk--${props.kind}${props.urgent ? ' mk--urgent' : ''}`}
      role="img"
      aria-label={props.label}
      title={props.label}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <MarkerArt kind={props.kind} />
      </svg>
      {count > 1 && <span className="mk__n">{count}</span>}
    </span>
  );
}
