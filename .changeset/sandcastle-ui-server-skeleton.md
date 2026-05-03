---
"@ai-hero/sandcastle": patch
---

Add `sandcastle ui` — a local HTTP+WS server with a bundled Vite/React/Radix frontend. First slice with a UI, focused on read-only history.

**Backend.** New `UiServer` module (`startUiServer({ index, assetsDir?, host?, port?, version? })`) wraps Node's `http.Server` around a populated `SessionIndex` and exposes:

- `GET /api/health` — `{ application: "sandcastle", pid, startedAt, version }`. Used by the single-instance handoff to confirm a running server is ours before opening a new browser tab against it.
- `GET /api/sessions` — newest-first session list, supports `?limit` and `?since`.
- `GET /api/sessions/:id` — single session.
- `GET /api/tickets/:id/sessions` — sessions for a ticket.
- `GET /ws` — WebSocket upgrade handshake. Slice 7 accepts and immediately closes; slice 8 wires up live event push.
- Static assets from `assetsDir` with SPA fallback (`/anything` → `index.html`) and immutable cache-control on hashed bundles. When `assetsDir` is missing, a placeholder page lists the live API endpoints.

`probeExistingServer(url)` checks `/api/health` and confirms `application === "sandcastle"` — the trust boundary for the lockfile-based single-instance protocol. The lockfile lives at `.sandcastle/state/ui.lock` and is purely advisory.

**CLI.** `sandcastle ui [--no-open] [--port=<n>] [--host=<h>] [--assets-dir=<dir>]` boots the server in the foreground. A second invocation reads the lockfile, probes the existing server, and either opens a new browser tab against it or — if the lockfile is stale — cleans up and tries to bind itself. Closing the controlling terminal kills the server cleanly (SIGTERM/SIGINT/SIGHUP all trigger `server.close() + lockfile cleanup`).

**Frontend.** A Vite project under `src/ui/` (built by `npm run build` to `dist/ui/`) ships a React + Radix UI app with two routes: `/` (history list, populated from `GET /api/sessions`, with status filter chips and freeform search) and `/sessions/:id` (placeholder; slice 8 fills in the live timeline). Layout, typography, and tokens follow the wireframes from VGD-133 (`docs/design/sandcastle-ui-wireframes/`).
