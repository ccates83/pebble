import { readdir, stat } from 'node:fs/promises';
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
      title: s.titleSource === 'prompt' || s.titleSource === 'custom' || s.titleSource === 'ai' ? s.title : `agent ${file.agentId.slice(0, 8)}`,
      models: s.models,
      startedAt: s.startedAt,
      lastActivityAt: s.lastActivityAt,
      status: s.status,
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
