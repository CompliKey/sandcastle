/**
 * IPC protocol between the parent ScenarioRunner and the scenario-child shim.
 *
 * Transport: Node's built-in `process.send()` / `process.on("message", ...)`
 * channel established by `child_process.fork()`. Each message is a single JSON
 * value — Node owns serialization. The parent translates these messages into
 * `SandcastleEvent`s by stamping in `sessionId`, `laneId`, and `timestamp`.
 *
 * Session-level bookends (`session.start`, `session.end`) are NOT in this
 * protocol: the parent owns those because only the parent knows the session
 * id, can observe child exit, and can map exit shape (clean / non-zero /
 * signalled) onto the right outcome. If the child owned `session.end` and
 * crashed before sending it, AC#6 ("child crash produces a session.end with
 * outcome=errored") would be unsatisfiable.
 */

import type {
  EventIterationUsage,
  SandcastleEvent,
  SessionOutcome,
} from "./EventStore.js";

// ---------------------------------------------------------------------------
// Env var names (string literal contract — child reads, parent writes)
// ---------------------------------------------------------------------------

export const SCENARIO_ENV = {
  /** Name of the scenario to invoke. */
  scenario: "SANDCASTLE_SCENARIO",
  /** Ticket id to hydrate via `backlogManager.getTicket`. */
  ticketId: "SANDCASTLE_TICKET_ID",
  /** Absolute path to the user's `main.ts` config. */
  configPath: "SANDCASTLE_CONFIG_PATH",
  /** Session id — passed in for diagnostics. The child does NOT emit session events. */
  sessionId: "SANDCASTLE_SESSION_ID",
  /** Lane id — `"main"` in v1. */
  laneId: "SANDCASTLE_LANE_ID",
  /**
   * Marker that signals "you are running inside a scenario child process";
   * pre-wired `ctx.run` / `ctx.createSandbox` / `ctx.interactive` use it to
   * decide whether to route logging through IPC.
   */
  ipcMode: "SANDCASTLE_IPC_MODE",
} as const;

// ---------------------------------------------------------------------------
// Child → parent messages
// ---------------------------------------------------------------------------

export interface IterationStartMessage {
  readonly kind: "iteration.start";
  readonly iteration: number;
}

export interface IterationEndMessage {
  readonly kind: "iteration.end";
  readonly iteration: number;
  readonly usage?: EventIterationUsage;
}

export interface AgentTextMessage {
  readonly kind: "agent.text";
  readonly iteration: number;
  readonly text: string;
}

export interface AgentToolCallMessage {
  readonly kind: "agent.toolCall";
  readonly iteration: number;
  /** Provider-specific tool-use id; absent for non-Claude providers. */
  readonly toolUseId?: string;
  readonly toolName: string;
  readonly formattedArgs: string;
}

export interface AgentToolResultMessage {
  readonly kind: "agent.toolResult";
  readonly iteration: number;
  readonly toolUseId: string;
  readonly result: string;
  readonly isError: boolean;
}

export interface CommitMessage {
  readonly kind: "commit";
  readonly sha: string;
}

export interface ErrorMessage {
  readonly kind: "error";
  /** Coarse classification (e.g. `"scenario.threw"`, `"loader.failed"`). */
  readonly errorKind: string;
  readonly reason: string;
}

export interface UserLogMessage {
  readonly kind: "user.log";
  readonly event: string;
  readonly data?: Record<string, unknown>;
}

export type ScenarioChildMessage =
  | IterationStartMessage
  | IterationEndMessage
  | AgentTextMessage
  | AgentToolCallMessage
  | AgentToolResultMessage
  | CommitMessage
  | ErrorMessage
  | UserLogMessage;

/** Type guard — defends against arbitrary objects landing on the IPC channel. */
export const isScenarioChildMessage = (
  value: unknown,
): value is ScenarioChildMessage => {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  switch (kind) {
    case "iteration.start":
    case "iteration.end":
    case "agent.text":
    case "agent.toolCall":
    case "agent.toolResult":
    case "commit":
    case "error":
    case "user.log":
      return true;
    default:
      return false;
  }
};

// ---------------------------------------------------------------------------
// Translation: child message → SandcastleEvent
// ---------------------------------------------------------------------------

export interface MessageContext {
  readonly sessionId: string;
  readonly laneId: string;
  readonly timestamp: number;
}

/**
 * Stamp a child message with `sessionId` / `laneId` / `timestamp` and project
 * it into the canonical `SandcastleEvent` shape persisted by the EventStore.
 *
 * Iteration boundaries and agent stream events from the child carry their own
 * `iteration`; the parent does not invent one.
 */
export const messageToEvent = (
  msg: ScenarioChildMessage,
  ctx: MessageContext,
): SandcastleEvent => {
  const base = {
    laneId: ctx.laneId,
    timestamp: ctx.timestamp,
    sessionId: ctx.sessionId,
  };
  switch (msg.kind) {
    case "iteration.start":
      return {
        ...base,
        type: "iteration.start",
        iteration: msg.iteration,
        startedAt: ctx.timestamp,
      };
    case "iteration.end":
      return {
        ...base,
        type: "iteration.end",
        iteration: msg.iteration,
        usage: msg.usage,
        endedAt: ctx.timestamp,
      };
    case "agent.text":
      return {
        ...base,
        type: "agent.text",
        iteration: msg.iteration,
        text: msg.text,
      };
    case "agent.toolCall":
      return {
        ...base,
        type: "agent.toolCall",
        iteration: msg.iteration,
        toolUseId: msg.toolUseId,
        toolName: msg.toolName,
        formattedArgs: msg.formattedArgs,
      };
    case "agent.toolResult":
      return {
        ...base,
        type: "agent.toolResult",
        iteration: msg.iteration,
        toolUseId: msg.toolUseId,
        result: msg.result,
        isError: msg.isError,
      };
    case "commit":
      return { ...base, type: "commit", sha: msg.sha };
    case "error":
      return {
        ...base,
        type: "error",
        kind: msg.errorKind,
        reason: msg.reason,
      };
    case "user.log":
      return {
        ...base,
        type: "user.log",
        payload:
          msg.data === undefined
            ? { event: msg.event }
            : { event: msg.event, data: msg.data },
      };
  }
};

// ---------------------------------------------------------------------------
// Session bookends — owned by the parent, exported as helpers for shape parity
// ---------------------------------------------------------------------------

export interface SessionStartParams {
  readonly sessionId: string;
  readonly laneId: string;
  readonly ticketId: string;
  readonly scenario: string;
  readonly startedAt: number;
  readonly maxIterations?: number;
}

export const buildSessionStartEvent = (
  p: SessionStartParams,
): SandcastleEvent => ({
  type: "session.start",
  sessionId: p.sessionId,
  laneId: p.laneId,
  ticketId: p.ticketId,
  scenario: p.scenario,
  startedAt: p.startedAt,
  timestamp: p.startedAt,
  ...(p.maxIterations !== undefined ? { maxIterations: p.maxIterations } : {}),
});

export interface SessionEndParams {
  readonly sessionId: string;
  readonly laneId: string;
  readonly outcome: SessionOutcome;
  readonly endedAt: number;
}

export const buildSessionEndEvent = (p: SessionEndParams): SandcastleEvent => ({
  type: "session.end",
  sessionId: p.sessionId,
  laneId: p.laneId,
  outcome: p.outcome,
  endedAt: p.endedAt,
  timestamp: p.endedAt,
});
