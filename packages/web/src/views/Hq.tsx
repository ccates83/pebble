import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { AttentionItem, ChangelogEntry, HqOverview, IssueLevel, OrgDepartment, OrgNote, OrgSnapshot } from '@pebble/core';
import { api } from '../lib/api.ts';
import { useAsync, useClock, useSort } from '../lib/hooks.ts';
import { dueLabel, duration, obsidianHref, relativeTime, relativeTo } from '../lib/format.ts';
import { Badge, CostFigure, Empty, FilterPills, Meter, Money, Note, Section, StatusDot } from '../components/ui.tsx';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { Marker, StationPortrait, hashOf, type MarkerKind } from '../components/sprites.tsx';
import { OfficeMap } from './HqMap.tsx';
import {
  DESK_POSE,
  KIND_WORDS,
  LEVEL_RANK,
  buildFloor,
  isArchived,
  isPending,
  isTime,
  locate,
  pinItems,
  plural,
  sameSelection,
  sessionHref,
  sessionKey,
  type DeptModel,
  type Pins,
  type PlacedSession,
  type Selection,
  type UnitModel,
} from './hqModel.ts';

/*
 * HQ as an office floor, drawn in 16-bit pixel art.
 *
 * One room per unit: the head office, the tooling workshop and each
 * subsidiary. A subsidiary's departments have workstations with nameplates;
 * live sessions without a department take hot desks. When the data shows an
 * agent at work, its character walks in at the door and sits down; when the
 * run ends, it walks out. Attention items are drawn where they happened.
 *
 * Everything on the map comes from /api/hq. A desk with nobody at it is empty,
 * not a sleeping placeholder; a room with nobody in it says so.
 */

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

  const units = useMemo(() => buildFloor(data, org), [data, org]);
  const pins = useMemo(() => pinItems(data.attention, units), [data.attention, units]);

  // A selection that points at something no longer on the map (an archived
  // room just hidden, a session that ended) closes rather than going blank.
  const visible = selection ? units.find((u) => u.id === selection.unit) : undefined;
  const live = selection && visible && (!visible.archived || showArchived) ? selection : null;

  const select = (next: Selection | null): void => {
    setSelection((current) => (sameSelection(current, next) ? null : next));
  };

  const reveal = (next: Selection): void => {
    const unit = units.find((u) => u.id === next.unit);
    if (unit?.archived) setShowArchived(true);
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
        <OfficeMap
          units={units}
          pins={pins}
          selection={live}
          onSelect={select}
          showArchived={showArchived}
          onToggleArchived={() => setShowArchived((v) => !v)}
        />
      </div>

      <div className="floor__side">
        <div className="floor__inspector" ref={inspectorRef}>
          {live ? (
            <Inspector selection={live} units={units} data={data} org={org} pins={pins} now={now} onClose={() => setSelection(null)} />
          ) : (
            <p className="inspector-hint">Click a desk, a character or a room's sign to look closer.</p>
          )}
        </div>
        <NoticeBoard data={data} units={units} selection={live} onReveal={reveal} now={now} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspector: inline, beside the map (or below it on a phone)
// ---------------------------------------------------------------------------

function Inspector(props: {
  selection: Selection;
  units: UnitModel[];
  data: HqOverview;
  org: OrgSnapshot;
  pins: Pins;
  now: number;
  onClose: () => void;
}): ReactNode {
  const { selection, units } = props;
  const unit = units.find((u) => u.id === selection.unit);
  if (!unit) return null;

  let body: ReactNode = null;
  let title = unit.name;
  let kicker = unit.archived ? `${unit.subtitle} · boarded up` : unit.subtitle;
  if (selection.kind === 'dept') {
    const dept = unit.depts.find((d) => d.id === selection.department);
    if (!dept) return null;
    title = dept.name;
    kicker = `${unit.name} · workstation`;
    body = <DeptInspector unit={unit} dept={dept} items={props.pins.get(`r:${unit.id}:${dept.id}`)} org={props.org} now={props.now} />;
  } else if (selection.kind === 'desk') {
    const session = unit.desks.find((s) => sessionKey(s) === selection.session);
    if (!session) return null;
    title = session.title;
    kicker = `${unit.name} · hot desk`;
    body = <DeskInspector session={session} items={props.pins.get(`d:${unit.id}:${selection.session}`)} now={props.now} />;
  } else {
    body = <UnitInspector unit={unit} data={props.data} org={props.org} items={props.pins.get(`u:${unit.id}`)} now={props.now} />;
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

function DeptInspector(props: {
  unit: UnitModel;
  dept: DeptModel;
  items: AttentionItem[] | undefined;
  org: OrgSnapshot;
  now: number;
}): ReactNode {
  const { unit, dept: room, org, now } = props;
  const activity = room.activity;
  const fill = kpiFill(room.org?.scorecard ?? null);
  const charter = unit.subsidiary?.charter ?? null;

  return (
    <>
      <div className="ins-portrait">
        <StationPortrait pose={room.pose} tint={room.tint} look={hashOf(`${unit.id}/${room.id}`)} className="ins-portrait__scene" />
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
        <StationPortrait pose={DESK_POSE[session.status].pose} tint="worker" look={hashOf(sessionKey(session))} className="ins-portrait__scene" />
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

function UnitInspector(props: {
  unit: UnitModel;
  data: HqOverview;
  org: OrgSnapshot;
  items: AttentionItem[] | undefined;
  now: number;
}): ReactNode {
  const { unit: building, org, now } = props;
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
        <Block label="Desks">
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
        <Block label="On the notice board">
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
  units: UnitModel[];
  selection: Selection | null;
  onReveal: (selection: Selection) => void;
  now: number;
}): ReactNode {
  const { data, units, now } = props;
  const [showInfo, setShowInfo] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const root = data.org?.root ?? '';

  const urgent = data.attention.filter((item) => LEVEL_RANK[item.level] > 0);
  const notes = data.attention.length - urgent.length;
  // Notes are worth seeing, not worth crowding out an approval: folded by default.
  const listed = showInfo ? data.attention : urgent;
  const shown = showAll ? listed : listed.slice(0, BOARD_CAP);

  const where = (item: AttentionItem): string => {
    const unit = units.find((u) => u.id === item.unit);
    if (!unit) return 'org-wide';
    const dept = item.department ? unit.depts.find((d) => d.id === item.department) : undefined;
    return dept ? `${unit.name} · ${dept.name}` : item.department ? `${unit.name} · ${item.department}` : unit.name;
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
            const { selection } = locate(item, units);
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
