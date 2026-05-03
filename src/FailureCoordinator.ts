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
  readonly reason: string;
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
): MarkErroredArgs => ({
  id: ticketId,
  reason,
  comment: message,
});

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
        await options.backlogManager.markErrored(
          buildMarkErroredArgs(
            input.ticketId,
            classification.reason,
            input.message,
          ),
        );
        consecutive += 1;
      }

      return {
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
