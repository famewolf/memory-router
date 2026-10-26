# infra-memory + session hygiene — user guide

Step-by-step setup and daily use for a new user. Assumes opencode v2 with
the `infra-memory` plugin installed. No prior knowledge of the internals;
for those, see `README.md`.

## Part 1 — First run (5 minutes)

### Step 1: Confirm the plugin loads

1. Restart opencode (or reload plugins).
2. In the log, look for one line like:
   `loaded (memory dir /home/YOU/.config/opencode/memory) hooks=3`
   (One line per restart is normal. Two identical lines seconds apart means
   a twin evaluation — harmless, logged once by design.)
3. If the line is missing, the plugin did not load: check that your
   `opencode.jsonc` `plugin` array contains the `infra-memory` package path.

### Step 2: Check your memory tree

1. Look at `~/.config/opencode/memory/`.
2. **If it already has `.md` files**, stop here — the plugin leaves existing
   trees completely alone. Skip to Part 2.
3. **If it is missing or has no `.md` files**, the plugin copies in the
   bundled starter set on first run: `agents.md` (what goes where),
   `gotchas.md` (error index), `decisions.md` (decision log), `hosts.md`
   (inventory TEMPLATE — replace the `192.0.2.x` examples with real hosts,
   never real secrets).
4. Verify: `ls ~/.config/opencode/memory/*.md` shows the four files.

### Step 3: Send a normal message and watch what happens

1. Ask anything related to a topic in your files.
2. The hook evaluates every user message. On a strong match it injects a
   short excerpt into that turn's context — you do not need to do anything.
3. To see the machinery: use the `infra_debug` tool with `action=status`
   (shows last decision), or `action=test` with a `query` (shows terms,
   score, hits, and whether it would inject).
4. No injection on a message you expected one for? Check, in order:
   a. `infra_debug` → `action=test`, your query: is the score below 4?
      Below 4 means the vocabulary didn't overlap — add the missing words
      (lowercase) to the relevant file.
   b. Was the same message already served? Repeat evaluations log `deduped`
      and stay silent by design.
   c. Was there a compaction recently? That re-arms exactly once, then
      dedupes again.

## Part 2 — Daily use: todos without the todo plugin

> If a todo-capable tool (`todo`/`todowrite`) exists, the plugin stays out:
> no fallback is registered. Everything below applies only when it steps in.

### Step 4: See work status

1. Run `/todo` to post the list into the conversation (the fallback `todo` tool manages it). First run on a fresh session:
   `No session todos yet (fresh slate).`
2. That message is load-bearing: it means "no file", not "all done". After
   a reboot, a live session shows the same slate — its scratch did not
   survive. Re-add anything still in flight.

### Step 5: Track work

1. Ask the model (or the `todo` tool directly) with `action=add`, `text="short verb-first description"`.
   Items start `pending` and get numbers (`#1`, `#2`).
2. Starting work: `action=start`, `id=<number>` → `in_progress`.
3. Finishing: `action=done`, `id=<number>` → `done`.
4. `action=list` (the default) reprints the list any time.
5. State lives at `/tmp/opencode/<your-session-id>/todos.json`.
   One session reads only its own file — never another session's.

### Step 6: End of session

Nothing. Seriously: close the session and walk away. Session scratch is
**session-scoped by design** — it is allowed to die with the session, and
the janitor (Part 3) reaps it later. Durable notes (what was found, what
was decided) belong in your session findings, not in todos.

### Step 6b: Durable findings (survive beyond a session)

Session scratch dies with the session. Durable findings — investigation
records, decisions, facts worth keeping — belong in a **findings directory**
outside scratch, one file per task:

1. Create `<your-notes-dir>/<task>_findings.md` **before** any other work.
2. Put every known task and every user question on both your todo list and
   the findings file.
3. Update the findings file as you work — append each verified fact.
4. Prune at handoff/compaction: drop answered questions, keep what the
   next step needs.
5. State the findings file path in your first response so the next session
   can find it.

## Part 3 — Cleanup: the sessions sweep (monthly, 2 minutes)

Session scratch accumulates: every session leaves a subdir. Who removes it
depends on one fact — check it first:

`ls -la /tmp/opencode` — symlink or real directory?

- **Real directory on tmpfs (the normal case).** Reboots wipe it and the
  OS reaps anything unmodified for 10+ days. The sweep below is then a
  backstop: it covers restarts-without-reboot and immediate cleanup, but
  skipping a month harms nothing.
- **Symlink to persistent storage (a deliberate choice to KEEP session
  work across reboots).** Nothing cleans this automatically — the sweep is
  the ONLY cleanup. Skipping it grows the tree without bound.

### Step 7: Preview (always first)

1. Run: `sessions-sweep.sh` (no args = dry run, deletes nothing).
2. Read the output: each line is `would delete <dir> (age Nd)` or
   `keep <dir> (age Nd, session live)`.
3. Sanity rule: every listed path starts with your scratch root and names a
   `ses_*` session. Files directly under the root and non-session names are
   never candidates — if you see anything else, stop and report it.

### Step 8: Apply

1. Run: `sessions-sweep.sh --apply`.
2. Only the previewed candidates are removed. Re-running immediately should
   report `candidates: 0`.
3. Deleted items: subdirectories unmodified 10+ days whose session is absent
   from the live session list. If the server is unreachable, the script
   deletes nothing (fail closed) — fix connectivity, then re-run.

### Step 9: Retention for durable files (your call, once)

Session *findings* (reports, notes worth keeping) live outside scratch and
are never auto-deleted. Suggested policy, adjust to taste: untouched 90+
days → compress into an `attic/` tarball; attic older than a year → delete.
There is no janitor for this yet — it is a manual pass until one exists.

## Part 4 — Memory discipline (new)

### Correction history

When a durable fact changes, do NOT silently overwrite. Append the old value:
`(superseded YYYY-MM-DD: <old value>)`. This keeps the history of what was
believed before, so future sessions can see why a value changed.

Example:
```
- Plugin X: uses model Y (superseded 2026-10-25: model Z)
```

### Deletion tracking

When a durable fact is removed (plugin retired, host decommissioned), do NOT
silently delete the line. Replace with `(retired YYYY-MM-DD: <reason>)`.

Example:
```
- Plugin X: (retired 2026-10-25: archived, upstream merged fix)
```

### Memory-first rule

Before investigating, debugging, or rediscovering ANY fact, grep `memory/`
and `permanent_files/findings/` FIRST. If the answer is already recorded, use
it — do not re-derive.

### Scoring improvements (v1.1.0)

The router now uses:
- **Temporal decay**: files modified within 7 days get full score; older files
  decay to 0.5 over 90 days. Prefers recent gotchas/config.
- **Phrase bonus**: +3 score if the full query appears as an exact phrase.
- **Simple stemming**: strips common suffixes (ing, ed, er, est, s) with
  doubled-consonant handling. "running" matches "run", "stopped" matches "stop".

| Symptom | Check |
|---|---|
| Two `todo` tools offered | A todo plugin is also installed. The fallback should have stayed out — report the loaded tool list (the fallback keys off live tools, not the plugin inventory). |
| `/todo` shows a blank slate mid-task | Scratch lost (reboot/reap) while the session survived. Re-add live items; this is the documented reboot-orphan edge. |
| Sweep deletes nothing, ever | Normal if sessions churn weekly — 10-day age needs actual idleness. Check `candidates:` count; zero with young dirs is correct. |
| Sweep refuses everything | Server unreachable → fail closed. Verify the server is up, then re-run. |
| Memory injects noise | Score was ≥ 4 on shared vocabulary. Narrow the file's wording or split the topic; check `action=test` to see which terms matched. |
| Memory never injects | `action=test` your query: score < 4 (add overlapping lowercase terms), `deduped` (already served this message), or `no-usable-terms` (query too short/generic). |

## What lives where (cheat sheet)

- Plugin code: `<opencode-config>/opencode/plugins/infra-memory/`
- Starter tree: `.../infra-memory/default-memory/` (installed once, never overwrites)
- Your tree: `~/.config/opencode/memory/` (yours; the plugin only reads)
- Session scratch: `/tmp/opencode/<session-id>/` (one subdir per session; only yours to delete)
- Sweep script: `<opencode-config>/opencode/bin/sessions-sweep.sh`
- Debug log: `~/opencode/findings/infra-memory-debug.jsonl` (new installs; older logs kept the previous name as archive)
