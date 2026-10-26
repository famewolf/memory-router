# Sessions — scratch, todos, and cleanup convention

Every session works inside exactly one scratch subdir named for its
session id. Nothing session-private is ever written outside it, and no
session ever deletes outside its own subdir.

## Layout

- Ephemeral scratch: `/tmp/opencode/<session-id>/`
  - `todos.json` — the agent's working checklist (see below).
  - Anything regenerable: probe scripts, dumps, downloads, build outputs.
- Durable findings: your notes directory (NOT scratch) — investigation
  record worth keeping across sessions. Findings may mention todos; they
  never own todo state.

## Todos (`todos.json`)

- Schema: `{ "todos": [{ "id": 1, "text": "...", "status": "pending" }] }`.
  Status is one of `pending`, `in_progress`, `done`, `cancelled`.
- Missing file means fresh slate — stated, never an error. A live session
  can outlive its scratch (reboot, reaping); re-add anything still in
  flight and say so.
- One session reads only its own file. Other sessions' files are inert.

## Cleanup

- Who removes scratch: NOBODY, routinely — the sweep does (see below).
- The only permitted delete is recursive removal of YOUR OWN session
  subdir. Never the shared root, never globs, never date-sweeps across
  sessions. A cleanup that addresses shared state is how bulk deletions
  happen; this convention removes the need for one.
- Check first whether your scratch root is real or symlinked:
  `ls -la /tmp/opencode`. A real tmpfs directory is wiped on reboot and
  reaped after ~10 idle days by the OS — the sweep is then a backstop. A
  symlink to persistent storage gets NO automatic cleanup — the sweep is
  the only cleanup. Know which one you have.

## The sweep (standalone script, dry-run by default)

- Deletes ONLY `<session-id>/` subdirs that are BOTH unmodified for 10+
  days AND absent from the live session list. Files directly under the
  root, non-session names, and anything else are never candidates.
- Server unreachable means delete nothing (fail closed). Double-runs are
  safe (deleting an already-gone dir is a no-op).
- Usage: run with no args to preview, `--apply` to act. Re-run after
  applying should report zero candidates.

## Retention for durable findings (adjustable defaults)

Findings are never auto-deleted. Suggested policy, set your own numbers:
untouched 90+ days → compress into an `attic/` archive; attic older than
a year → delete. Until a janitor exists for these, it is a manual pass.
