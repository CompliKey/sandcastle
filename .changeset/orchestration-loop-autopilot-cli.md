---
"@ai-hero/sandcastle": patch
---

Add `runOrchestrationLoop` + `sandcastle autopilot` CLI — the binary-owned drain loop that ties Slices 1–5 together into the user-visible autopilot.

`runOrchestrationLoop({ scenario, backlogManager, failureCoordinator, runScenario, signal, idlePollIntervalMs?, sleep?, logger? })` pulls the next pending ticket via `BacklogManagerHostInterface.listPending`, invokes the scenario via the injected `runScenario`, and routes the outcome through the `FailureCoordinator`:

- `done` → counter reset, advance to the next ticket.
- `errored` → mapped to category `scenario.threw` (ticket-level by default at v1), the coordinator labels the ticket `agent-error` and decides continue-or-halt via the circuit breaker.
- `halted` → the user requested abort (parent forwarded SIGTERM/SIGINT to the child); the loop exits cleanly without counting this as a policy halt.

On an empty queue the loop idles for `idlePollIntervalMs` (default 5s) and re-polls — it never exits on an empty queue, so the future UI sees a live process during gaps. Pre-flight failures (`listPending` throws, `runScenario` throws synchronously, `markErrored` throws) are treated as infra-level halts: the host environment is broken and we do not label any ticket on its behalf.

`sandcastle autopilot [--scenario=<name>] [--idle-poll-ms=<ms>] [--config=<path>]` is the CLI surface. `--scenario` is optional when the config defines exactly one scenario; otherwise it is required. The command loads the user's `defineSandcastle({...})` config, wires real backlog manager + event store + signal forwarding into the loop, and prints a final attempted/done/errored summary on halt or abort.

`runOrchestrationLoop`, its types (`OrchestrationLoopOptions`, `OrchestrationLoopResult`, `OrchestrationLoopStatus`, `OrchestrationLogger`, `RunScenarioArgs`, `RunScenarioFn`, `SleepFn`), and the `DEFAULT_IDLE_POLL_INTERVAL_MS` constant are part of the public API surface.
