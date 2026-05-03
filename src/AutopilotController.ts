/**
 * AutopilotController — the in-process state machine that owns the lifecycle
 * of a single {@link runOrchestrationLoop} invocation inside `sandcastle ui`.
 *
 * Three states:
 *  - `"off"`    → no loop is running.
 *  - `"on"`     → a loop is running; ticking through pending tickets.
 *  - `"halted"` → the last loop returned `status: "halted"`. The
 *                 `haltReason`/`haltKind` are preserved so the UI can render
 *                 them in the banner. Resuming creates a fresh
 *                 {@link FailureCoordinator}, which resets the circuit-breaker
 *                 counter to zero before re-entering `"on"`.
 *
 * The controller owns the running loop's `AbortController`. `stop()` aborts
 * it, the loop returns `status: "aborted"`, and the controller transitions
 * to `"off"`. A loop that finishes with `status: "halted"` transitions to
 * `"halted"`, preserving the per-attempt counters and the structured halt
 * reason from {@link FailurePolicy}.
 *
 * Counters are wired through the loop's `logger` callback so the UI can poll
 * `state()` mid-run for live "attempted / done / errored" totals — the loop
 * itself only returns these aggregates on completion.
 */

import {
  createFailureCoordinator,
  type FailureCoordinator,
} from "./FailureCoordinator.js";
import type { PolicyConfig } from "./FailurePolicy.js";
import {
  runOrchestrationLoop,
  type OrchestrationLoopResult,
  type OrchestrationLogger,
  type RunScenarioFn,
} from "./OrchestrationLoop.js";
import type { BacklogManagerHostInterface } from "./defineSandcastle.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type AutopilotStatus = "off" | "on" | "halted";

export interface AutopilotState {
  readonly status: AutopilotStatus;
  /** The scenario currently driving the loop (or driving it before the halt). */
  readonly scenario?: string;
  readonly startedAt?: number;
  readonly haltedAt?: number;
  readonly haltReason?: string;
  /**
   * `infra-level` if the halt came from an infra-failure or unknown category;
   * `ticket-level` if the circuit breaker tripped on consecutive ticket
   * failures. The UI surfaces these distinctly in the banner copy.
   */
  readonly haltKind?: "infra-level" | "ticket-level";
  readonly ticketsAttempted: number;
  readonly ticketsCompleted: number;
  readonly ticketsErrored: number;
}

export interface AutopilotControllerOptions {
  readonly backlogManager: BacklogManagerHostInterface;
  /** Same shape as `runScenario` passed to {@link runOrchestrationLoop}. */
  readonly runScenario: RunScenarioFn;
  readonly idlePollIntervalMs?: number;
  /** Test seam — defaults to {@link Date.now}. */
  readonly clock?: () => number;
  /** Notified after every state transition. */
  readonly onStateChange?: (state: AutopilotState) => void;
  readonly policyConfig?: PolicyConfig;
}

export interface AutopilotStartResult {
  readonly ok: true;
  readonly state: AutopilotState;
}

export interface AutopilotErrorResult {
  readonly ok: false;
  readonly error: string;
  /** HTTP status the UI server should return for this error. */
  readonly status: number;
}

export type AutopilotResult = AutopilotStartResult | AutopilotErrorResult;

export interface AutopilotController {
  state(): AutopilotState;
  start(args: { readonly scenario: string }): AutopilotResult;
  stop(): AutopilotResult;
  resume(): AutopilotResult;
  /** Aborts any in-flight loop and resolves once it exits. */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface ActiveRun {
  readonly abortController: AbortController;
  readonly done: Promise<OrchestrationLoopResult>;
  readonly coordinator: FailureCoordinator;
  readonly scenario: string;
}

const initialState = (): AutopilotState => ({
  status: "off",
  ticketsAttempted: 0,
  ticketsCompleted: 0,
  ticketsErrored: 0,
});

export const createAutopilotController = (
  options: AutopilotControllerOptions,
): AutopilotController => {
  const clock = options.clock ?? Date.now;
  let state: AutopilotState = initialState();
  let active: ActiveRun | null = null;

  const setState = (next: AutopilotState): void => {
    state = next;
    options.onStateChange?.(state);
  };

  const launch = (scenario: string): AutopilotResult => {
    const abortController = new AbortController();
    const coordinator = createFailureCoordinator({
      backlogManager: options.backlogManager,
      ...(options.policyConfig !== undefined
        ? { policyConfig: options.policyConfig }
        : {}),
    });

    setState({
      status: "on",
      scenario,
      startedAt: clock(),
      ticketsAttempted: 0,
      ticketsCompleted: 0,
      ticketsErrored: 0,
    });

    // Logger seam: the loop emits `autopilot.ticket.start` / `done` / `errored`
    // structured log events. We piggy-back on those to keep counters live for
    // the UI without altering the loop's return contract.
    const logger: OrchestrationLogger = (event) => {
      if (event === "autopilot.ticket.start") {
        setState({ ...state, ticketsAttempted: state.ticketsAttempted + 1 });
      } else if (event === "autopilot.ticket.done") {
        setState({ ...state, ticketsCompleted: state.ticketsCompleted + 1 });
      } else if (event === "autopilot.ticket.errored") {
        setState({ ...state, ticketsErrored: state.ticketsErrored + 1 });
      }
    };

    const done = runOrchestrationLoop({
      scenario,
      backlogManager: options.backlogManager,
      failureCoordinator: coordinator,
      runScenario: options.runScenario,
      signal: abortController.signal,
      ...(options.idlePollIntervalMs !== undefined
        ? { idlePollIntervalMs: options.idlePollIntervalMs }
        : {}),
      logger,
    }).then((result) => {
      // The loop only flips onto a halted state when the policy says so; an
      // aborted result means the operator pressed stop (or the process is
      // shutting down). Either way, clear `active` first so a follow-up
      // start() finds a clean slot.
      if (active?.abortController === abortController) active = null;
      if (result.status === "halted") {
        const haltKind: "infra-level" | "ticket-level" =
          /consecutive ticket-level failures/.test(result.reason)
            ? "ticket-level"
            : "infra-level";
        setState({
          status: "halted",
          scenario,
          haltedAt: clock(),
          haltReason: result.reason,
          haltKind,
          ticketsAttempted: result.ticketsAttempted,
          ticketsCompleted: result.ticketsCompleted,
          ticketsErrored: result.ticketsErrored,
        });
      } else {
        setState({
          status: "off",
          ticketsAttempted: result.ticketsAttempted,
          ticketsCompleted: result.ticketsCompleted,
          ticketsErrored: result.ticketsErrored,
        });
      }
      return result;
    });

    active = { abortController, done, coordinator, scenario };
    return { ok: true, state };
  };

  return {
    state: () => state,

    start({ scenario }) {
      if (state.status === "on") {
        return {
          ok: false,
          error: "autopilot is already running",
          status: 409,
        };
      }
      if (state.status === "halted") {
        return {
          ok: false,
          error: "autopilot is halted — call /api/autopilot/resume",
          status: 409,
        };
      }
      if (typeof scenario !== "string" || scenario.length === 0) {
        return {
          ok: false,
          error: "scenario must be a non-empty string",
          status: 400,
        };
      }
      return launch(scenario);
    },

    stop() {
      if (state.status === "off") {
        return { ok: true, state };
      }
      // From halted there's no live loop to abort — just transition to off.
      if (state.status === "halted") {
        setState({
          status: "off",
          ticketsAttempted: state.ticketsAttempted,
          ticketsCompleted: state.ticketsCompleted,
          ticketsErrored: state.ticketsErrored,
        });
        return { ok: true, state };
      }
      // status === "on": abort and let the loop's settle handler flip state.
      // We pre-empt with an "off" transition immediately so a poll between
      // abort and loop-resolution does not show stale "on".
      const current = active;
      if (current) {
        current.abortController.abort();
      }
      setState({
        status: "off",
        ticketsAttempted: state.ticketsAttempted,
        ticketsCompleted: state.ticketsCompleted,
        ticketsErrored: state.ticketsErrored,
      });
      return { ok: true, state };
    },

    resume() {
      if (state.status !== "halted") {
        return {
          ok: false,
          error: `cannot resume from status "${state.status}"`,
          status: 409,
        };
      }
      const scenario = state.scenario;
      if (!scenario) {
        // Should never happen — we always preserve scenario through halt — but
        // a defensive check beats a confusing TypeError downstream.
        return {
          ok: false,
          error: "no scenario recorded for the halted run",
          status: 500,
        };
      }
      // Drop the halted state before relaunching so the launch's `setState`
      // sequence reads from a clean slot.
      setState(initialState());
      return launch(scenario);
    },

    async shutdown() {
      const current = active;
      if (!current) return;
      current.abortController.abort();
      try {
        await current.done;
      } catch {
        // Loop swallows its own errors and returns a result; this catch is
        // belt-and-braces for unexpected throws so shutdown stays graceful.
      }
    },
  };
};
