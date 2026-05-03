---
"@ai-hero/sandcastle": patch
---

Add `ScenarioRunner` + child-process scenario shim and a `sandcastle run-scenario` CLI subcommand — the core invocation primitive the upcoming `sandcastle ui` orchestration loop is built on.

`runScenario({ scenario, ticketId, configPath, store, signal? })` spawns a child process, streams structured events from the child over Node's IPC channel, and persists them to the `EventStore`. The parent owns `session.start` and `session.end`; child-side messages (`iteration.start` / `iteration.end` / `agent.text` / `agent.toolCall` / `commit` / `error` / `user.log`) are translated and stamped with `sessionId` / `laneId` / `timestamp`. Outcome mapping is honest: clean exit → `done`, non-zero or signalled exit → `errored`, parent-aborted (e.g. host SIGTERM) → `halted` regardless of how the child exits.

The child shim under `dist/scenarioChild.js` reads `SANDCASTLE_*` env vars set by the parent, loads the user's `defineSandcastle` config, fetches the ticket via the host-side backlog manager, builds a `ScenarioContext` with pre-wired `run` / `createSandbox` / `interactive` (auto-injecting `signal` and an IPC-forwarding `onAgentStreamEvent` callback) and a `log` helper, then invokes the named scenario. Iteration boundaries are inferred from transitions in the agent stream's `iteration` field — approximate but sufficient for the UI history view.

`sandcastle run-scenario <name> [--config <path>]` runs a single scenario invocation against the head of `backlogManager.listPending({ includeErrored: false })` and persists events to `.sandcastle/state/events-YYYY-MM.jsonl`. Host SIGTERM / SIGINT cleanly halts the in-flight child and writes a final `session.end { halted }`.

`runScenario`, `ScenarioRunnerOptions`, `ScenarioRunResult`, plus the `EventStore` factory + types are now part of the public API surface.
