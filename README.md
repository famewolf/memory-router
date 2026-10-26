# memory-router — deterministic local memory router

New here? Start with `USER-GUIDE.md` (step-by-step setup and daily use).
This file is the internals reference: exact contracts and thresholds.

No LLM, no embeddings, no dependencies. Scores each user message against a
directory of curated Markdown files and injects the best matches into
context. Built for small local models that lack the priors to work without
retrieved context.

## What it is / is not

- It IS a keyword router over files you curate. Garbage in, garbage out —
  retrieval quality equals curation quality.
- It is NOT semantic search, NOT long-term memory that writes itself (except
  explicit capture directives, below), and NOT a replacement for the model's
  own context window.

## Directory contract (compatibility)

A replacement memory tree MUST keep every one of these, or the hook
misbehaves in specific, documented ways:

1. **Flat `.md` files directly in the memory dir.** Subdirectories are not
   indexed. The single exception is `captures/`, which is explicitly excluded
   (captured lines must never be re-indexed as topic files).
2. **Excluded name prefixes: `attic-`, `log-`, `capture-`.** Files with these
   prefixes are never indexed. Use them for archives and retired splits.
3. **Matching is case-sensitive substring against lowercased query terms.**
   Terms come from the user message: lowercased, split on non-alphanumerics,
   minimum 3 chars, English stopwords removed, first 8 kept. A file matches a
   term iff the term appears verbatim in the raw file text. Consequence:
   write lowercase-rich prose. An all-CAPS file is nearly invisible; match
   distinctive lowercase inflections too (`completed` covers a query for
   `complete`; bare `COMPLETE` matches nothing).
4. **Ranking is term-count with temporal decay and phrase bonus.** Score =
   (distinct query terms present + phrase bonus) × decay factor. Big files win
   ties on common words. Short files must carry distinctive vocabulary to
   surface. Temporal decay: files modified within 7 days get full score; older
   files decay to 0.5 over 90 days. Phrase bonus: +3 if the full query appears
   as an exact phrase. Simple stemming strips common suffixes (ing, ed, er, est, s)
   with doubled-consonant handling.
5. **Thresholds (constants in `index.js`):** `MIN_SCORE = 3` (a top file with
   fewer than 3 term hits injects nothing), `SEARCH_HITS = 10` (search tool
   returns up to 10), decide() reads the top 3, `INJECT_CAP = 4000` chars.
   With billion-context models, more context can be injected safely.
6. **Injected text is wrapped** in `<infra-memory>` tags with a pointer to
   the routing catalog — excerpts are pointers, and the model is told to read
   the catalog for routing.

## When it injects

- **Context hook**: every inbound user message is evaluated. If the top file
  scores ≥ 4, its excerpt is injected into that turn's context.
- **Dedupe**: at most one injection per user message per session (keyed on the
  user message id). Repeat evaluations of the same message log `deduped` and
  inject nothing.
- **Re-arm signals** (each sets `rearmed`, allowing exactly one more
  injection for the same message): `session.compacted`, the `compaction`
  hook, and `tool.execute.after` for the `compress` tool — all three mean the
  transcript was rewritten, so the previously injected text may be gone.
  Anything else (including aborts) does not re-arm.

## When it does NOT inject

- Score below 3 (`below-min-score`), no usable terms (`no-usable-terms`),
  or no file matched (`no-match`) — every decision records its reason in the
  debug log.
- The same user message was already served and nothing re-armed it.
- `captures/`, `attic-*`, `log-*`, `capture-*` contents are never indexed.

## Explicit capture

A user message matching an explicit directive (`remember this/that`,
`remember:`, `don't forget`, `do not forget`) appends the line to
`captures/` via the `prompt` hook. Bare "remember" in prose does not fire.
Captures are never indexed (see contract §1).

## Tools (model-facing)

- `infra_search` — keyword search, up to 10 files with match snippets.
- `infra_list` — list topic files.
- `infra_read` — read one topic file (capped).
- `infra_debug` — runtime toggle (debug logging, cache invalidation), status.

## Setup behavior (first run)

On setup the plugin ensures a usable memory tree:

- If the memory dir is missing, it is created.
- If it contains **no `.md` files at all**, the bundled `default-memory/`
  starter set is copied in. Files are never overwritten — an existing tree,
  even a single file, disables the install entirely.
- Edits to the tree take effect on their own (30s TTL + mtime/size cache);
  no restart needed for content changes.

The starter set (`default-memory/`): `agents.md` (pointer catalog — what
goes where), `gotchas.md` (known-error index pattern), `decisions.md`
(decision-log pattern), `hosts.md` (inventory TEMPLATE with RFC 5737
documentation addresses — replace with real hosts, never real secrets).

## Memory conventions (starter tree)

The bundled `default-memory/` starter set encodes these conventions:

- **Pointer catalog (`agents.md`):** one line per topic file, never inline prose. New topic files get a `when:` frontmatter line and a pointer entry.
- **Append-only decisions (`decisions.md`):** date, decision, reason. Revisit by appending, never rewriting.
- **Correction history:** when a fact changes, append `(superseded YYYY-MM-DD: <old value>)` instead of overwriting. Keeps the history of changed minds.
- **Deletion tracking:** when a fact is removed, replace with `(retired YYYY-MM-DD: <reason>)` instead of silently deleting.
- **Memory-first rule:** before investigating or rediscovering any fact, grep `memory/` FIRST. If the answer is already recorded, use it.
- **Cap:** <200 lines per file. Split when a file grows beyond it.
- **Ephemeral vs durable:** session work → scratch dir. Only durable facts (config decisions, gotchas, host facts) go into `memory/`.

## Scoring improvements (v1.1.0)

- **Temporal decay:** files modified within 7 days get full score; older files decay to 0.5 over 90 days.
- **Phrase bonus:** +3 score if the full query appears as an exact phrase in the file.
- **Simple stemming:** strips common suffixes (ing, ed, er, est, s) with doubled-consonant handling.
- **No new dependencies:** CPU-only, no embeddings. Files remain source of truth.

The plugin tree itself holds no personal data. The memory tree WILL (hosts,
decisions, logs) — that is its job. Before sharing anything that has ever
touched a real memory dir: keep secrets out of the tree entirely (reference
secret stores by name), and put inventory files on the agent's sensitive-path
deny list. The starter `hosts.md` template documents this at the top.
