import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { Cost, SubagentSummary, TokenCounts } from '../../types.ts';
import { ZERO_COST, ZERO_TOKENS, addTokens, totalCost } from '../../pricing.ts';
import { mapLimit } from '../../util.ts';
import { parseTranscript } from './transcript.ts';

/**
 * Where Claude Code puts a session's sub-agent transcripts:
 * `<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`.
 */
export function subagentDir(sessionTranscriptPath: string): string {
  const sessionId = basename(sessionTranscriptPath).replace(/\.jsonl$/, '');
  return join(dirname(sessionTranscriptPath), sessionId, 'subagents');
}

export interface SubagentFile {
  path: string;
  agentId: string;
  mtimeMs: number;
  bytes: number;
}

export async function findSubagentFiles(sessionTranscriptPath: string): Promise<SubagentFile[]> {
  const dir = subagentDir(sessionTranscriptPath);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: SubagentFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const path = join(dir, entry.name);
    try {
      const info = await stat(path);
      files.push({
        path,
        agentId: entry.name.replace(/^agent-/, '').replace(/\.jsonl$/, ''),
        mtimeMs: info.mtimeMs,
        bytes: info.size,
      });
    } catch {
      // Gone between readdir and stat.
    }
  }
  return files.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** Where Claude Code records which agent definition a sub-agent ran as. */
export function subagentMetaPath(transcriptPath: string): string {
  return transcriptPath.replace(/\.jsonl$/, '.meta.json');
}

/**
 * Reads `agentType` from `agent-<id>.meta.json`, written next to each sub-agent
 * transcript (`{"agentType":"general-purpose","description":...}`). Older
 * versions did not write the file at all, and a file being written can be
 * truncated, so anything other than a non-empty string is "unknown" — null, not
 * an error. This is a nicety; it must never cost the transcript its row.
 */
export async function readSubagentAgentType(transcriptPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(subagentMetaPath(transcriptPath), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const agentType = (parsed as Record<string, unknown>).agentType;
    return typeof agentType === 'string' && agentType.trim().length > 0 ? agentType.trim() : null;
  } catch {
    return null;
  }
}

export interface SubagentRollup {
  subagents: SubagentSummary[];
  count: number;
  tokens: TokenCounts;
  cost: Cost;
}

export const EMPTY_SUBAGENT_ROLLUP: SubagentRollup = {
  subagents: [],
  count: 0,
  tokens: ZERO_TOKENS,
  cost: ZERO_COST,
};

/**
 * Reads every sub-agent transcript belonging to a session.
 *
 * Each file is a transcript in the same format, so it goes through the same
 * parser — including the usage deduplication, which matters just as much here.
 */
export async function rollupSubagents(
  sessionTranscriptPath: string,
  parentSessionId: string,
  options: { now?: number } = {},
): Promise<SubagentRollup> {
  const files = await findSubagentFiles(sessionTranscriptPath);
  if (files.length === 0) return EMPTY_SUBAGENT_ROLLUP;

  const parsed = await mapLimit(files, 6, async (file) => {
    const result = await parseTranscript(file.path, { now: options.now });
    if (!result) return null;
    const s = result.summary;
    const subagent: SubagentSummary = {
      id: file.agentId,
      parentSessionId,
      agentType: await readSubagentAgentType(file.path),
      title: s.titleSource === 'prompt' || s.titleSource === 'custom' || s.titleSource === 'ai' ? s.title : `agent ${file.agentId.slice(0, 8)}`,
      models: s.models,
      startedAt: s.startedAt,
      lastActivityAt: s.lastActivityAt,
      status: s.status,
      pendingToolCalls: s.pendingToolCalls,
      toolCalls: s.toolCalls,
      tokens: s.tokens,
      cost: s.cost,
      errorCount: s.errorCount,
      transcriptPath: file.path,
      transcriptBytes: file.bytes,
    };
    return { subagent, models: s.models, tokens: s.tokens };
  });

  const subagents: SubagentSummary[] = [];
  const byModel = new Map<string, TokenCounts>();
  let tokens = ZERO_TOKENS;

  for (const entry of parsed) {
    if (!entry) continue;
    subagents.push(entry.subagent);
    tokens = addTokens(tokens, entry.tokens);
    // Attribute the sub-agent's tokens to its model so the rollup prices the
    // same way a session does — and inherits the same honesty about estimates.
    const model = entry.models[0] ?? 'unknown';
    byModel.set(model, addTokens(byModel.get(model) ?? ZERO_TOKENS, entry.tokens));
  }

  return {
    subagents: subagents.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)),
    count: subagents.length,
    tokens,
    cost: byModel.size > 0 ? totalCost(byModel) : ZERO_COST,
  };
}
