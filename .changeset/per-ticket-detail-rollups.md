---
"@ai-hero/sandcastle": patch
---

`sandcastle ui` gains a per-ticket detail page with aggregate rollups across every session for the ticket.

**Backend.**
- New `GET /api/tickets/:id` returns `{ ticketId, sessions, rollup }` where `rollup` is the existing `TicketRollup` from `SessionIndex.getRollups({ type: "ticket", ticketId })`: total tokens (broken into input / output / cache-creation / cache-read), total iterations, total wall time across sessions, average iterations per session, and time-to-close (earliest `session.start` to latest `session.end` with `outcome === "done"`). Returns 404 when no session has been recorded for the ticket. The legacy `GET /api/tickets/:id/sessions` route is kept for backwards compatibility.

**Frontend.**
- New `/tickets/:ticketId` route renders the ticket card (id + latest outcome badge, first/closed/time-to-close meta), a five-up aggregates row (Sessions, Total wall time, Avg iterations, Total commits, Total tokens), and the per-session list. Layout mirrors `docs/design/sandcastle-ui-wireframes/ticket-detail.html`.
- History list rows now navigate to `/tickets/:id` instead of `/sessions/:id` (per the Slice 0 wireframes — clicking a row goes to the ticket, not directly to one session). The session-detail page is still reachable from the per-ticket sessions list.
- `formatIterations` in the history row now consumes `rollup.maxIterations` when present, so rows can render `5 / 12` instead of `5 / —` for sessions whose `session.start` event carried the cap.
- New `formatLongDuration` helper renders `hh:mm:ss` for ticket-level wall times that cross the hour mark; the per-row `formatDuration` continues to render `mm:ss`.
