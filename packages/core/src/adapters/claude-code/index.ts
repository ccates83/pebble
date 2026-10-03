import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  AdapterPresence,
  AgentAdapter,
  ConfigSurface,
  IndexedSession,
  ListSessionsOptions,
  SessionDetail,
  SessionSource,
  SessionSummary,
} from '../../types.ts';
import { mapLimit } from '../../util.ts';
import { claudeRoot, projectsDir } from './paths.ts';
import { scanClaudeConfig, type ScanConfigOptions } from './config.ts';
import { findSubagentFiles, rollupSubagents } from './subagents.ts';
import { ADAPTER_ID, parseTranscript } from './transcript.ts';

/** Transcripts parsed at once. Enough to be quick, few enough to be polite. */
const PARSE_CONCURRENCY = 8;

interface TranscriptFile {
  path: string;
  projectDirName: string;
  sessionId: string;
  mtimeMs: number;
  bytes: number;
  subagentCount: number;
}

async function findTranscripts(root = claudeRoot()): Promise<TranscriptFile[]> {
  const dir = projectsDir(root);
  let projectDirs: string[];
  try {
    projectDirs = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const found: TranscriptFile[] = [];
  await mapLimit(projectDirs, PARSE_CONCURRENCY, async (projectDirName) => {
    const projectPath = join(dir, projectDirName);
    let entries;
    try {
      entries = await readdir(projectPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const path = join(projectPath, entry.name);
      try {
        const info = await stat(path);
        // A session is stale when its own file OR any of its sub-agent files has
        // changed, so the signature covers both. Without this, a sub-agent that
        // keeps working after its parent went quiet would never be re-read.
        const subagents = await findSubagentFiles(path);
        const mtimeMs = subagents.reduce((max, s) => Math.max(max, s.mtimeMs), info.mtimeMs);
        const bytes = subagents.reduce((sum, s) => sum + s.bytes, info.size);
        found.push({
          path,
          projectDirName,
          sessionId: entry.name.replace(/\.jsonl$/, ''),
          mtimeMs,
          bytes,
          subagentCount: subagents.length,
        });
      } catch {
        // Vanished between readdir and stat. Nothing to report.
      }
    }
  });

  // Newest first: that is the order every view wants, and it makes `limit` mean
  // "the most recent N" rather than an arbitrary N.
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Folds a session's sub-agent transcripts into its summary — as separate
 * figures, never merged into the parent's own cost.
 */
async function withSubagents(
  summary: SessionSummary,
  file: { path: string; subagentCount?: number },
): Promise<SessionSummary> {
  if (file.subagentCount === 0) return summary;
  const rollup = await rollupSubagents(file.path, summary.id);
  if (rollup.count === 0) return summary;
  return {
    ...summary,
    subagentCount: rollup.count,
    subagentTokens: rollup.tokens,
    subagentCost: rollup.cost,
  };
}

/**
 * Claude Code, read from the transcripts and config it leaves on disk.
 *
 * Nothing here writes to `~/.claude`, spawns the CLI, or talks to the network.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = ADAPTER_ID;
  readonly label = 'Claude Code';
  readonly kind = 'cli' as const;

  async detect(): Promise<AdapterPresence> {
    const root = claudeRoot();
    try {
      const info = await stat(root);
      if (!info.isDirectory()) {
        return { installed: false, evidence: `${root} exists but is not a directory.`, version: null, root: null };
      }
    } catch {
      return {
        installed: false,
        evidence: `No config directory at ${root}.`,
        version: null,
        root: null,
      };
    }

    // The CLI version is not stored anywhere stable, but every transcript record
    // carries the version that wrote it — so the newest transcript knows.
    const transcripts = await findTranscripts(root);
    let version: string | null = null;
    const newest = transcripts[0];
    if (newest) {
      const parsed = await parseTranscript(newest.path, { projectDirName: newest.projectDirName });
      version = parsed?.summary.cliVersion ?? null;
    }

    return {
      installed: true,
      evidence: `${root} with ${transcripts.length} transcript${transcripts.length === 1 ? '' : 's'}.`,
      version,
      root,
    };
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
    const transcripts = await findTranscripts();
    const sinceMs = options.since ? Date.parse(options.since) : null;
    const candidates = transcripts.filter((t) => (sinceMs === null ? true : t.mtimeMs >= sinceMs));
    const limited = typeof options.limit === 'number' ? candidates.slice(0, options.limit) : candidates;

    const parsed = await mapLimit(limited, PARSE_CONCURRENCY, async (file) => {
      const result = await parseTranscript(file.path, { projectDirName: file.projectDirName });
      if (!result) return null;
      return withSubagents(result.summary, file);
    });

    return parsed
      .filter((p): p is SessionSummary => p !== null)
      .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
  }

  async readSession(sessionId: string): Promise<SessionDetail | null> {
    const transcripts = await findTranscripts();
    const match = transcripts.find((t) => t.sessionId === sessionId);
    if (!match) return null;
    const parsed = await parseTranscript(match.path, {
      projectDirName: match.projectDirName,
      withEvents: true,
    });
    if (!parsed) return null;
    const rollup = await rollupSubagents(match.path, parsed.summary.id);
    return {
      ...parsed.summary,
      subagentCount: rollup.count || parsed.summary.subagentCount,
      subagentTokens: rollup.tokens,
      subagentCost: rollup.cost,
      events: parsed.events,
      toolHistogram: parsed.toolHistogram,
      subagents: rollup.subagents,
    };
  }

  async scanConfig(options: ScanConfigOptions = {}): Promise<ConfigSurface> {
    return scanClaudeConfig(options);
  }

  watchRoots(): string[] {
    return [projectsDir()];
  }

  async listSources(): Promise<SessionSource[]> {
    return (await findTranscripts()).map((t) => ({
      adapter: ADAPTER_ID,
      id: t.sessionId,
      path: t.path,
      bytes: t.bytes,
      mtimeMs: t.mtimeMs,
      hint: { projectDirName: t.projectDirName },
    }));
  }

  async summarizeSource(source: SessionSource): Promise<IndexedSession | null> {
    const parsed = await parseTranscript(source.path, {
      projectDirName: source.hint?.projectDirName,
    });
    if (!parsed) return null;
    return {
      summary: await withSubagents(parsed.summary, { path: source.path }),
      promptPreview: parsed.firstPrompt,
      toolHistogram: parsed.toolHistogram,
      sourceMtimeMs: source.mtimeMs,
    };
  }
}

export { ADAPTER_ID, parseTranscript } from './transcript.ts';
export { claudeRoot, projectsDir, decodeProjectDirName, encodeProjectPath } from './paths.ts';
export { scanClaudeConfig, findShadowed } from './config.ts';
export { findSubagentFiles, rollupSubagents, subagentDir } from './subagents.ts';
export type { ScanConfigOptions } from './config.ts';
