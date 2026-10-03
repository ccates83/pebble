---
description: Re-verify the transcript parser against this machine's real transcripts
---

The Claude Code transcript format is not documented by the vendor, so Pebble's
parser is only correct until the format changes. This re-checks the assumptions it
depends on, against the real files in `~/.claude/projects`.

Check each of these and report what you found, with numbers:

1. **Record types.** Count every distinct `type` across all transcripts. Compare
   against the list in `packages/core/src/adapters/claude-code/records.ts`. A new
   type is not necessarily a problem, but an unhandled one that carries usage or
   cost is.

2. **Usage duplication.** For each file, count assistant records sharing a
   `message.id`, and confirm the repeated `usage` objects are still identical. This
   is what the deduplication depends on. If they ever differ, the dedup strategy
   is wrong and cost is wrong with it.

3. **`cost-state` presence.** How many sessions carry one, and for those, how far
   `totalCostUSD` is from what Pebble computes. A widening gap means the price
   table is going stale.

4. **Model ids in use.** Every distinct model string across all transcripts, and
   whether each resolves to an `exact` rate. Anything landing on a family fallback
   is a model worth adding to the table.

5. **Sub-agent layout.** Confirm sub-agent transcripts are still at
   `<projectDir>/<sessionId>/subagents/agent-*.jsonl`.

6. **Field drift.** Are `cwd`, `gitBranch`, `version`, `requestId` and
   `message.usage.cache_creation` still present and shaped as expected?

Write the findings into `docs/DATA-MODEL.md` or `CLAUDE.md` if anything has
actually changed, and add a test for anything that was wrong. Do not change
parsing behaviour on the strength of one file — check across all of them.
