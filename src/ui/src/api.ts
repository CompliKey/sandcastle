/**
 * Typed wrappers over the UiServer REST surface.
 *
 * The shapes mirror SessionView / SessionRollup from the backend
 * (src/SessionIndex.ts). Kept hand-written here so the frontend is not
 * coupled to the backend's Effect/Node-typed source tree at build time.
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
}

export type SessionOutcome = "done" | "errored" | "halted";

export interface SessionView {
  sessionId: string;
  ticketId: string;
  scenario: string;
  laneId: string;
  startedAt: number;
  endedAt?: number;
  outcome?: SessionOutcome;
  iterations: ReadonlyArray<{
    iteration: number;
    startedAt?: number;
    endedAt?: number;
  }>;
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
