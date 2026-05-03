/**
 * Typed wrappers over the UiServer REST surface plus the WebSocket
 * snapshot/event protocol consumed by `useLiveSession`.
 *
 * The shapes mirror SessionView / SessionRollup from the backend
 * (src/SessionIndex.ts) and SandcastleEvent (src/EventStore.ts). Kept
 * hand-written here so the frontend is not coupled to the backend's
 * Effect/Node-typed source tree at build time.
 */

export interface TokenTotals {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface SessionRollup {
  totalTokens: TokenTotals;
  iterationCount: number;
  wallTimeMs?: number;
  maxIterations?: number;
}

export type SessionOutcome = "done" | "errored" | "halted";

export interface SessionIterationView {
  iteration: number;
  startedAt?: number;
  endedAt?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  toolCalls: ReadonlyArray<{
    toolName: string;
    formattedArgs: string;
    timestamp: number;
    toolUseId?: string;
    result?: string;
    isError?: boolean;
  }>;
  texts: ReadonlyArray<{ text: string; timestamp: number }>;
  userLogs: ReadonlyArray<{ payload: unknown; timestamp: number }>;
}

export interface SessionView {
  sessionId: string;
  ticketId: string;
  scenario: string;
  laneId: string;
  startedAt: number;
  endedAt?: number;
  outcome?: SessionOutcome;
  iterations: ReadonlyArray<SessionIterationView>;
  commits: ReadonlyArray<{ sha: string; timestamp: number }>;
  errors: ReadonlyArray<{ kind: string; reason: string; timestamp: number }>;
  rollup: SessionRollup;
}

const json = async <T>(path: string): Promise<T> => {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`${path} → ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
};

export const fetchSessions = async (): Promise<SessionView[]> => {
  const body = await json<{ sessions: SessionView[] }>("/api/sessions");
  return body.sessions;
};

export const fetchSession = async (id: string): Promise<SessionView> => {
  const body = await json<{ session: SessionView }>(
    `/api/sessions/${encodeURIComponent(id)}`,
  );
  return body.session;
};

export const fetchTicketSessions = async (
  ticketId: string,
): Promise<SessionView[]> => {
  const body = await json<{ sessions: SessionView[] }>(
    `/api/tickets/${encodeURIComponent(ticketId)}/sessions`,
  );
  return body.sessions;
};

// ---------------------------------------------------------------------------
// WebSocket protocol (slice 8 / VGD-141)
// ---------------------------------------------------------------------------

export interface IterationUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

interface EventBase {
  laneId: string;
  timestamp: number;
}

export type SandcastleEvent =
  | (EventBase & {
      type: "session.start";
      sessionId: string;
      ticketId: string;
      scenario: string;
      startedAt: number;
      maxIterations?: number;
    })
  | (EventBase & {
      type: "session.end";
      sessionId: string;
      outcome: SessionOutcome;
      endedAt: number;
    })
  | (EventBase & {
      type: "iteration.start";
      sessionId: string;
      iteration: number;
      startedAt: number;
    })
  | (EventBase & {
      type: "iteration.end";
      sessionId: string;
      iteration: number;
      usage?: IterationUsage;
      endedAt: number;
    })
  | (EventBase & {
      type: "agent.text";
      sessionId: string;
      iteration: number;
      text: string;
    })
  | (EventBase & {
      type: "agent.toolCall";
      sessionId: string;
      iteration: number;
      toolUseId?: string;
      toolName: string;
      formattedArgs: string;
    })
  | (EventBase & {
      type: "agent.toolResult";
      sessionId: string;
      iteration: number;
      toolUseId: string;
      result: string;
      isError: boolean;
    })
  | (EventBase & { type: "commit"; sessionId: string; sha: string })
  | (EventBase & {
      type: "error";
      sessionId: string;
      kind: string;
      reason: string;
    })
  | (EventBase & { type: "user.log"; sessionId: string; payload: unknown });

export type LiveMessage =
  | { type: "snapshot"; view: SessionView }
  | { type: "event"; event: SandcastleEvent }
  | { type: "error"; reason: string };
