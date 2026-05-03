---
"@ai-hero/sandcastle": patch
---

Add `FailurePolicy` + `FailureCoordinator` — the failure-classification module and JIRA error-labeling integration that the upcoming `sandcastle ui` autopilot loop relies on to skip ticket-level failures and halt on infra-level ones.

`classifyFailure({ category, message, consecutiveTicketLevelFailures }, { consecutiveFailureThreshold? })` is pure: no I/O, just a v1 classification table mapping each `FailureCategory` to `{ kind: "ticket-level" | "infra-level", action: "continue" | "halt", reason }`. Ticket-level categories cover `agent.max-iterations`, `agent.idle-timeout`, `agent.token-budget-exceeded`, `hook.ticket-bound.failed`, and `scenario.threw`. Infra-level categories cover `sandbox.provider.error`, `sandbox.container.start.failed`, `env.resolution.failed`, `hook.host.failed`, `spawn.failed`, and `config.load.failed`. The circuit breaker trips when consecutive ticket-level failures hit the threshold (default 3, configurable per scenario) — the boundary failure stays `kind: "ticket-level"` (so the ticket still gets labelled) but flips `action` to `"halt"` (so the queue stops).

`createFailureCoordinator({ backlogManager, policyConfig? })` is the thin stateful glue: it owns the running consecutive-failure counter and the call into `BacklogManagerHostInterface.markErrored`. Ticket-level failures call `markErrored({ id, reason, comment })` and increment the counter; infra-level failures don't touch the backlog manager and don't increment the counter. `noteSuccess()` resets it.

Both `classifyFailure` / `createFailureCoordinator` and their associated types are part of the public API surface.
