# Roadmap

v1 watches and inventories. Each item below says what would have to be true
first, because several of them trade away something v1 is deliberately buying.

## Next

**Hook-fed live state.** `pebble hooks install` writing a `SessionStart` /
`PreToolUse` / `Stop` / `Notification` block into a chosen settings file, feeding
events to the running server for sub-second updates and real permission-request
surfacing. Requires: an uninstall that is exactly as reliable as the install, and
the poll continuing to work for anyone who declines.

**Full-text search over history.** Searching the *content* of past sessions, not
just titles and first prompts. Requires deciding whether to copy prompt text into
the index — which v1 deliberately does not do — or to grep transcripts on demand
and accept the latency. Probably the latter.

**Cost attribution.** Which sessions produced commits versus which explored and
got abandoned, by joining session timestamps against git history in the project.
Requires a way to attribute that isn't just "the session was open when the commit
landed".

**A second adapter.** The interface is built for it and unproven until one exists.
Whichever tool gets adopted second.

## Later

**Control verbs.** Launching, stopping and queueing agents from the dashboard,
with worktree isolation for parallel work. Goes in a separate `AgentController`
interface so a read-only adapter stays complete. Requires giving up the read-only
guarantee, which means it should be opt-in and obvious.

**The `queue/` directory, wired up.** Markdown task files exist as a convention
for unattended work; nothing reads them yet. Pairs with control verbs.

**Notifications.** Desktop or phone, for a session that is blocked or has gone
quiet mid-task. Requires the `waiting` heuristic to be good enough to interrupt
someone — one false positive a day and it gets muted forever.

**Config editing.** Pebble can already see every agent, skill, hook and MCP
server, and what's wrong with each. Fixing them in place is the obvious next step
and the first thing that would write to `~/.claude`.

**A `CLAUDE.md` budget view.** Pebble knows the size of every memory file in every
scope. Showing what a given project actually loads, and what it costs per
request, is a small addition with a real payoff.

## Explicitly not planned

**A hosted version.** Pebble reads prompts and local paths. It stays on the
machine.

**Wrapping or proxying agent CLIs.** Pebble reads what they leave behind. Sitting
in the request path would make it something you have to trust.

**An LLM-powered insights panel.** The doctor is worth trusting *because* nothing
in it calls a model. A generated summary of your own dashboard is the kind of
feature that demos well and gets ignored by the second week.
