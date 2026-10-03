import { test } from 'node:test';
import assert from 'node:assert/strict';

import { costForModel, lookupRate, totalCost, ZERO_TOKENS, addTokens, billableTokens } from '../dist/index.js';

const tokens = (overrides = {}) => ({ ...ZERO_TOKENS, ...overrides });

test('an exact model id prices exactly', () => {
  const found = lookupRate('claude-opus-5');
  assert.equal(found.basis, 'exact');
  assert.equal(found.rate.inputPerMTok, 5);
});

test('a context-window suffix is stripped, not treated as a different model', () => {
  assert.equal(lookupRate('claude-opus-5[1m]').basis, 'exact');
  assert.deepEqual(lookupRate('claude-opus-5[1m]').rate, lookupRate('claude-opus-5').rate);
});

test('a dated snapshot is the same model at the same price, so it matches exactly', () => {
  const dated = lookupRate('claude-haiku-4-5-20251001');
  assert.equal(dated.basis, 'exact', 'a dated snapshot should not be reported as an estimate');
  assert.deepEqual(dated.rate, lookupRate('claude-haiku-4-5').rate);
});

test('an unrecognised point release falls back to its family and says so', () => {
  const unknown = lookupRate('claude-opus-5-5');
  assert.equal(unknown.basis, 'family');
  assert.equal(unknown.rate.inputPerMTok, 5);
});

test('an unrecognised family cannot be priced at all', () => {
  assert.equal(lookupRate('some-other-vendor-model').basis, 'unknown');
  assert.equal(lookupRate('').basis, 'unknown');
  assert.equal(lookupRate('<synthetic>').basis, 'unknown');
});

test('fast mode on Opus 5 is its own price, not the standard rate', () => {
  const fast = lookupRate('claude-opus-5-fast');
  assert.equal(fast.basis, 'exact');
  assert.equal(fast.rate.inputPerMTok, 10);
  assert.equal(fast.rate.outputPerMTok, 50);
});

test('cache tokens use the documented multipliers', () => {
  // Opus 5: $5 in, $25 out. Cache read 0.1x = $0.50/MTok,
  // 5m write 1.25x = $6.25/MTok, 1h write 2x = $10/MTok.
  const priced = costForModel(
    'claude-opus-5',
    tokens({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 }),
  );
  assert.equal(priced.basis, 'exact');
  assert.equal(priced.usd, 5 + 25 + 0.5 + 6.25 + 10);
});

test('Fable 5.1 prices cache reads at its own published rate, not 0.1x', () => {
  const priced = costForModel('claude-fable-5-1', tokens({ cacheRead: 1_000_000 }));
  assert.equal(priced.usd, 0.25, 'Fable 5.1 cache reads are $0.25/MTok, not $1.00');
});

test('an older transcript with only a lump cache_creation figure bills at the 5-minute rate', () => {
  const lump = costForModel('claude-opus-5', tokens({ cacheWrite5m: 1_000_000 }));
  assert.equal(lump.usd, 6.25);
});

test('a total is only "exact" when every model in it was', () => {
  const exact = totalCost(new Map([['claude-opus-5', tokens({ output: 1_000_000 })]]));
  assert.equal(exact.basis, 'exact');
  assert.deepEqual(exact.unpricedModels, []);

  const estimated = totalCost(
    new Map([
      ['claude-opus-5', tokens({ output: 1_000_000 })],
      ['claude-opus-5-5', tokens({ output: 1_000_000 })],
    ]),
  );
  assert.equal(estimated.basis, 'estimated');
  assert.deepEqual(estimated.unpricedModels, ['claude-opus-5-5']);
  assert.equal(estimated.usd, 50, 'a family fallback is still added to the total');
});

test('an unpriceable model makes the total partial and is excluded from it', () => {
  const partial = totalCost(
    new Map([
      ['claude-opus-5', tokens({ output: 1_000_000 })],
      ['mystery-model', tokens({ output: 1_000_000 })],
    ]),
  );
  assert.equal(partial.basis, 'partial');
  assert.equal(partial.usd, 25, 'the unpriceable model contributes nothing rather than a guess');
  assert.deepEqual(partial.unpricedModels, ['mystery-model']);
});

test('a model with no billable tokens does not drag a total down to "estimated"', () => {
  const cost = totalCost(
    new Map([
      ['claude-opus-5', tokens({ output: 1_000 })],
      ['claude-opus-5-5', ZERO_TOKENS],
    ]),
  );
  assert.equal(cost.basis, 'exact');
});

test('token arithmetic adds every bucket', () => {
  const sum = addTokens(tokens({ input: 1, cacheRead: 2 }), tokens({ output: 3, thinking: 4 }));
  assert.deepEqual(sum, { input: 1, output: 3, cacheRead: 2, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 4 });
  // Thinking tokens are already counted inside output, so they are not billable twice.
  assert.equal(billableTokens(sum), 6);
});
