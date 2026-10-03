import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type {
  ApprovalRequest,
  ChangelogEntry,
  HqVault,
  Issue,
  OrgDepartment,
  OrgSnapshot,
  ScorecardKpi,
  Subsidiary,
} from '../types.ts';
import {
  dateMs,
  fmNumber,
  fmString,
  isDir,
  isFile,
  newestFirst,
  readNote,
  readNotesIn,
  readText,
  rel,
  resolveIn,
} from './fs.ts';

/**
 * The org reader: `org.json` plus the vault conventions under the org root.
 *
 * Strictly read-only, like the rest of Pebble. It never throws — a missing
 * vault, a malformed org.json or a half-written note all become `Issue`s on the
 * snapshot — because the HQ view has to render whatever state the org is in,
 * including a broken one.
 */

export const ORG_FILE = 'org.json';

/** Changelog lines kept per unit. The view shows a handful; this is headroom. */
export const CHANGELOG_CAP = 30;
/** HQ decisions kept, newest first. */
export const DECISIONS_CAP = 10;

/** The callout a fresh charter carries until Connor writes it. */
const CHARTER_UNFILLED_MARKER = 'Connor to fill in';

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asText = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------

/**
 * `- YYYY-MM-DD — actor — what`. The separators are em dashes by convention,
 * but a person typing in a hurry writes `--` or `-`, so those count too. The
 * separator needs whitespace either side so a hyphenated actor (`pebble-core`)
 * is not split.
 */
const CHANGELOG_LINE = /^\s*[-*]\s+(\d{4}-\d{2}-\d{2})\s+(?:—|–|--|-)\s+(.+?)\s+(?:—|–|--|-)\s+(.+?)\s*$/;

export function parseChangelog(text: string, unit: string, cap = CHANGELOG_CAP): ChangelogEntry[] {
  const entries: Array<ChangelogEntry & { order: number }> = [];
  text.split(/\r?\n/).forEach((line, order) => {
    const match = CHANGELOG_LINE.exec(line);
    if (!match) return;
    entries.push({ date: match[1] ?? '', actor: match[2] ?? '', text: match[3] ?? '', unit, order });
  });
  // Written newest first by convention; sorted anyway so an out-of-place line
  // cannot push the latest entry past the cap. File order breaks ties.
  return entries
    .sort((a, b) => b.date.localeCompare(a.date) || a.order - b.order)
    .slice(0, cap)
    .map(({ order: _order, ...entry }) => entry);
}

async function readChangelog(vault: string, unit: string, issues: Issue[]): Promise<ChangelogEntry[]> {
  const text = await readText(join(vault, '07 System', 'Logs', 'CHANGELOG.md'), issues);
  return text === null ? [] : parseChangelog(text, unit);
}

// ---------------------------------------------------------------------------
// Scorecards
// ---------------------------------------------------------------------------

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

/**
 * Reads the first markdown table whose header starts with `KPI`. Columns are
 * matched by header name, not position, so a reordered or extended table still
 * reads; values stay verbatim strings because they are provisional by rule.
 */
export function parseScorecard(text: string): ScorecardKpi[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*\|\s*KPI\s*\|/i.test(line));
  if (start === -1) return [];
  const header = splitRow(lines[start] ?? '').map((h) => h.toLowerCase());
  const col = (...names: string[]): number => header.findIndex((h) => names.some((n) => h.startsWith(n)));
  const idx = {
    name: 0,
    target: col('target'),
    baseline: col('baseline'),
    redIf: col('red if', 'red'),
    latest: col('latest'),
    source: col('source'),
    verified: col('verified'),
  };
  const kpis: ScorecardKpi[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.trim().startsWith('|')) break;
    if (/^\s*\|[\s:|-]+\|?\s*$/.test(line)) continue; // the |---|---| separator
    const cells = splitRow(line);
    const cell = (at: number): string | null => (at >= 0 && (cells[at] ?? '') !== '' ? (cells[at] as string) : null);
    const name = cell(idx.name);
    if (!name) continue;
    kpis.push({
      name,
      target: cell(idx.target),
      baseline: cell(idx.baseline),
      redIf: cell(idx.redIf),
      latest: cell(idx.latest),
      source: cell(idx.source),
      verified: cell(idx.verified),
    });
  }
  return kpis;
}

// ---------------------------------------------------------------------------
// Vault pieces
// ---------------------------------------------------------------------------

async function readInbox(root: string, vault: string, issues: Issue[]) {
  return (await readNotesIn(root, join(vault, '00 Inbox'), issues)).sort(newestFirst).map((n) => n.note);
}

async function readProposals(root: string, vault: string, issues: Issue[]) {
  return (await readNotesIn(root, join(vault, '06 Self Improvements'), issues))
    .filter((n) => (n.note.status ?? '').toLowerCase() === 'proposed')
    .sort(newestFirst)
    .map((n) => n.note);
}

async function readApprovals(root: string, vault: string, issues: Issue[]): Promise<ApprovalRequest[]> {
  const notes = await readNotesIn(root, join(vault, '07 System', 'Approvals'), issues);
  return notes.sort(newestFirst).map(({ note, fm }) => {
    const tier = fmNumber(fm, 'tier');
    return {
      ...note,
      department: fmString(fm, 'department'),
      requestedBy: fmString(fm, 'requested_by'),
      tier: tier === null ? null : Math.trunc(tier),
      action: fmString(fm, 'action'),
      amountUsd: fmNumber(fm, 'amount_usd'),
      due: fmString(fm, 'due'),
      created: fmString(fm, 'created'),
      decided: fmString(fm, 'decided'),
    };
  });
}

/**
 * The newest weekly review. "Newest" is by `created`, falling back to the name
 * (`2026-W40 Weekly Review` sorts) and then mtime — `updated` is not used,
 * because touching an old review must not make it count as this week's.
 */
async function readLastReview(root: string, vault: string, issues: Issue[]) {
  const reviews = await readNotesIn(root, join(vault, '08 Reviews'), issues, (name) => /Weekly Review\.md$/i.test(name));
  if (reviews.length === 0) return null;
  reviews.sort((a, b) => {
    const ka = dateMs(a.note.created) || a.mtimeMs;
    const kb = dateMs(b.note.created) || b.mtimeMs;
    return kb - ka || b.note.path.localeCompare(a.note.path);
  });
  return reviews[0]?.note ?? null;
}

async function readCharter(root: string, vault: string, issues: Issue[]): Promise<Subsidiary['charter']> {
  const read = await readNote(root, join(vault, 'Charter.md'), issues);
  if (!read) return null;
  return { ...read.note, filled: !read.body.includes(CHARTER_UNFILLED_MARKER) };
}

async function definedAgents(vault: string): Promise<Set<string>> {
  try {
    const entries = await readdir(join(vault, '.claude', 'agents'));
    return new Set(entries.filter((name) => name.endsWith('.md')).map((name) => name.replace(/\.md$/, '')));
  } catch {
    return new Set();
  }
}

async function readDepartment(
  root: string,
  vault: string,
  raw: Json,
  agents: Set<string>,
  subsidiaryId: string,
  issues: Issue[],
): Promise<OrgDepartment | null> {
  const id = asText(raw.id);
  const name = asText(raw.name) ?? id;
  if (!id || !name) {
    issues.push({
      level: 'warn',
      code: 'org.department-malformed',
      message: `A department of "${subsidiaryId}" in org.json has no id or name; skipped.`,
    });
    return null;
  }
  const path = resolveIn(root, raw.path) ?? join(vault, '01 Departments', name);
  const agent = asText(raw.agent) ?? id;
  const folderExists = await isDir(path);

  let scorecard: OrgDepartment['scorecard'] = null;
  // The scorecard is named after the folder; fall back to the display name in
  // case the two ever diverge.
  for (const candidate of new Set([`${basename(path)} Scorecard.md`, `${name} Scorecard.md`])) {
    const file = join(path, candidate);
    const text = folderExists ? await readText(file, issues) : null;
    if (text !== null) {
      scorecard = { path: file, kpis: parseScorecard(text) };
      break;
    }
  }

  return { id, name, path, agent, folderExists, agentDefined: agents.has(agent), scorecard };
}

/**
 * The same structural checks as `org status` in HQ's `org` script, so the
 * dashboard and the terminal never disagree about what is broken. One
 * deliberate difference: a missing vault reports only "vault missing", because
 * every other check would fail as a consequence of it.
 */
function driftFor(sub: Omit<Subsidiary, 'drift'>, synced: boolean): Issue[] {
  if (!sub.exists) {
    return [{ level: 'warn', code: 'org.vault-missing', message: 'vault missing', path: sub.path }];
  }
  const drift: Issue[] = [];
  for (const d of sub.departments) {
    if (!d.agentDefined) {
      drift.push({
        level: 'warn',
        code: 'org.agent-missing',
        message: `no agent for ${d.name}`,
        path: join(sub.path, '.claude', 'agents', `${d.agent}.md`),
      });
    }
    if (!d.folderExists) {
      drift.push({ level: 'warn', code: 'org.department-folder-missing', message: `no folder for ${d.name}`, path: d.path });
    }
  }
  if (!synced) {
    drift.push({ level: 'warn', code: 'org.hq-never-synced', message: '_HQ never synced', path: join(sub.path, '_HQ') });
  }
  return drift;
}

async function readSubsidiary(root: string, raw: unknown, index: number, issues: Issue[]): Promise<Subsidiary | null> {
  const obj = asObject(raw);
  const id = obj ? asText(obj.id) : null;
  if (!obj || !id) {
    issues.push({ level: 'warn', code: 'org.subsidiary-malformed', message: `Subsidiary #${index + 1} in org.json has no id; skipped.` });
    return null;
  }
  const path = resolveIn(root, obj.vault) ?? resolveIn(root, obj.path);
  if (!path) {
    issues.push({ level: 'warn', code: 'org.subsidiary-malformed', message: `Subsidiary "${id}" in org.json has no path; skipped.` });
    return null;
  }
  const exists = await isDir(path);
  const unitIssues: Issue[] = [];
  const agents = exists ? await definedAgents(path) : new Set<string>();

  const departments: OrgDepartment[] = [];
  for (const rawDept of asArray(obj.departments)) {
    const deptObj = asObject(rawDept);
    if (!deptObj) {
      unitIssues.push({ level: 'warn', code: 'org.department-malformed', message: `A department of "${id}" in org.json is not an object; skipped.` });
      continue;
    }
    const dept = await readDepartment(root, path, deptObj, agents, id, unitIssues);
    if (dept) departments.push(dept);
  }

  const base: Omit<Subsidiary, 'drift'> = {
    id,
    name: asText(obj.name) ?? id,
    type: asText(obj.type) ?? 'other',
    status: asText(obj.status) ?? 'unknown',
    path,
    exists,
    created: asText(obj.created),
    archived: asText(obj.archived),
    departments,
    charter: exists ? await readCharter(root, path, unitIssues) : null,
    approvals: exists ? await readApprovals(root, path, unitIssues) : [],
    inbox: exists ? await readInbox(root, path, unitIssues) : [],
    proposals: exists ? await readProposals(root, path, unitIssues) : [],
    lastReview: exists ? await readLastReview(root, path, unitIssues) : null,
    changelog: exists ? await readChangelog(path, id, unitIssues) : [],
  };
  const synced = exists && (await isFile(join(path, '_HQ', 'SYNCED.md')));
  issues.push(...unitIssues);
  return { ...base, drift: driftFor(base, synced) };
}

async function readHq(root: string, path: string, issues: Issue[]): Promise<HqVault> {
  const exists = await isDir(path);
  if (!exists) {
    issues.push({ level: 'warn', code: 'org.hq-missing', message: `HQ vault not found at ${rel(root, path)}.`, path });
    return { path, exists, inbox: [], proposals: [], decisions: [], changelog: [] };
  }
  const decisions = (await readNotesIn(root, join(path, '05 Decisions'), issues))
    .sort(newestFirst)
    .slice(0, DECISIONS_CAP)
    .map((n) => n.note);
  return {
    path,
    exists,
    inbox: await readInbox(root, path, issues),
    proposals: await readProposals(root, path, issues),
    decisions,
    changelog: await readChangelog(path, 'hq', issues),
  };
}

/**
 * Reads the whole org under `root`. Always resolves: a missing or malformed
 * org.json yields a snapshot with no subsidiaries and an `error` issue saying
 * why. Use `loadOrg` when "no org.json at all" should mean "no snapshot".
 */
export async function readOrg(root: string): Promise<OrgSnapshot> {
  const orgFile = join(root, ORG_FILE);
  const issues: Issue[] = [];
  const readAt = new Date().toISOString();

  let parsed: Json | null = null;
  const text = await readText(orgFile, issues, 'org.file-unreadable');
  if (text === null) {
    if (!issues.some((i) => i.path === orgFile)) {
      issues.push({ level: 'error', code: 'org.file-missing', message: `No ${ORG_FILE} at ${root}.`, path: orgFile });
    }
  } else {
    try {
      parsed = asObject(JSON.parse(text));
      if (!parsed) {
        issues.push({ level: 'error', code: 'org.file-malformed', message: `${ORG_FILE} is not a JSON object.`, path: orgFile });
      }
    } catch (error) {
      issues.push({
        level: 'error',
        code: 'org.file-malformed',
        message: `${ORG_FILE} is not valid JSON: ${(error as Error).message}`,
        path: orgFile,
      });
    }
  }

  const holding = asObject(parsed?.holding);
  // Even with a broken org.json, HQ is conventionally `HQ/` — read it so the
  // view still has something to show beside the error.
  const hqPath = resolveIn(root, holding?.hq) ?? join(root, 'HQ');
  const hq = await readHq(root, hqPath, issues);

  const subsidiaries: Subsidiary[] = [];
  if (parsed && parsed.subsidiaries !== undefined && !Array.isArray(parsed.subsidiaries)) {
    issues.push({ level: 'error', code: 'org.file-malformed', message: '`subsidiaries` in org.json is not a list.', path: orgFile });
  }
  const rawSubs = asArray(parsed?.subsidiaries);
  for (let i = 0; i < rawSubs.length; i += 1) {
    try {
      const sub = await readSubsidiary(root, rawSubs[i], i, issues);
      if (sub) subsidiaries.push(sub);
    } catch (error) {
      // Belt and braces: one bad subsidiary must not take the others with it.
      issues.push({ level: 'error', code: 'org.subsidiary-failed', message: `Subsidiary #${i + 1}: ${(error as Error).message}` });
    }
  }

  const tooling: OrgSnapshot['tooling'] = [];
  for (const rawTool of asArray(parsed?.tooling)) {
    const obj = asObject(rawTool);
    const id = obj ? asText(obj.id) : null;
    const path = obj ? resolveIn(root, obj.path) : null;
    if (!obj || !id || !path) {
      issues.push({ level: 'info', code: 'org.tooling-malformed', message: 'A tooling entry in org.json has no id or path; skipped.' });
      continue;
    }
    tooling.push({ id, path, role: asText(obj.role) });
  }

  return {
    root,
    orgFile,
    name: asText(holding?.name),
    updated: asText(parsed?.updated),
    hq,
    subsidiaries,
    tooling,
    issues,
    readAt,
  };
}

/** Org root resolution, mirrored on `HqOverview.orgRootSource`. */
export type OrgRootSource = 'flag' | 'env' | 'discovered' | 'default';

export interface OrgLoad {
  root: string;
  source: OrgRootSource;
  /** Null when there is no org.json at `root`. */
  org: OrgSnapshot | null;
  /** Why `org` is null. */
  reason: string | null;
}

/** Reads the org if there is one, distinguishing "no org here" from "a broken org". */
export async function loadOrg(resolution: { root: string; source: OrgRootSource }): Promise<OrgLoad> {
  const orgFile = join(resolution.root, ORG_FILE);
  let present = false;
  try {
    present = (await stat(orgFile)).isFile();
  } catch {
    present = false;
  }
  if (!present) {
    const how =
      resolution.source === 'flag'
        ? 'the --org path'
        : resolution.source === 'env'
          ? 'PEBBLE_ORG_ROOT'
          : resolution.source === 'discovered'
            ? 'the working directory'
            : 'the default location';
    return {
      ...resolution,
      org: null,
      reason: `No ${ORG_FILE} found at ${resolution.root} (from ${how}). Pass --org <dir> or set PEBBLE_ORG_ROOT.`,
    };
  }
  return { ...resolution, org: await readOrg(resolution.root), reason: null };
}
