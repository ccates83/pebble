/**
 * The shapes Claude Code actually writes to `~/.claude/projects/<dir>/<id>.jsonl`.
 *
 * This file is reverse-engineered from real transcripts (CLI 2.1.x) — it is not a
 * published format, so every field is optional and the parser must survive
 * anything. Record types observed in the wild:
 *
 *   user, assistant, system, attachment, summary, queue-operation, last-prompt,
 *   custom-title, ai-title, agent-name, atis-latch, mode, permission-mode,
 *   bridge-session, cost-state, relocated, file-history-snapshot,
 *   file-history-delta
 */

export interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  output_tokens_details?: { thinking_tokens?: number };
  service_tier?: string;
  speed?: string;
}

export interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  /** Set when a tool was invoked from inside code execution. */
  caller?: string;
  // tool_result
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

export interface MessageBody {
  id?: string;
  role?: string;
  model?: string;
  content?: string | ContentBlock[];
  usage?: UsageBlock;
  stop_reason?: string | null;
}

export interface CostStateModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

/** One line of the transcript. Every field optional by design. */
export interface TranscriptRecord {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  relocatedCwd?: string;
  gitBranch?: string;
  version?: string;
  entrypoint?: string;
  userType?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  isCompactSummary?: boolean;
  level?: string;
  effort?: string;
  requestId?: string;
  message?: MessageBody;
  toolUseResult?: unknown;
  // single-purpose records
  customTitle?: string;
  aiTitle?: string;
  agentName?: string;
  summary?: string;
  mode?: string;
  permissionMode?: string;
  lastPrompt?: string;
  // cost-state
  totalCostUSD?: number;
  totalAPIDuration?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  modelUsage?: Record<string, CostStateModelUsage>;
  hasUnknownModelCost?: boolean;
  // stop_hook_summary
  hookCount?: number;
  hookErrors?: unknown[];
  preventedContinuation?: boolean;
  hookInfos?: Array<{ command?: string; durationMs?: number }>;
}

export function isRecord(value: unknown): value is TranscriptRecord {
  return typeof value === 'object' && value !== null;
}

export function contentBlocks(message: MessageBody | undefined): ContentBlock[] {
  if (!message) return [];
  const c = message.content;
  if (Array.isArray(c)) return c.filter((b): b is ContentBlock => typeof b === 'object' && b !== null);
  return [];
}

export function plainText(message: MessageBody | undefined): string | null {
  if (!message) return null;
  if (typeof message.content === 'string') return message.content;
  const parts: string[] = [];
  for (const block of contentBlocks(message)) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length ? parts.join('\n') : null;
}

/**
 * True for text Claude Code injects rather than text the human typed —
 * system reminders, slash-command wrappers, caveats. These must not become a
 * session's title.
 */
export function isInjectedText(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('<system-reminder') ||
    t.startsWith('<command-name') ||
    t.startsWith('<command-message') ||
    t.startsWith('<local-command') ||
    t.startsWith('<user-prompt-submit-hook') ||
    t.startsWith('Caveat: The messages below were generated')
  );
}
