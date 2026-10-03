---
name: pebble-honest-numbers
description: How Pebble represents figures whose confidence is less than certain — costs, token counts, inferred paths and derived status. Use when adding a number to the API or UI, changing how cost is calculated, reconciling two sources that disagree, adding a model to the price table, or reviewing whether a figure is presented honestly.
---

# Honest numbers

Pebble is a dashboard about money and activity, built on a file format nobody
publishes. Most of its numbers are inferences. The design principle is that **a
number that might be wrong must look different from a number that isn't** — and
that principle is implemented, not aspirational.

Apply this whenever you add, compute or render a figure.

## 1. Prefer a figure someone else already measured

If the agent tool recorded a cost itself, that is the billing-side truth. Use it
and set `basis: 'reported'`. Claude Code does this in `cost-state` records
(`totalCostUSD`), though not in every session.

Compute only when there is nothing to prefer.

## 2. When two sources disagree, keep both

Do not reconcile. Do not average. Do not pick the one that looks nicer.

```ts
result.conflict = { reportedUsd, computedUsd };
issues.push({ level: 'warn', code: 'cost.disagreement', message: /* both figures, and which is shown */ });
```

Tolerance is the larger of one cent and 2%, because floating-point and rounding
differences are not disagreements. Beyond that, the UI marks the figure `*`, shows
the reported one, and the tooltip names both.

A disagreement is nearly always a stale price table — which is information, and
silently resolving it throws that information away.

## 3. Carry confidence in the type, not in a comment

```ts
interface Cost { usd: number; basis: CostBasis; unpricedModels: string[]; conflict?: {...} }
type CostBasis = 'reported' | 'exact' | 'estimated' | 'partial';
```

`basis` travels from the parser through SQLite to the API to the pixel. A function
that returns a bare `number` for a cost has thrown away the only thing that made
it trustworthy.

Aggregating is where this usually gets lost. `totalCost` degrades deliberately:
any family fallback makes the whole total `estimated`, and anything unpriceable
makes it `partial` **and excludes that usage from the sum**. A model with zero
billable tokens does not degrade a total — it contributed nothing, so its
unknown rate is irrelevant.

## 4. An unknown is priced by family and marked, never guessed or zeroed

A model id that is not in the table — a point release that shipped after the table
was written — prices at its family's rate with `basis: 'estimated'`. Showing zero
would be wrong and invisibly so; refusing to show anything would be unhelpful.

A *dated snapshot* (`claude-haiku-4-5-20251001`) is the same model at the same
price, so it normalizes to an **exact** match. Likewise a context-window suffix
(`claude-opus-5[1m]`). Neither is an estimate. Something genuinely unrecognized
(`claude-opus-5-5`) is.

Prices live in `packages/core/src/pricing.ts` and nowhere else, with
`PRICING_AS_OF` recording when they were last checked. **Load the `claude-api`
skill before writing a rate** — never one from memory. The doctor warns when the
table is more than 120 days old, because computed figures get less trustworthy as
it ages while reported ones do not.

## 5. Do not add two numbers whose relationship you cannot establish

Sub-agents have their own transcripts and their own cost. Nothing says whether a
parent's reported cost already includes them. So `subagentCost` sits beside
`cost`, labelled, and the UI says "counted separately". Adding them risks double
counting; dropping them under-reports; showing both is correct and honest.

The general rule: when two figures might overlap and nothing tells you whether
they do, present them separately and say why.

## 6. An inference about anything else gets the same treatment

Not just money:

- **`projectPath`** — if it had to be decoded from a directory name rather than
  read from the records, raise `transcript.cwd-inferred`. The encoding is lossy
  and the decoded path may be wrong.
- **`status`** — derived from file mtime and unanswered tool calls, with the
  windows exposed as a parameter because they are a guess.
- **`titleSource`** — the UI says whether a name was chosen by you, generated, or
  taken from a first prompt.
- **`cacheHitRate`** — returns `null`, not `0`, when there was no input at all.
  "0% cache hit" and "nothing has happened yet" are different facts.

## 7. Render it

Always `<CostFigure cost={cost} />`, never `money(cost.usd)` alone.

| Mark | Means |
|---|---|
| none | reported, or computed from an exact match |
| `~` | estimated from a family rate |
| `*` | reported and computed disagree; both kept |
| `?` | incomplete — something could not be priced and is missing |

Every mark is an `<abbr>` whose `title` explains it in a sentence. A chart bar for
a day containing any such figure is hatched rather than solid.

## Checklist

- [ ] Is there a figure the tool recorded that I should prefer?
- [ ] Does my return type carry `basis`, or did I return a bare number?
- [ ] If two sources disagree, did I keep both and raise an issue?
- [ ] Does an unrecognized model degrade the total's basis rather than vanishing?
- [ ] Am I adding two figures whose overlap I cannot establish?
- [ ] Does the UI render the marker?
- [ ] Is there a test asserting the wrong-looking-but-correct behaviour, so nobody
      "fixes" it into lying? (The lossy path decoder has one. So does the
      zero-token model.)
