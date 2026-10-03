/**
 * Model prices, used to turn recorded token usage into dollars.
 *
 * Rates are USD per million tokens, first-party Anthropic API pricing.
 * Cache multipliers (from Anthropic's prompt-caching docs):
 *   - cache read:  0.1x input  (0.025x on Claude Fable 5.1)
 *   - cache write: 1.25x input at the 5-minute TTL, 2x at the 1-hour TTL
 *
 * This table WILL go stale. It is the one place in Pebble that encodes a price,
 * `PRICING_AS_OF` says when it was last checked, and any model that misses an
 * exact match is reported as estimated rather than silently guessed at.
 */
import type { Cost, CostBasis, TokenCounts } from './types.ts';

export const PRICING_AS_OF = '2026-06-24';

export interface ModelRate {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Override when a model prices cache reads off the standard 0.1x. */
  cacheReadPerMTok?: number;
}

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;

/** Exact model-ID matches. */
export const EXACT_RATES: Record<string, ModelRate> = {
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 0.25 },
  'claude-mythos-5-1': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
};

/**
 * Tier fallbacks, by family prefix. A model ID we have never seen — a point
 * release that shipped after this table was written — prices at its family's
 * going rate and is flagged `estimated` all the way to the UI.
 */
const FAMILY_RATES: Array<{ prefix: string; rate: ModelRate }> = [
  { prefix: 'claude-fable', rate: { inputPerMTok: 10, outputPerMTok: 50 } },
  { prefix: 'claude-mythos', rate: { inputPerMTok: 10, outputPerMTok: 50 } },
  { prefix: 'claude-opus', rate: { inputPerMTok: 5, outputPerMTok: 25 } },
  { prefix: 'claude-sonnet', rate: { inputPerMTok: 2, outputPerMTok: 10 } },
  { prefix: 'claude-haiku', rate: { inputPerMTok: 1, outputPerMTok: 5 } },
];

export type RateLookup =
  | { rate: ModelRate; basis: 'exact' }
  | { rate: ModelRate; basis: 'family' }
  | { rate: null; basis: 'unknown' };

/**
 * Normalizes a recorded model string and finds its rate.
 *
 * Claude Code records context and speed variants in the model string
 * (`claude-opus-5[1m]`, `<model>-fast`). The 1M-context window is not itself a
 * price premium on the current table, so the suffix is stripped; fast mode IS
 * priced differently on Opus 5 and is handled explicitly.
 */
export function lookupRate(model: string): RateLookup {
  const raw = model.trim().toLowerCase();
  if (!raw || raw === 'unknown' || raw === '<synthetic>') return { rate: null, basis: 'unknown' };

  // Strip the context-window marker: "claude-opus-5[1m]" -> "claude-opus-5".
  let id = raw.replace(/\[[^\]]*\]$/, '');

  // Strip a dated snapshot suffix: "claude-haiku-4-5-20251001" -> "claude-haiku-4-5".
  // A snapshot is the same model at the same price, so this is an exact match,
  // not a guess.
  id = id.replace(/-\d{8}$/, '');

  // Fast mode is a real price difference on Opus 5 / 4.8 ($10/$50), not a variant.
  const isFast = id.endsWith('-fast');
  if (isFast) id = id.slice(0, -'-fast'.length);
  if (isFast && (id === 'claude-opus-5' || id === 'claude-opus-4-8')) {
    return { rate: { inputPerMTok: 10, outputPerMTok: 50 }, basis: 'exact' };
  }

  const exact = EXACT_RATES[id];
  if (exact) return { rate: exact, basis: 'exact' };

  for (const { prefix, rate } of FAMILY_RATES) {
    if (id.startsWith(prefix)) return { rate, basis: 'family' };
  }
  return { rate: null, basis: 'unknown' };
}

export const ZERO_TOKENS: TokenCounts = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  thinking: 0,
};

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    thinking: a.thinking + b.thinking,
  };
}

export function billableTokens(t: TokenCounts): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
}

/** Dollars for one model's usage. Returns null when the model cannot be priced. */
export function costForModel(model: string, t: TokenCounts): { usd: number; basis: 'exact' | 'family' } | null {
  const found = lookupRate(model);
  if (!found.rate) return null;
  const r = found.rate;
  const cacheRead = r.cacheReadPerMTok ?? r.inputPerMTok * CACHE_READ_MULTIPLIER;
  const usd =
    (t.input * r.inputPerMTok +
      t.output * r.outputPerMTok +
      t.cacheRead * cacheRead +
      t.cacheWrite5m * r.inputPerMTok * CACHE_WRITE_5M_MULTIPLIER +
      t.cacheWrite1h * r.inputPerMTok * CACHE_WRITE_1H_MULTIPLIER) /
    1_000_000;
  return { usd, basis: found.basis };
}

/**
 * Sums per-model usage into one figure that carries its own confidence.
 *
 * `exact` only when every model matched exactly; `estimated` when a family
 * fallback was used; `partial` when something could not be priced at all and is
 * therefore missing from the total.
 */
export function totalCost(byModel: Map<string, TokenCounts> | Record<string, TokenCounts>): Cost {
  const entries = byModel instanceof Map ? [...byModel.entries()] : Object.entries(byModel);
  let usd = 0;
  let sawFamily = false;
  let sawUnknown = false;
  const unpricedModels: string[] = [];

  for (const [model, tokens] of entries) {
    if (billableTokens(tokens) === 0) continue;
    const priced = costForModel(model, tokens);
    if (!priced) {
      sawUnknown = true;
      unpricedModels.push(model);
      continue;
    }
    if (priced.basis === 'family') {
      sawFamily = true;
      unpricedModels.push(model);
    }
    usd += priced.usd;
  }

  const basis: CostBasis = sawUnknown ? 'partial' : sawFamily ? 'estimated' : 'exact';
  return { usd, basis, unpricedModels: [...new Set(unpricedModels)] };
}

export const ZERO_COST: Cost = { usd: 0, basis: 'exact', unpricedModels: [] };
