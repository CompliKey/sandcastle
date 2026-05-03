---
"@ai-hero/sandcastle": patch
---

`sandcastle ui` gains a queue view and manual-mode single-ticket invocation with per-run override panel.

**Backend.**
- `UiServer` adds `GET /api/queue` (lists pending tickets via the configured `BacklogManagerHostInterface.listPending`), `GET /api/scenarios` (the named scenarios from the user's `defineSandcastle({ scenarios })` config + their default `maxIterations`), and `POST /api/run-scenario` (triggers a single-ticket run with optional overrides). All three are wired automatically by `sandcastle ui` whenever `.sandcastle/main.ts` is loadable; otherwise the server runs in history-only mode.
- `ScenarioRunner` accepts a `ScenarioOverrides` object (`maxIterations`, `model`, `promptArgs`) and forwards it to the scenario child as a single JSON-encoded env var.
- `ScenarioContext` gains an `overrides` field. The wiring layer auto-applies `maxIterations` (replaces the scenario value) and `promptArgs` (shallow-merge, manual values win) at the `ctx.run` / `ctx.createSandbox` boundaries, so existing scenarios pick up override semantics for free. Scenarios that want to honour a `model` override read `ctx.overrides.model` themselves and pass it into their agent provider factory.
- `runScenario` adapter on `UiServer` returns `{ sessionId, done }` so the UI receives the assigned session id immediately and the long-running scenario continues in the background — no HTTP timeout coupling.

**Frontend.**
- New `/queue` route mirrors the Slice 0 wireframe: filter bar, ordered list of pending tickets with priority chips and labels, per-row "Run with overrides…" / "▶ Run now" actions, refresh button.
- "Run with overrides…" opens a modal sheet (Escape / backdrop dismiss) with scenario picker, model select (defaults to "scenario default"), max-iterations field (placeholder shows the scenario default), and a free-form prompt-args JSON textarea with inline validation. "Run now" submits with no overrides.
- Successful submit navigates to the live session view for the new session id; the existing live-session WebSocket subscription and event-log bridge handle event streaming with no change.
- Manual-mode invocation works whether autopilot is ON or OFF — both share the same `EventStore` on disk.
