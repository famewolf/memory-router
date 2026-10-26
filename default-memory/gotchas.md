# Gotchas — known-error index

when: error, failure, "not working", bug, crash, exception, traceback, broken

One line per error signature: what it looked like, where the fix is, what
it cost. Newest at the bottom. When an error repeats in a session, this file
is the first place to look — a repeated error without consulting it first is
a process failure, not bad luck.

## Correction history

When a gotcha is corrected (the fix changed, the cause was different than
initially thought), append `(superseded YYYY-MM-DD: <old fix/cause>)` instead
of overwriting. When a gotcha is retired (no longer applies), replace with
`(retired YYYY-MM-DD: <reason>)`. Search stops returning retired entries
as active, but the deletion is written down.

## Format

- `<exact error fragment>` → `<file or command that fixes it>` (cost: `<time wasted>`)

## Entries (template examples — replace with real ones)

- `SAMPLE: command not found after tool move` → `bin/ wrapper on PATH` (cost: 20 min)
- `SAMPLE: schema validation failed on child session` → `grep own plugin tree for request mutation before blaming upstream` (cost: days)