/**
 * FailureCoordinator — thin stateful glue between {@link FailurePolicy} and a
 * {@link BacklogManagerHostInterface}.
 *
 * Owns the running count of consecutive ticket-level failures and the side
 * effect of calling `markErrored`. The orchestration loop (future slice) calls
 * `handleFailure` for each errored scenario invocation and `noteSuccess` for
 * each successful one.
 *
 * Decision rules:
 *  - ticket-level (including the boundary failure that trips the circuit
 *    breaker): call `markErrored` so the ticket is labelled `agent-error` in
 *    the source system. The orchestrator continues or halts based on `action`.
 *  - infra-level: do NOT call `markErrored`. The ticket is innocent — the host
 *    side is broken. Always halts.
 *  - Successful run: counter resets to 0.
 */

import type {
  BacklogManagerHostInterface,
  MarkErroredArgs,
} from "./defineSandcastle.js";
import {
  classifyFailure,
  type FailureAction,
  type FailureCategory,
  type FailureKind,
  type PolicyConfig,
} from "./FailurePolicy.js";

export interface FailureCoordinatorOptions {
  readonly backlogManager: BacklogManagerHostInterface;
  /** Optional override for the circuit-breaker threshold etc. */
  readonly policyConfig?: PolicyConfig;
}

export interface HandleFailureInput {
  readonly ticketId: string;
  readonly category: FailureCategory;
  /** Human-readable detail; goes into the JIRA comment as additional context. */
  readonly message: string;
}

export interface HandleFailureResult {
  readonly kind: FailureKind;
  readonly action: FailureAction;
  /** Per-ticket reason (matches what was sent as `markErrored.reason`, when applicable). */
  readonly reason: string;
  /** Present iff `action === "halt"`. Explains why the queue is stopping. */
  readonly haltReason?: string;
}

export interface FailureCoordinator {
  handleFailure(input: HandleFailureInput): Promise<HandleFailureResult>;
  noteSuccess(): void;
  /** Exposed for tests / diagnostics. */
  consecutiveTicketLevelFailures(): number;
}

const buildMarkErroredArgs = (
  ticketId: string,
  reason: string,
  message: string,
): MarkErroredArgs => {
  const trimmed = message.trim();
  return trimmed.length > 0
    ? { id: ticketId, reason, comment: trimmed }
    : { id: ticketId, reason };
};

export const createFailureCoordinator = (
  options: FailureCoordinatorOptions,
): FailureCoordinator => {
  let consecutive = 0;

  return {
    async handleFailure(input) {
      const classification = classifyFailure(
        {
          category: input.category,
          message: input.message,
          consecutiveTicketLevelFailures: consecutive,
        },
        options.policyConfig,
      );

      if (classification.kind === "ticket-level") {
        // Order matters: the increment must follow a successful markErrored.
        // If the backlog system is down and the call throws, we propagate
        // and leave the counter unchanged so a permanently-broken backlog
        // can't false-trip the breaker against tickets it never recorded.
        await options.backlogManager.markErrored(
          buildMarkErroredArgs(
            input.ticketId,
            classification.reason,
            input.message,
          ),
        );
        consecutive += 1;
      }

      return classification.haltReason !== undefined
        ? {
            kind: classification.kind,
            action: classification.action,
            reason: classification.reason,
            haltReason: classification.haltReason,
          }
        : {
            kind: classification.kind,
            action: classification.action,
            reason: classification.reason,
          };
    },
    noteSuccess() {
      consecutive = 0;
    },
    consecutiveTicketLevelFailures() {
      return consecutive;
    },
  };
};
