---
"@ai-hero/sandcastle": patch
---

Add `EventStore` and `SessionIndex` — the persistence layer for the upcoming `sandcastle ui` history surface.

`EventStore` is an append-only JSONL writer under `.sandcastle/state/events-YYYY-MM.jsonl` with monthly file rotation, single-writer semantics, replay-from-cursor, and a polling `tail` for new events. The replay path skips a crash-truncated trailing line in the most recent file but throws on mid-file corruption.

`SessionIndex` is a pure in-memory derivation: given a stream of events (live via `add` or replayed from disk), it builds ticket-bounded sessions with iteration trees and answers `getSession`, `listByTicket`, `listSessions({ since, limit })`, and `getRollups({ type: "session" | "ticket", ... })`. Per-session rollups carry token totals (input/output/cache-creation/cache-read), iteration count, and wall time; per-ticket rollups add session count, total wall time, average iterations per session, and time-to-close (first session start → latest done-session end).

Every persisted event carries `laneId` (always `"main"` in v1) so future parallel-autopilot work is purely additive.
