import { resolve, sep } from 'node:path';

import type { OrgPlacement, OrgSnapshot, SessionSummary } from '../types.ts';

export interface PlacementHints {
  title?: string;
  titleSource?: SessionSummary['titleSource'];
  /**
   * Agent types of the session's sub-agent runs, newest first. The first one
   * that names a department agent of the unit attributes the session to it.
   */
  subagentTypes?: Array<string | null>;
}

type Candidate = { path: string; scope: OrgPlacement['scope']; unit: string; exact?: boolean };

function normalize(path: string): string {
  const resolved = resolve(path);
  return resolved.length > 1 && resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved;
}

/** True when `path` is `base` or lies beneath it on a segment boundary. */
export function isWithin(path: string, base: string): boolean {
  if (path === base) return true;
  const prefix = base.endsWith(sep) ? base : base + sep;
  return path.startsWith(prefix);
}

function candidates(org: OrgSnapshot): Candidate[] {
  const list: Candidate[] = [
    // The root itself is HQ's desk — but only exactly; a stray repo beside the
    // vaults is not HQ's work.
    { path: normalize(org.root), scope: 'hq', unit: 'hq', exact: true },
    { path: normalize(org.hq.path), scope: 'hq', unit: 'hq' },
  ];
  for (const sub of org.subsidiaries) list.push({ path: normalize(sub.path), scope: 'subsidiary', unit: sub.id });
  for (const tool of org.tooling) list.push({ path: normalize(tool.path), scope: 'tooling', unit: tool.id });
  return list;
}

/**
 * Where a session sits in the org, by its working directory.
 *
 * Longest prefix wins, matched on whole path segments — `/x/consulting-old`
 * is not inside `/x/consulting`. The department is attributed only on
 * evidence: the session ran as a department's agent, or spawned one.
 */
export function placeSession(projectPath: string, org: OrgSnapshot, hints: PlacementHints = {}): OrgPlacement {
  const path = normalize(projectPath || '/');
  let best: Candidate | null = null;
  for (const c of candidates(org)) {
    const match = c.exact ? path === c.path : isWithin(path, c.path);
    if (match && (!best || c.path.length > best.path.length)) best = c;
  }
  if (!best) return { scope: 'outside', unit: null, department: null };

  let department: string | null = null;
  if (best.scope === 'subsidiary') {
    const sub = org.subsidiaries.find((s) => s.id === best.unit);
    const byAgent = new Map((sub?.departments ?? []).map((d) => [d.agent, d.id]));
    if (hints.titleSource === 'agent' && hints.title && byAgent.has(hints.title)) {
      department = byAgent.get(hints.title) ?? null;
    } else {
      for (const type of hints.subagentTypes ?? []) {
        if (type && byAgent.has(type)) {
          department = byAgent.get(type) ?? null;
          break;
        }
      }
    }
  }
  return { scope: best.scope, unit: best.unit, department };
}
