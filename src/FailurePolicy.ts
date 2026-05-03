/**
 * FailurePolicy — pure classification of scenario-invocation failures.
 *
 * No I/O. Inputs: a categorised failure plus the count of preceding consecutive
 * ticket-level failures. Output: a {@link FailureClassification} the caller
 * acts on.
 *
 * Categories split into two kinds:
 *  - **ticket-level**: the ticket is unworkable in this run, but the queue can
 *    move on. Caller is expected to label the ticket `agent-error` and
 *    continue.
 *  - **infra-level**: the host environment is broken. The whole queue must
 *    halt. Caller MUST NOT mark the ticket — the failure is not the ticket's
 *    fault.
 *
 * Circuit breaker: when consecutive ticket-level failures hit
 * {@link PolicyConfig.consecutiveFailureThreshold} (default 3), the
 * classification still reports `kind: "ticket-level"` (the ticket itself is
 * still a ticket-level failure and should be labelled), but flips `action` to
 * `"halt"` so the queue stops instead of grinding through more bad runs.
 *
 * `reason` vs `haltReason`:
 *  - `reason` is the per-ticket failure summary, always derived from the
 *    category. It is what `markErrored.reason` will receive verbatim, so it
 *    must stay greppable across runs (e.g. `"agent hit max iterations without
 *    completing"`).
 *  - `haltReason` is present only when `action === "halt"`, and explains why
 *    the queue is stopping. For infra-level it mirrors the per-ticket reason
 *    (the failure itself is what halts). For a circuit-breaker boundary
 *    (ticket-level halt) it carries the breaker context separately so the
 *    per-ticket `reason` is not polluted with queue-level state.
 */

export type FailureKind = "ticket-level" | "infra-level";

export type FailureAction = "continue" | "halt";

export type FailureCategory =
  // ticket-level — fault attributable to this ticket / this run
  | "agent.max-iterations"
  | "agent.idle-timeout"
  | "agent.token-budget-exceeded"
  | "hook.ticket-bound.failed"
  | "scenario.threw"
  // infra-level — fault in host / sandbox plumbing
  | "sandbox.provider.error"
  | "sandbox.container.start.failed"
  | "env.resolution.failed"
  | "hook.host.failed"
  | "spawn.failed"
  | "config.load.failed";

export interface FailureClassification {
  readonly kind: FailureKind;
  readonly action: FailureAction;
  /**
   * Per-ticket failure summary derived from the category. Always set; used
   * verbatim as `markErrored.reason` for ticket-level. Stable & greppable —
   * does NOT mutate when the circuit breaker trips.
   */
  readonly reason: string;
  /**
   * Present only when `action === "halt"`. Explains why the queue is stopping.
   * For infra-level halts this mirrors `reason`. For ticket-level halts (the
   * circuit-breaker boundary) it describes the breaker condition separately.
   */
  readonly haltReason?: string;
}

export interface PolicyConfig {
  /** Default: 3. Trip-point for the circuit breaker. */
  readonly consecutiveFailureThreshold?: number;
}

export interface FailureInput {
  readonly category: FailureCategory;
  readonly message: string;
  /** Count BEFORE this failure — caller increments after a ticket-level result. */
  readonly consecutiveTicketLevelFailures: number;
}

export const DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD = 3;

interface CategoryEntry {
  readonly kind: FailureKind;
  readonly reason: string;
}

const CATEGORY_TABLE: Record<FailureCategory, CategoryEntry> = {
  "agent.max-iterations": {
    kind: "ticket-level",
    reason: "agent hit max iterations without completing",
  },
  "agent.idle-timeout": {
    kind: "ticket-level",
    reason: "agent idle timeout",
  },
  "agent.token-budget-exceeded": {
    kind: "ticket-level",
    reason: "agent exceeded per-session token budget",
  },
  "hook.ticket-bound.failed": {
    kind: "ticket-level",
    reason: "ticket-bound hook failed",
  },
  "scenario.threw": {
    kind: "ticket-level",
    reason: "scenario threw",
  },
  "sandbox.provider.error": {
    kind: "infra-level",
    reason: "sandbox provider error",
  },
  "sandbox.container.start.failed": {
    kind: "infra-level",
    reason: "sandbox container failed to start",
  },
  "env.resolution.failed": {
    kind: "infra-level",
    reason: "env resolution failed",
  },
  "hook.host.failed": {
    kind: "infra-level",
    reason: "host hook failed before agent invocation",
  },
  "spawn.failed": {
    kind: "infra-level",
    reason: "scenario child process failed to spawn",
  },
  "config.load.failed": {
    kind: "infra-level",
    reason: "sandcastle config failed to load",
  },
};

export const classifyFailure = (
  input: FailureInput,
  config: PolicyConfig = {},
): FailureClassification => {
  const threshold =
    config.consecutiveFailureThreshold ?? DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD;
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new RangeError(
      `consecutiveFailureThreshold must be a positive integer (got ${threshold})`,
    );
  }

  // Defensive: the type system narrows `category` to `FailureCategory`, but
  // callers downstream of an I/O boundary (e.g. orchestrator forwarding a
  // `SandboxError._tag` whose mapping table hasn't been extended yet) can pass
  // an unknown string at runtime. Treat unknowns as infra-level halts: we
  // don't trust the system enough to label a ticket on its behalf, and a
  // human should see the queue stop.
  const entry = CATEGORY_TABLE[input.category] as CategoryEntry | undefined;
  if (entry === undefined) {
    const reason = `unknown failure category: ${String(input.category)}`;
    return { kind: "infra-level", action: "halt", reason, haltReason: reason };
  }

  if (entry.kind === "infra-level") {
    return {
      kind: "infra-level",
      action: "halt",
      reason: entry.reason,
      haltReason: entry.reason,
    };
  }

  const consecutiveIncludingThis = input.consecutiveTicketLevelFailures + 1;
  const tripped = consecutiveIncludingThis >= threshold;

  if (tripped) {
    return {
      kind: "ticket-level",
      action: "halt",
      reason: entry.reason,
      haltReason: `${consecutiveIncludingThis} consecutive ticket-level failures`,
    };
  }

  return {
    kind: "ticket-level",
    action: "continue",
    reason: entry.reason,
  };
};
