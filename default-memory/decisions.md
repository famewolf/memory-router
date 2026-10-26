# Decisions — durable choices and why

when: decision, choice, architecture, "why did we", tradeoff, ADR

Append-only. Each entry: date, decision, reason. Revisit by appending a new
entry, never by rewriting the old one — the history of *changed minds* is
the valuable part.

## Correction history

When a decision is reversed or updated, append a new entry with the new
decision and reason. Mark the old entry `(superseded YYYY-MM-DD: <new decision>)`
so future sessions can see the evolution. Never delete old entries — the
history of changed minds is the valuable part.

## Entries (template — replace with real ones)

- `SAMPLE 2026-01-01: tool X over tool Y for deploys (X retries cleanly; Y half-applies).`