import type { ConfigSurface, Issue, IssueLevel } from './types.ts';
import type { AdapterRegistry } from './registry.ts';
import type { PebbleStore } from './store/index.ts';
import { PRICING_AS_OF } from './pricing.ts';

export interface Check {
  id: string;
  level: IssueLevel | 'ok';
  title: string;
  detail: string;
  /** Issues rolled up under this check, when there are many of one kind. */
  items?: Issue[];
}

export interface DoctorReport {
  ranAt: string;
  checks: Check[];
  counts: { ok: number; info: number; warn: number; error: number };
}

/** A price table this old should be looked at before anyone quotes from it. */
const PRICING_STALE_DAYS = 120;

/**
 * Deterministic health check — no model calls, no network.
 *
 * Everything here is answerable from the filesystem, which is the point: a check
 * that needs a model to run is a check you stop trusting.
 */
export async function runDoctor(
  registry: AdapterRegistry,
  store: PebbleStore,
  surfaces: ConfigSurface[],
): Promise<DoctorReport> {
  const checks: Check[] = [];

  // --- runtime ------------------------------------------------------------
  const major = Number(process.versions.node.split('.')[0] ?? 0);
  checks.push({
    id: 'runtime.node',
    level: major >= 22 ? 'ok' : 'error',
    title: `Node ${process.versions.node}`,
    detail:
      major >= 22
        ? 'Meets the requirement (22.5+ for the built-in SQLite module).'
        : 'Pebble needs Node 22.5 or newer for node:sqlite.',
  });

  // --- adapters -----------------------------------------------------------
  for (const adapter of registry.all()) {
    const presence = await adapter.detect();
    checks.push({
      id: `adapter.${adapter.id}`,
      level: presence.installed ? 'ok' : 'warn',
      title: `${adapter.label}${presence.version ? ` ${presence.version}` : ''}`,
      detail: presence.evidence,
    });
  }

  // --- index --------------------------------------------------------------
  const stats = store.stats();
  const lastIndexed = stats.lastIndexedAt ? Date.parse(stats.lastIndexedAt) : null;
  const indexAgeMin = lastIndexed ? Math.round((Date.now() - lastIndexed) / 60_000) : null;
  checks.push({
    id: 'index.freshness',
    level: stats.sessions === 0 ? 'warn' : indexAgeMin !== null && indexAgeMin > 60 ? 'info' : 'ok',
    title: `${stats.sessions} sessions indexed across ${stats.projects} projects`,
    detail:
      stats.sessions === 0
        ? 'Nothing indexed yet. Run `pebble index` or start `pebble serve`.'
        : `Last pass ${indexAgeMin === null ? 'unknown' : indexAgeMin === 0 ? 'just now' : `${indexAgeMin} min ago`}.`,
  });

  // --- cost confidence ----------------------------------------------------
  const pricingAgeDays = Math.round((Date.now() - Date.parse(PRICING_AS_OF)) / 86_400_000);
  checks.push({
    id: 'cost.pricing-table',
    level: pricingAgeDays > PRICING_STALE_DAYS ? 'warn' : 'ok',
    title: `Price table checked ${PRICING_AS_OF} (${pricingAgeDays} days ago)`,
    detail:
      pricingAgeDays > PRICING_STALE_DAYS
        ? 'Old enough that a model may have been repriced since. Figures Pebble computes itself are suspect until it is refreshed; figures Claude Code reported are unaffected.'
        : 'Recent enough to trust for computed figures.',
  });

  const disputed = store
    .listSessions({ limit: 2000 })
    .filter((s) => s.cost.conflict !== undefined || s.cost.basis === 'partial');
  checks.push({
    id: 'cost.disagreements',
    level: disputed.length === 0 ? 'ok' : 'warn',
    title:
      disputed.length === 0
        ? 'No cost disagreements'
        : `${disputed.length} session${disputed.length === 1 ? '' : 's'} where cost is disputed or incomplete`,
    detail:
      disputed.length === 0
        ? "Claude Code's reported costs and Pebble's own calculation agree everywhere they are both available."
        : 'Pebble shows the reported figure and keeps both. Usually it means the price table is missing a model.',
    items: disputed.slice(0, 20).map((s) => ({
      level: 'warn' as const,
      code: 'cost.disagreement',
      message: s.cost.conflict
        ? `${s.title} — reported $${s.cost.conflict.reportedUsd.toFixed(4)}, computed $${s.cost.conflict.computedUsd.toFixed(4)}`
        : `${s.title} — unpriced model${s.cost.unpricedModels.length === 1 ? '' : 's'}: ${s.cost.unpricedModels.join(', ')}`,
      path: s.transcriptPath,
    })),
  });

  // --- config surfaces ----------------------------------------------------
  for (const surface of surfaces) {
    const all = [...surface.issues, ...surface.items.flatMap((item) => item.issues)];
    const byCode = new Map<string, Issue[]>();
    for (const issue of all) byCode.set(issue.code, [...(byCode.get(issue.code) ?? []), issue]);

    if (byCode.size === 0) {
      checks.push({
        id: `config.${surface.adapter}`,
        level: 'ok',
        title: `${surface.items.length} config items, nothing wrong`,
        detail: `Scanned ${surface.root} and every project Claude Code knows about.`,
      });
      continue;
    }

    for (const [code, issues] of [...byCode.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const worst = issues.reduce<IssueLevel>(
        (acc, i) => (i.level === 'error' ? 'error' : acc === 'error' ? acc : i.level === 'warn' ? 'warn' : acc),
        'info',
      );
      checks.push({
        id: `config.${surface.adapter}.${code}`,
        level: worst,
        title: `${issues.length}x ${code}`,
        detail: issues[0]?.message ?? '',
        // Carry the path into the message: twelve copies of the same sentence
        // tell you nothing, twelve paths tell you exactly what to go look at.
        items: issues.slice(0, 25).map((issue) => ({
          ...issue,
          message: issue.path ? issue.path : issue.message,
        })),
      });
    }

    if (surface.shadowed.length > 0) {
      checks.push({
        id: `config.${surface.adapter}.shadowed`,
        level: 'info',
        title: `${surface.shadowed.length} definition${surface.shadowed.length === 1 ? '' : 's'} defined at more than one scope`,
        detail: 'Expected when a project overrides a global. Listed so an unintended override is visible.',
        items: surface.shadowed.map((s) => ({
          level: 'info' as const,
          code: 'config.shadowed',
          message: `${s.kind} "${s.name}": ${s.winner} wins over ${s.shadowed.join(', ')}`,
        })),
      });
    }
  }

  const counts = { ok: 0, info: 0, warn: 0, error: 0 };
  for (const check of checks) counts[check.level] += 1;

  return { ranAt: new Date().toISOString(), checks, counts };
}
