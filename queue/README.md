# Queue

One markdown file per task you thought of while something else was in flight.

Name them for what they are — `fix-session-filter-reset.md`, not `task-001.md`.
Six months later the filename is the only part you'll read.

Write the problem, not the implementation:

```markdown
# Clearing the project filter doesn't reset the URL

Selecting a project on the Fleet page navigates to
`#/sessions?project=…`. "Clear filters" empties the select but leaves the hash,
so a reload brings the filter back.

Should clear the hash too, and clearing from a deep link should land on #/sessions.
```

`/queue` picks the smallest unblocked one, dispatches the right agent, verifies,
and moves the file to `queue/done/`.

Nothing reads this directory automatically yet — see `docs/ROADMAP.md`.
