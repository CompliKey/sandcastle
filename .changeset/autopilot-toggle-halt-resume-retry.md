---
"@ai-hero/sandcastle": patch
---

`sandcastle ui` gains the autopilot ON/OFF toggle, the halt banner with a Resume affordance, and a Retry button on errored history rows.

**Backend.**
- New `AutopilotController` owns the lifecycle of a single in-process `OrchestrationLoop`. It exposes `start({ scenario })`, `stop()`, `resume()`, and `state()` over a small state machine — `off` ↔ `on` ↔ `halted`. The controller plumbs the loop's `logger` callback into live counters (attempted / completed / errored) so the UI can poll mid-run rather than waiting for the loop to settle.
- Resume always rebuilds the `FailureCoordinator` from scratch, which resets the consecutive-failure counter — the circuit breaker starts fresh on every resume so a halted run can recover without restarting the host process.
- `UiServer` adds `GET /api/autopilot`, `POST /api/autopilot/start` / `stop` / `resume`, and `POST /api/tickets/:id/retry`. Start defaults to the only scenario in the catalogue when omitted (mirrors the autopilot CLI). Retry calls `BacklogManagerHostInterface.clearErrored` first; only if that succeeds does it dispatch the scenario, so a failing label-strip never spawns a runaway run.
- `sandcastle ui` wires the controller automatically whenever `.sandcastle/main.ts` is loadable. Without it the new endpoints return 503 and the UI shows the existing read-only experience.

**Frontend.**
- AppShell autopilot pill is live: tri-state read on the controller status (off / on / halted) with click-to-start and click-to-stop. Halt is non-clickable on the toggle — the user must use the banner's Resume button (which preserves the halted run's scenario).
- Halt banner appears whenever `status === "halted"`, with the structured `haltReason` from `FailurePolicy` and a kind-aware suffix ("circuit breaker tripped" vs "infra-level failure"). Resume button restores the loop with the same scenario.
- History page renders an inline "↻ Retry" button on every errored / halted row. Click strips the agent-error label, posts a "retried by user" comment, dispatches the scenario, and navigates to the new live session view.
- Errored / halted rows also show the last error event's kind+reason inline, matching the Slice 0 wireframe's `session-row__error-detail` strip.
- A single `AutopilotProvider` hosts the 2s state-poll so the toggle and the banner share one round-trip.
