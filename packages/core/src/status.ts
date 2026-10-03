import type { SessionStatus } from './types.ts';

/**
 * How long after its last write we still consider a session each thing.
 * Claude Code publishes no liveness signal, so these windows are the whole
 * mechanism — they are configurable for exactly that reason.
 */
export interface StatusWindows {
  activeMs: number;
  idleMs: number;
}

export const DEFAULT_WINDOWS: StatusWindows = {
  activeMs: 90_000, // wrote within a minute and a half: working
  idleMs: 30 * 60_000, // quiet under half an hour: probably still open
};

export interface StatusInput {
  lastActivityAt: string;
  /** Tool calls with no result by the end of the transcript. */
  pendingToolCalls: number;
  now?: number;
  windows?: StatusWindows;
}

/**
 * A session with an unanswered tool call that has gone quiet is waiting on a
 * human — a permission prompt, or a question. That is the one state worth
 * interrupting someone for, so it outranks plain idleness.
 */
export function deriveStatus(input: StatusInput): SessionStatus {
  const w = input.windows ?? DEFAULT_WINDOWS;
  const now = input.now ?? Date.now();
  const last = Date.parse(input.lastActivityAt);
  const age = Number.isFinite(last) ? now - last : Number.POSITIVE_INFINITY;

  if (age <= w.activeMs) return 'active';
  if (input.pendingToolCalls > 0 && age <= w.idleMs) return 'waiting';
  if (age <= w.idleMs) return 'idle';
  return 'done';
}
