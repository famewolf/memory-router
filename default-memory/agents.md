# Agents — memory routing catalog

when: memory routing, pointer catalog, where-facts-live lookup

This file is the pointer catalog for the curated memory tree. It does not
hold facts; it says where facts live. Keep entries to one line each. When a
new topic file is added, add one line here or it will be found only by luck.

## How this tree is used

The `memory-router` plugin scores each user message against every `.md` file
in this directory and injects the best matches into context. Mechanics,
thresholds, and the compatibility contract live in the plugin README.

## Memory-first rule (mandatory)

Before investigating, debugging, or rediscovering ANY fact, grep this tree
FIRST. If the answer is already recorded, use it — do not re-derive. The
answer was there; you didn't look. Applies to ALL questions, not just errors.

## Where things live

- Error signatures, what fixed them, what they cost → `gotchas.md`
- Durable decisions and why they were made → `decisions.md`
- Hosts, subnets, connection methods (no secrets, ever) → `hosts.md`
- Session scratch, todos, and cleanup convention → `sessions.md`
- Task completion terminator, exact form and when to emit it → `task-completion.md`
- This catalog itself → `agents.md` (this file)

## Conventions

- **Correction history:** When a durable fact changes, do NOT silently
  overwrite. Append `(superseded YYYY-MM-DD: <old value>)` so future sessions
  can see why it changed. Applies to config decisions, host facts, gotchas,
  and any entry carrying a concrete value.
- **Deletion tracking:** When a durable fact is removed, replace it with
  `(retired YYYY-MM-DD: <reason>)` instead of silently deleting the line.
  Search stops returning it as active, but the deletion is written down.
- **Append-only decisions:** Each entry: date, decision, reason. Revisit by
  appending a new entry, never by rewriting the old one — the history of
  *changed minds* is the valuable part.
- **Cap:** <200 lines per file. Split when a file grows beyond it.
- **`when:` frontmatter:** Each topic file starts with a `when:` line naming
  the trigger(s) that route to it.