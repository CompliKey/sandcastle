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

export interface TicketRollup {
  ticketId: string;
  sessionCount: number;
  totalTokens: TokenTotals;
  totalIterations: number;
  totalWallTimeMs: number;
  averageIterationsPerSession: number;
  /** Earliest start to latest done end. Undefined until at least one done session. */
  timeToCloseMs?: number;
}

export interface TicketDetail {
  ticketId: string;
  sessions: SessionView[];
  rollup: TicketRollup;
}

export const fetchTicket = async (ticketId: string): Promise<TicketDetail> =>
  json<TicketDetail>(`/api/tickets/${encodeURIComponent(ticketId)}`);

// ---------------------------------------------------------------------------
// Queue + manual run-scenario (VGD-143)
// ---------------------------------------------------------------------------

export interface QueueTicket {
  id: string;
  title: string;
  body: string;
  labels: ReadonlyArray<string>;
  url: string;
  priority?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ScenarioOption {
  name: string;
  description?: string;
  maxIterations?: number;
}

export interface ScenarioOverrides {
  maxIterations?: number;
  model?: string;
  promptArgs?: Record<string, unknown>;
}

export interface RunScenarioBody {
  scenario: string;
  ticketId: string;
  overrides?: ScenarioOverrides;
}

export const fetchQueue = async (): Promise<QueueTicket[]> => {
  const body = await json<{ tickets: QueueTicket[] }>("/api/queue");
  return body.tickets;
};

export const fetchScenarios = async (): Promise<ScenarioOption[]> => {
  const body = await json<{ scenarios: ScenarioOption[] }>("/api/scenarios");
  return body.scenarios;
};

/**
 * POST /api/run-scenario. Resolves with the allocated `sessionId` so the
 * caller can navigate to the live session view immediately. Rejects with the
 * server's error string for any 4xx/5xx response.
 */
export const runScenarioRequest = async (
  body: RunScenarioBody,
): Promise<{ sessionId: string }> => {
  const res = await fetch("/api/run-scenario", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const errBody = (await res.json()) as { error?: string };
      if (errBody.error) detail = errBody.error;
    } catch {
      /* keep statusText */
    }
    throw new Error(`run-scenario failed: ${detail}`);
  }
  return (await res.json()) as { sessionId: string };
};

// ---------------------------------------------------------------------------
// Autopilot control + retry (VGD-144)
// ---------------------------------------------------------------------------

export type AutopilotStatus = "off" | "on" | "halted";

export interface AutopilotState {
  status: AutopilotStatus;
  scenario?: string;
  startedAt?: number;
  haltedAt?: number;
  haltReason?: string;
  haltKind?: "infra-level" | "ticket-level";
  ticketsAttempted: number;
  ticketsCompleted: number;
  ticketsErrored: number;
}

const postAction = async (
  path: string,
  body: unknown,
): Promise<{ state: AutopilotState }> => {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const errBody = (await res.json()) as { error?: string };
      if (errBody.error) detail = errBody.error;
    } catch {
      /* keep statusText */
    }
    throw new Error(`${path} → ${detail}`);
  }
  return (await res.json()) as { state: AutopilotState };
};

export const fetchAutopilotState = async (): Promise<AutopilotState> => {
  const body = await json<{ state: AutopilotState }>("/api/autopilot");
  return body.state;
};

export const startAutopilot = async (
  scenario?: string,
): Promise<AutopilotState> => {
  const body = await postAction(
    "/api/autopilot/start",
    scenario !== undefined ? { scenario } : {},
  );
  return body.state;
};

export const stopAutopilot = async (): Promise<AutopilotState> => {
  const body = await postAction("/api/autopilot/stop", {});
  return body.state;
};

export const resumeAutopilot = async (): Promise<AutopilotState> => {
  const body = await postAction("/api/autopilot/resume", {});
  return body.state;
};

export interface RetryTicketBody {
  scenario?: string;
  overrides?: ScenarioOverrides;
}

export const retryTicket = async (
  ticketId: string,
  body: RetryTicketBody = {},
): Promise<{ sessionId: string }> => {
  const res = await fetch(
    `/api/tickets/${encodeURIComponent(ticketId)}/retry`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const errBody = (await res.json()) as { error?: string };
      if (errBody.error) detail = errBody.error;
    } catch {
      /* keep statusText */
    }
    throw new Error(`retry failed: ${detail}`);
  }
  return (await res.json()) as { sessionId: string };
};

// ---------------------------------------------------------------------------
// Commits + diff (VGD-142)
// ---------------------------------------------------------------------------

export type FileChangeStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U" | "X";

export interface CommitFileChange {
  path: string;
  oldPath?: string;
  status: FileChangeStatus;
  insertions?: number;
  deletions?: number;
}

export interface CommitMetadata {
  sha: string;
  parentSha?: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  authorTime: number;
  files: ReadonlyArray<CommitFileChange>;
}

export interface FileDiff {
  path: string;
  diff: string;
  status: FileChangeStatus;
  insertions?: number;
  deletions?: number;
}

export const fetchCommit = async (
  sessionId: string,
  sha: string,
): Promise<CommitMetadata> => {
  const body = await json<{ commit: CommitMetadata }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/commits/${encodeURIComponent(sha)}`,
  );
  return body.commit;
};

export const fetchFileDiff = async (
  sessionId: string,
  sha: string,
  path: string,
): Promise<FileDiff> => {
  const body = await json<{ diff: FileDiff }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/commits/${encodeURIComponent(
      sha,
    )}/diff?path=${encodeURIComponent(path)}`,
  );
  return body.diff;
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
