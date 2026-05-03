/**
 * OrchestrationLoop — the autopilot drain-and-classify loop owned by the
 * sandcastle binary.
 *
 * Pulls the next pending ticket via {@link BacklogManagerHostInterface.listPending},
 * invokes the configured scenario via the injected `runScenario`, and routes the
 * outcome through a {@link FailureCoordinator}:
 *
 *  - `done`    → counter reset, advance to the next ticket.
 *  - `errored` → mapped to category `scenario.threw` (ticket-level by default
 *                in v1), coordinator labels the ticket and decides
 *                continue-or-halt via the circuit breaker.
 *  - `halted`  → user-requested abort (parent forwarded SIGTERM/SIGINT to the
 *                child); the loop exits cleanly *without* counting this as a
 *                policy halt.
 *
 * Empty queue → idle for `idlePollIntervalMs` (default 5s), then re-poll. The
 * loop never exits on an empty queue — that's how a long-running autopilot
 * survives gaps between human triage and the agent picking work back up.
 *
 * Pre-flight failures (listPending throws, runScenario throws synchronously)
 * are treated as infra-level halts: the host environment is broken; we do
 * NOT label any ticket on its behalf.
 *
 * The category-mapping rule for in-loop errors is deliberately coarse at v1:
 * everything that looks like a child crash falls into `scenario.threw`. Future
 * slices can refine this by extending the IPC protocol so the child reports
 * a richer `FailureCategory` before exit.
 */

import type { BacklogManagerHostInterface } from "./defineSandcastle.js";
import type { FailureCoordinator } from "./FailureCoordinator.js";
import type { ScenarioRunResult } from "./ScenarioRunner.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface RunScenarioArgs {
  readonly scenario: string;
  readonly ticketId: string;
}

export type RunScenarioFn = (
  args: RunScenarioArgs,
) => Promise<ScenarioRunResult>;

export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>;

export type OrchestrationLogger = (
  event: string,
  data?: Record<string, unknown>,
) => void;

export interface OrchestrationLoopOptions {
  /** Scenario name as keyed in the user's `defineSandcastle({ scenarios })`. */
  readonly scenario: string;
  readonly backlogManager: BacklogManagerHostInterface;
  readonly failureCoordinator: FailureCoordinator;
  /**
   * Injected scenario-invocation. In production this is a bound `runScenario`
   * (from `ScenarioRunner.ts`) with `configPath`, `store`, and `signal`
   * pre-applied. Tests inject a fake.
   */
  readonly runScenario: RunScenarioFn;
  /** Aborting this signal exits the loop with `status: "aborted"`. */
  readonly signal: AbortSignal;
  /** Default: {@link DEFAULT_IDLE_POLL_INTERVAL_MS}. */
  readonly idlePollIntervalMs?: number;
  /** Test seam — defaults to a setTimeout-backed sleep that respects `signal`. */
  readonly sleep?: SleepFn;
  /** Optional structured-event sink for telemetry / future UI bridging. */
  readonly logger?: OrchestrationLogger;
}

export type OrchestrationLoopStatus = "halted" | "aborted";

export interface OrchestrationLoopResult {
  /**
   * `halted` — a structured halt (infra-level failure, circuit-breaker trip,
   * markErrored failure). Surface to the operator as a "queue stopped" banner.
   * `aborted` — the loop exited because its `signal` was aborted (Ctrl-C, host
   * shutdown, scenario-level halt). Routine; not an alert.
   */
  readonly status: OrchestrationLoopStatus;
  /** Human-readable reason matching the cause. */
  readonly reason: string;
  /** Number of distinct tickets the loop attempted to invoke. */
  readonly ticketsAttempted: number;
  /** Tickets that finished with `outcome === "done"`. */
  readonly ticketsCompleted: number;
  /** Tickets that finished with `outcome === "errored"`. */
  readonly ticketsErrored: number;
}

export const DEFAULT_IDLE_POLL_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// Default sleep — setTimeout that resolves early on abort.
// ---------------------------------------------------------------------------

const defaultSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export const runOrchestrationLoop = async (
  options: OrchestrationLoopOptions,
): Promise<OrchestrationLoopResult> => {
  const idlePoll = options.idlePollIntervalMs ?? DEFAULT_IDLE_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const log: OrchestrationLogger = options.logger ?? (() => {});

  let ticketsAttempted = 0;
  let ticketsCompleted = 0;
  let ticketsErrored = 0;

  const aborted = (reason: string): OrchestrationLoopResult => ({
    status: "aborted",
    reason,
    ticketsAttempted,
    ticketsCompleted,
    ticketsErrored,
  });

  const halted = (reason: string): OrchestrationLoopResult => ({
    status: "halted",
    reason,
    ticketsAttempted,
    ticketsCompleted,
    ticketsErrored,
  });

  while (!options.signal.aborted) {
    let pending: readonly { id: string }[];
    try {
      pending = await options.backlogManager.listPending();
    } catch (err) {
      const reason = `listPending failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      log("autopilot.halt", { reason, kind: "infra-level" });
      return halted(reason);
    }

    if (options.signal.aborted) break;

    if (pending.length === 0) {
      log("autopilot.idle", { intervalMs: idlePoll });
      await sleep(idlePoll, options.signal);
      continue;
    }

    const ticket = pending[0]!;
    ticketsAttempted += 1;
    log("autopilot.ticket.start", {
      ticketId: ticket.id,
      scenario: options.scenario,
    });

    let runResult: ScenarioRunResult;
    try {
      runResult = await options.runScenario({
        scenario: options.scenario,
        ticketId: ticket.id,
      });
    } catch (err) {
      // runScenario itself threw — never expected (the runner catches its own
      // errors and reports via outcome). Treat as infra-level: we don't trust
      // the host to label tickets when the scenario layer is broken.
      const reason = `runScenario threw: ${
        err instanceof Error ? err.message : String(err)
      }`;
      log("autopilot.halt", {
        reason,
        kind: "infra-level",
        ticketId: ticket.id,
      });
      return halted(reason);
    }

    if (runResult.outcome === "halted") {
      log("autopilot.aborted", {
        ticketId: ticket.id,
        sessionId: runResult.sessionId,
      });
      return aborted("scenario halted");
    }

    if (runResult.outcome === "done") {
      ticketsCompleted += 1;
      options.failureCoordinator.noteSuccess();
      log("autopilot.ticket.done", {
        ticketId: ticket.id,
        sessionId: runResult.sessionId,
      });
      continue;
    }

    // outcome === "errored" — coarse category mapping at v1.
    ticketsErrored += 1;
    let handled;
    try {
      handled = await options.failureCoordinator.handleFailure({
        ticketId: ticket.id,
        category: "scenario.threw",
        message: `scenario exited with code ${runResult.exitCode ?? "null"} signal ${runResult.signal ?? "null"} (session ${runResult.sessionId})`,
      });
    } catch (err) {
      // Backlog system is unreachable — we can neither label this ticket nor
      // trust further attempts, so halt with infra-level reason.
      const reason = `failureCoordinator.handleFailure failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      log("autopilot.halt", {
        reason,
        kind: "infra-level",
        ticketId: ticket.id,
      });
      return halted(reason);
    }

    log("autopilot.ticket.errored", {
      ticketId: ticket.id,
      kind: handled.kind,
      action: handled.action,
      reason: handled.reason,
    });

    if (handled.action === "halt") {
      return halted(handled.haltReason ?? handled.reason);
    }
  }

  return aborted("signal aborted");
};
