import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import type {
  Cost,
  Issue,
  SessionEvent,
  SessionSummary,
  TokenCounts,
} from '../../types.ts';
import { ZERO_COST, ZERO_TOKENS, addTokens, totalCost } from '../../pricing.ts';
import { DEFAULT_WINDOWS, deriveStatus, type StatusWindows } from '../../status.ts';
import { contentBlocks, isInjectedText, isRecord, plainText, type ContentBlock, type TranscriptRecord, type UsageBlock } from './records.ts';
import { decodeProjectDirName } from './paths.ts';

export const ADAPTER_ID = 'claude-code';

/** Longest text we keep per event. The transcript stays the source of truth. */
const TEXT_CAP = 2_000;

/** Cost reconciliation tolerance: the larger of one cent and 2%. */
function costsAgree(reported: number, computed: number): boolean {
  const tolerance = Math.max(0.01, reported * 0.02);
  return Math.abs(reported - computed) <= tolerance;
}

function truncate(text: string, cap = TEXT_CAP): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= cap ? collapsed : `${collapsed.slice(0, cap - 1)}…`;
}

function usageToTokens(usage: UsageBlock): TokenCounts {
  const creation = usage.cache_creation;
  // Prefer the TTL-split counts; they let us price 5-minute and 1-hour writes
  // correctly (1.25x vs 2x). Older transcripts only have the lump sum, which we
  // attribute to the 5-minute TTL because that is the default.
  const w5 = creation?.ephemeral_5m_input_tokens;
  const w1h = creation?.ephemeral_1h_input_tokens;
  const hasSplit = typeof w5 === 'number' || typeof w1h === 'number';
  const lump = usage.cache_creation_input_tokens ?? 0;

  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite5m: hasSplit ? (w5 ?? 0) : lump,
    cacheWrite1h: hasSplit ? (w1h ?? 0) : 0,
    thinking: usage.output_tokens_details?.thinking_tokens ?? 0,
  };
}

export interface ParseOptions {
  /** Collect per-event detail. Off for indexing, on for the detail view. */
  withEvents?: boolean;
  now?: number;
  windows?: StatusWindows;
  /** Directory name under projects/, used only as a cwd fallback. */
  projectDirName?: string;
}

export interface ParsedTranscript {
  summary: SessionSummary;
  events: SessionEvent[];
  toolHistogram: Record<string, number>;
  /** First prompt text, for search and for the sessions list. */
  firstPrompt: string | null;
}

/**
 * Reads one session transcript into Pebble's normalized shapes.
 *
 * Three things here are load-bearing and easy to get wrong:
 *
 * 1. **Usage is deduplicated by `message.id`.** Claude Code writes one record per
 *    content block, and every record of the same API response repeats the *same*
 *    `usage` object. Summing naively overstates cost by a large factor — in this
 *    machine's own transcripts, by up to 152 extra copies in a single file.
 * 2. **`cwd` comes from the records, not the directory name.** The directory name
 *    is the cwd with `/` replaced by `-`, which is ambiguous for any path
 *    containing a hyphen.
 * 3. **A reported cost beats a computed one**, and a disagreement between them is
 *    reported rather than reconciled.
 */
export async function parseTranscript(
  filePath: string,
  options: ParseOptions = {},
): Promise<ParsedTranscript | null> {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return null;
  }
  if (!fileStat.isFile()) return null;

  const withEvents = options.withEvents ?? false;
  const events: SessionEvent[] = [];
  const issues: Issue[] = [];
  const toolHistogram: Record<string, number> = {};
  const tokensByModel = new Map<string, TokenCounts>();
  const models = new Set<string>();
  /** message.id (or requestId, or uuid) of every usage block already counted. */
  const countedUsage = new Set<string>();
  /** tool_use id -> tool name, for calls we have not yet seen a result for. */
  const openToolUses = new Map<string, string>();

  let sessionId = basename(filePath).replace(/\.jsonl$/, '');
  let seq = 0;
  let malformedLines = 0;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let entrypoint: string | null = null;
  let cliVersion: string | null = null;
  let permissionMode: string | null = null;
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let agentName: string | null = null;
  let firstPrompt: string | null = null;
  let lastPromptText: string | null = null;
  let userTurns = 0;
  let assistantTurns = 0;
  let toolCalls = 0;
  let errorCount = 0;
  let subagentCount = 0;
  let sawSidechain = false;
  let reportedCostUsd: number | null = null;
  let reportedHasUnknownModel = false;
  let linesAdded: number | null = null;
  let linesRemoved: number | null = null;
  let apiDurationMs: number | null = null;

  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // A transcript being appended to right now can end mid-line. That is
        // normal, not corruption — count it and move on.
        malformedLines += 1;
        continue;
      }
      if (!isRecord(parsed)) continue;
      const rec = parsed as TranscriptRecord;
      seq += 1;

      if (rec.sessionId) sessionId = rec.sessionId;
      if (rec.timestamp) {
        if (!firstTimestamp) firstTimestamp = rec.timestamp;
        lastTimestamp = rec.timestamp;
      }
      if (rec.cwd) cwd = rec.cwd;
      if (rec.relocatedCwd) cwd = rec.relocatedCwd;
      if (rec.gitBranch) gitBranch = rec.gitBranch;
      if (rec.entrypoint) entrypoint = rec.entrypoint;
      if (rec.version) cliVersion = rec.version;
      if (rec.permissionMode) permissionMode = rec.permissionMode;
      if (rec.isSidechain) sawSidechain = true;

      switch (rec.type) {
        case 'custom-title':
          if (rec.customTitle) customTitle = rec.customTitle;
          continue;
        case 'ai-title':
          if (rec.aiTitle) aiTitle = rec.aiTitle;
          continue;
        case 'agent-name':
          if (rec.agentName) agentName = rec.agentName;
          continue;
        case 'cost-state': {
          if (typeof rec.totalCostUSD === 'number') reportedCostUsd = rec.totalCostUSD;
          if (rec.hasUnknownModelCost) reportedHasUnknownModel = true;
          if (typeof rec.totalLinesAdded === 'number') linesAdded = rec.totalLinesAdded;
          if (typeof rec.totalLinesRemoved === 'number') linesRemoved = rec.totalLinesRemoved;
          if (typeof rec.totalAPIDuration === 'number') apiDurationMs = rec.totalAPIDuration;
          for (const model of Object.keys(rec.modelUsage ?? {})) models.add(model);
          continue;
        }
        // Bookkeeping records with nothing to show a human.
        case 'last-prompt':
          // The most recent prompt is a far better name than a bare session id,
          // and it is the only text available for a session whose opening turn
          // was a slash command or an injected reminder.
          if (typeof rec.lastPrompt === 'string' && rec.lastPrompt.trim() && !isInjectedText(rec.lastPrompt)) {
            lastPromptText = truncate(rec.lastPrompt, 400);
          }
          continue;
        case 'queue-operation':
        case 'atis-latch':
        case 'mode':
        case 'permission-mode':
        case 'bridge-session':
        case 'relocated':
        case 'file-history-snapshot':
        case 'file-history-delta':
        case 'attachment':
          continue;
        default:
          break;
      }

      if (rec.type === 'system') {
        const isError = rec.level === 'error' || rec.subtype === 'api_error';
        if (isError) errorCount += 1;
        const hookFailed = Array.isArray(rec.hookErrors) && rec.hookErrors.length > 0;
        if (hookFailed) errorCount += 1;
        if (withEvents && (isError || rec.subtype === 'stop_hook_summary' || rec.subtype === 'compact_boundary')) {
          events.push({
            sessionId,
            uuid: rec.uuid ?? `seq-${seq}`,
            parentUuid: rec.parentUuid ?? null,
            seq,
            at: rec.timestamp ?? lastTimestamp ?? new Date(fileStat.mtimeMs).toISOString(),
            kind: isError ? 'error' : 'hook',
            role: 'system',
            model: null,
            effort: null,
            isSidechain: Boolean(rec.isSidechain),
            agentName: null,
            toolName: null,
            toolUseId: null,
            toolStatus: null,
            text: describeSystemRecord(rec),
            tokens: null,
            cost: null,
          });
        }
        continue;
      }

      if (rec.type === 'user') {
        const text = plainText(rec.message);
        const blocks = contentBlocks(rec.message);
        const results = blocks.filter((b) => b.type === 'tool_result');

        // Tool results arrive as user records. Pair them up and close the call.
        for (const result of results) {
          const id = result.tool_use_id;
          const toolName = (id && openToolUses.get(id)) ?? 'unknown';
          if (id) openToolUses.delete(id);
          if (result.is_error) errorCount += 1;
          if (withEvents) {
            events.push({
              sessionId,
              uuid: rec.uuid ? `${rec.uuid}:${id ?? 'result'}` : `seq-${seq}`,
              parentUuid: rec.parentUuid ?? null,
              seq,
              at: rec.timestamp ?? lastTimestamp ?? new Date(fileStat.mtimeMs).toISOString(),
              kind: 'tool-result',
              role: 'user',
              model: null,
              effort: null,
              isSidechain: Boolean(rec.isSidechain),
              agentName,
              toolName,
              toolUseId: id ?? null,
              toolStatus: result.is_error ? 'error' : 'ok',
              text: summarizeToolResult(result),
              tokens: null,
              cost: null,
            });
          }
        }

        // A real human turn: has text, is not a tool result, is not injected.
        const isHumanTurn =
          results.length === 0 && !rec.isMeta && typeof text === 'string' && text.length > 0 && !isInjectedText(text);
        if (isHumanTurn) {
          if (!rec.isSidechain) userTurns += 1;
          // Sub-agent transcripts are entirely sidechain records, and their first
          // one is the task the agent was handed — which is exactly the title we
          // want for it. So the prompt is captured regardless of sidechain, while
          // only real turns are counted above.
          if (!firstPrompt) firstPrompt = truncate(unwrapTeammateMessage(text), 400);
          if (withEvents) {
            events.push({
              sessionId,
              uuid: rec.uuid ?? `seq-${seq}`,
              parentUuid: rec.parentUuid ?? null,
              seq,
              at: rec.timestamp ?? lastTimestamp ?? new Date(fileStat.mtimeMs).toISOString(),
              kind: 'prompt',
              role: 'user',
              model: null,
              effort: null,
              isSidechain: Boolean(rec.isSidechain),
              agentName,
              toolName: null,
              toolUseId: null,
              toolStatus: null,
              text: truncate(text),
              tokens: null,
              cost: null,
            });
          }
        }
        continue;
      }

      if (rec.type === 'assistant') {
        const message = rec.message;
        const model = message?.model && message.model !== '<synthetic>' ? message.model : null;
        if (model) models.add(model);
        if (rec.isApiErrorMessage) errorCount += 1;

        // Deduplicate usage: one API response is written as many records, each
        // carrying an identical copy of `usage`.
        const usageKey = message?.id ?? rec.requestId ?? rec.uuid;
        let eventTokens: TokenCounts | null = null;
        if (message?.usage && usageKey && !countedUsage.has(usageKey)) {
          countedUsage.add(usageKey);
          eventTokens = usageToTokens(message.usage);
          const key = model ?? 'unknown';
          tokensByModel.set(key, addTokens(tokensByModel.get(key) ?? ZERO_TOKENS, eventTokens));
          assistantTurns += 1;
        }

        const blocks = contentBlocks(message);
        const text = plainText(message);
        const thinking = blocks.some((b) => b.type === 'thinking');

        for (const block of blocks) {
          if (block.type !== 'tool_use') continue;
          const name = block.name ?? 'unknown';
          toolCalls += 1;
          toolHistogram[name] = (toolHistogram[name] ?? 0) + 1;
          if (name === 'Task' || name === 'Agent') subagentCount += 1;
          if (block.id) openToolUses.set(block.id, name);
          if (withEvents) {
            events.push({
              sessionId,
              uuid: block.id ?? rec.uuid ?? `seq-${seq}`,
              parentUuid: rec.uuid ?? null,
              seq,
              at: rec.timestamp ?? lastTimestamp ?? new Date(fileStat.mtimeMs).toISOString(),
              kind: 'tool-call',
              role: 'assistant',
              model,
              effort: rec.effort ?? null,
              isSidechain: Boolean(rec.isSidechain),
              agentName,
              toolName: name,
              toolUseId: block.id ?? null,
              toolStatus: 'pending',
              text: summarizeToolInput(name, block),
              tokens: null,
              cost: null,
            });
          }
        }

        if (withEvents && (text || thinking)) {
          events.push({
            sessionId,
            uuid: rec.uuid ?? `seq-${seq}`,
            parentUuid: rec.parentUuid ?? null,
            seq,
            at: rec.timestamp ?? lastTimestamp ?? new Date(fileStat.mtimeMs).toISOString(),
            kind: 'response',
            role: 'assistant',
            model,
            effort: rec.effort ?? null,
            isSidechain: Boolean(rec.isSidechain),
            agentName,
            toolName: null,
            toolUseId: null,
            toolStatus: null,
            text: text ? truncate(text) : '(thinking)',
            tokens: eventTokens,
            cost: eventTokens && model ? totalCost(new Map([[model, eventTokens]])) : null,
          });
        }
        continue;
      }
    }
  } finally {
    stream.close();
  }

  if (malformedLines > 0) {
    issues.push({
      level: 'info',
      code: 'transcript.partial-lines',
      message:
        malformedLines === 1
          ? '1 line could not be parsed (normal for a session still being written).'
          : `${malformedLines} lines could not be parsed.`,
      path: filePath,
    });
  }

  const tokens = [...tokensByModel.values()].reduce(addTokens, ZERO_TOKENS);
  const computed = tokensByModel.size > 0 ? totalCost(tokensByModel) : ZERO_COST;
  const cost = reconcileCost(reportedCostUsd, reportedHasUnknownModel, computed, issues);

  const mtimeIso = new Date(fileStat.mtimeMs).toISOString();
  const startedAt = firstTimestamp ?? mtimeIso;
  // A transcript's last timestamp can lag its mtime (trailing bookkeeping records
  // carry none), so liveness uses whichever is later.
  const lastActivityAt =
    lastTimestamp && Date.parse(lastTimestamp) > fileStat.mtimeMs ? lastTimestamp : mtimeIso;

  const projectPath =
    cwd ?? (options.projectDirName ? decodeProjectDirName(options.projectDirName) : '(unknown)');
  if (!cwd && options.projectDirName) {
    issues.push({
      level: 'info',
      code: 'transcript.cwd-inferred',
      message:
        'No working directory was recorded in this transcript; the path shown is decoded from the directory name and may be wrong where a folder contains a hyphen.',
      path: filePath,
    });
  }

  const title = pickTitle({ customTitle, aiTitle, agentName, firstPrompt: firstPrompt ?? lastPromptText, sessionId });
  const pendingToolCalls = openToolUses.size;

  const summary: SessionSummary = {
    id: sessionId,
    adapter: ADAPTER_ID,
    title: title.title,
    titleSource: title.source,
    projectPath,
    projectLabel: projectPath === '(unknown)' ? '(unknown)' : basename(projectPath) || projectPath,
    gitBranch,
    entrypoint,
    cliVersion,
    models: [...models].sort(),
    startedAt,
    lastActivityAt,
    status: deriveStatus({
      lastActivityAt,
      pendingToolCalls,
      now: options.now,
      windows: options.windows ?? DEFAULT_WINDOWS,
    }),
    userTurns,
    assistantTurns,
    toolCalls,
    pendingToolCalls,
    tokens,
    cost,
    // A count from the Task/Agent calls in this file. The adapter replaces it
    // with the number of sub-agent transcripts actually on disk, which is exact.
    subagentCount: subagentCount || (sawSidechain ? 1 : 0),
    subagentTokens: ZERO_TOKENS,
    subagentCost: ZERO_COST,
    errorCount,
    transcriptPath: resolve(filePath),
    transcriptBytes: fileStat.size,
    linesAdded,
    linesRemoved,
    apiDurationMs,
    permissionMode,
    issues,
  };

  return { summary, events, toolHistogram, firstPrompt };
}

/**
 * Picks between the host tool's own cost figure and ours.
 *
 * The host's number wins when it exists — it is the billing-side truth. But when
 * the two disagree beyond tolerance, both are kept and surfaced; silently
 * preferring one would turn an open question into a confident answer.
 */
function reconcileCost(
  reportedUsd: number | null,
  reportedHasUnknownModel: boolean,
  computed: Cost,
  issues: Issue[],
): Cost {
  if (reportedUsd === null) return computed;

  const agree = computed.usd === 0 || costsAgree(reportedUsd, computed.usd);
  const result: Cost = {
    usd: reportedUsd,
    basis: 'reported',
    unpricedModels: reportedHasUnknownModel ? computed.unpricedModels : [],
  };

  if (reportedHasUnknownModel) {
    issues.push({
      level: 'warn',
      code: 'cost.host-unknown-model',
      message: 'Claude Code flagged this session as containing a model it could not price.',
    });
  }

  if (!agree) {
    result.conflict = { reportedUsd, computedUsd: computed.usd };
    issues.push({
      level: 'warn',
      code: 'cost.disagreement',
      message: `Claude Code reports $${reportedUsd.toFixed(4)} for this session; Pebble's own calculation from token usage gives $${computed.usd.toFixed(4)}. Showing the reported figure. A gap usually means Pebble's price table is out of date for one of this session's models.`,
    });
  }

  return result;
}

/**
 * Agent-team teammates are handed their task wrapped as
 * `<teammate-message teammate_id="…" summary="…">task</teammate-message>`.
 * The summary is the lead's own one-line name for the task, so it makes the
 * title; without one, the bare task text does.
 */
export function unwrapTeammateMessage(text: string): string {
  const open = /^\s*<teammate-message\b([^>]*)>/.exec(text);
  if (!open) return text;
  const summary = /\bsummary="([^"]*)"/.exec(open[1] ?? '')?.[1]?.trim();
  if (summary) return summary;
  return text.slice(open[0].length).replace(/<\/teammate-message>\s*$/, '').trim() || text;
}

function pickTitle(input: {
  customTitle: string | null;
  aiTitle: string | null;
  agentName: string | null;
  firstPrompt: string | null;
  sessionId: string;
}): { title: string; source: SessionSummary['titleSource'] } {
  if (input.customTitle) return { title: input.customTitle, source: 'custom' };
  if (input.aiTitle) return { title: input.aiTitle, source: 'ai' };
  if (input.agentName) return { title: input.agentName, source: 'agent' };
  if (input.firstPrompt) return { title: truncate(input.firstPrompt, 120), source: 'prompt' };
  return { title: `session ${input.sessionId.slice(0, 8)}`, source: 'fallback' };
}

function describeSystemRecord(rec: TranscriptRecord): string {
  if (rec.subtype === 'stop_hook_summary') {
    const count = rec.hookCount ?? 0;
    const blocked = rec.preventedContinuation ? ' (blocked continuation)' : '';
    const commands = (rec.hookInfos ?? [])
      .map((h) => h.command)
      .filter((c): c is string => typeof c === 'string')
      .join(', ');
    return `${count} stop hook${count === 1 ? '' : 's'}${blocked}${commands ? `: ${commands}` : ''}`;
  }
  if (rec.subtype === 'compact_boundary') return 'context compacted';
  if (rec.subtype) return rec.subtype.replace(/_/g, ' ');
  return 'system event';
}

/** A one-line gist of a tool call, chosen per tool so the timeline reads well. */
function summarizeToolInput(name: string, block: ContentBlock): string {
  const input = block.input ?? {};
  const pick = (key: string): string | null => {
    const value = input[key];
    return typeof value === 'string' ? value : null;
  };
  const candidate =
    pick('command') ??
    pick('file_path') ??
    pick('pattern') ??
    pick('query') ??
    pick('url') ??
    pick('description') ??
    pick('prompt') ??
    pick('skill') ??
    pick('path');
  if (candidate) return truncate(candidate, 300);
  const keys = Object.keys(input);
  return keys.length ? `${name}(${keys.join(', ')})` : name;
}

function summarizeToolResult(block: ContentBlock): string {
  const content = block.content;
  if (typeof content === 'string') return truncate(content, 400);
  if (Array.isArray(content)) {
    const text = content
      .map((c) => (typeof c === 'object' && c !== null && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n');
    if (text) return truncate(text, 400);
  }
  return block.is_error ? 'error' : 'ok';
}
