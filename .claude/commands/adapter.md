---
description: Scaffold and implement a Pebble adapter for another agent tool
argument-hint: "<tool-name>"
---

Add support for a new agent tool: `$ARGUMENTS`

Read `docs/ADAPTERS.md` first — it has the contract, the steps and the traps.

Before writing any code, investigate and report what you find:

1. **Where does it keep state?** Find the equivalent of `~/.claude/projects`. Read
   several real files if any exist on this machine.
2. **What is the session record format?** Enumerate record types and fields the
   way `records.ts` does for Claude Code. Note explicitly whether usage or cost is
   repeated across records — assume it is until you have checked, because that
   failure mode produces a cost figure several times too large that looks
   plausible.
3. **Is cost recorded, or must it be computed?** If computed, what model ids
   appear and do they map onto a price table?
4. **Is there a config surface?** Agents, skills, commands, hooks, MCP servers,
   instruction files — whatever this tool's equivalents are.
5. **Can liveness be inferred?** What is the equivalent of "wrote to its
   transcript 20 seconds ago"?

Then present the mapping onto Pebble's types and get it confirmed before
implementing. An adapter built on a guessed format is worse than none, because its
numbers look real.

Implementation goes to `pebble-core`. Tests use fixtures in a temp dir, pointed at
by an env var — never the developer's real config.
