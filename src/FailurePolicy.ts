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
  /** Short reason; used verbatim as `markErrored.reason` for ticket-level. */
  readonly reason: string;
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
  const entry = CATEGORY_TABLE[input.category];

  if (entry.kind === "infra-level") {
    return { kind: "infra-level", action: "halt", reason: entry.reason };
  }

  const threshold =
    config.consecutiveFailureThreshold ?? DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD;
  const consecutiveIncludingThis = input.consecutiveTicketLevelFailures + 1;
  const tripped = consecutiveIncludingThis >= threshold;

  return {
    kind: "ticket-level",
    action: tripped ? "halt" : "continue",
    reason: tripped
      ? `halted: ${consecutiveIncludingThis} consecutive ticket-level failures (${entry.reason})`
      : entry.reason,
  };
};
