/**
 * SessionIndex — pure in-memory derivation of ticket-bounded sessions from
 * the event stream produced by {@link EventStore}.
 *
 * No I/O. The UI server feeds events via `add(event)` (live) or via a single
 * pass over `EventStore.replay(...)` (history). Both paths produce the same
 * indexed shape — that is the load-bearing property that lets one set of
 * components render live and historical sessions identically.
 *
 * Aggregation rules
 * - Each `session.start` opens a new {@link SessionView} keyed by `sessionId`.
 * - Each `iteration.start` opens an iteration node under its session.
 * - `agent.text`, `agent.toolCall`, and `user.log` events are appended to
 *   their iteration in arrival order.
 * - `iteration.end` records `endedAt` and (if present) `usage`.
 * - `session.end` records `endedAt` and `outcome`.
 * - `commit` and `error` events are recorded at the session level (they may
 *   arrive between iterations or after `session.end`).
 *
 * Out-of-order or orphaned events are tolerated — the index records what it
 * can and ignores fields it has no anchor for.
 */

import type {
  EventIterationUsage,
  SandcastleEvent,
  SessionOutcome,
} from "./EventStore.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TokenTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheCreation: number;
  readonly cacheRead: number;
}

export interface SessionIterationView {
  readonly iteration: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly usage?: EventIterationUsage;
  readonly toolCalls: ReadonlyArray<{
    readonly toolName: string;
    readonly formattedArgs: string;
    readonly timestamp: number;
    readonly toolUseId?: string;
    /** Set once a matching `agent.toolResult` event arrives (Claude Code only). */
    readonly result?: string;
    readonly isError?: boolean;
  }>;
  readonly texts: ReadonlyArray<{
    readonly text: string;
    readonly timestamp: number;
  }>;
  readonly userLogs: ReadonlyArray<{
    readonly payload: unknown;
    readonly timestamp: number;
  }>;
}

export interface SessionView {
  readonly sessionId: string;
  readonly ticketId: string;
  readonly scenario: string;
  readonly laneId: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly outcome?: SessionOutcome;
  readonly iterations: ReadonlyArray<SessionIterationView>;
  readonly commits: ReadonlyArray<{
    readonly sha: string;
    readonly timestamp: number;
  }>;
  readonly errors: ReadonlyArray<{
    readonly kind: string;
    readonly reason: string;
    readonly timestamp: number;
  }>;
  readonly rollup: SessionRollup;
}

export interface SessionRollup {
  readonly totalTokens: TokenTotals;
  readonly iterationCount: number;
  /** `endedAt - startedAt` once the session has ended. */
  readonly wallTimeMs?: number;
}

export interface TicketRollup {
  readonly ticketId: string;
  readonly sessionCount: number;
  readonly totalTokens: TokenTotals;
  readonly totalIterations: number;
  /** Sum of per-session wall times (ended sessions only). */
  readonly totalWallTimeMs: number;
  /** Average iterations per session. */
  readonly averageIterationsPerSession: number;
  /**
   * Earliest `session.start` to latest `session.end` with outcome `"done"`.
   * Undefined until the ticket has at least one done session.
   */
  readonly timeToCloseMs?: number;
}

export type RollupScope =
  | { readonly type: "session"; readonly sessionId: string }
  | { readonly type: "ticket"; readonly ticketId: string };

export interface ListSessionsOptions {
  /** Only sessions with `startedAt >= since` (ms since epoch). */
  readonly since?: number;
  /** Cap the result; sessions are returned newest-first. */
  readonly limit?: number;
}

export interface SessionIndex {
  add(event: SandcastleEvent): void;
  getSession(sessionId: string): SessionView | undefined;
  listByTicket(ticketId: string): SessionView[];
  listSessions(options?: ListSessionsOptions): SessionView[];
  getRollups(scope: RollupScope): SessionRollup | TicketRollup | undefined;
}

// ---------------------------------------------------------------------------
// Internals — mutable state, frozen on read
// ---------------------------------------------------------------------------

type ToolCallState = {
  toolName: string;
  formattedArgs: string;
  timestamp: number;
  toolUseId?: string;
  result?: string;
  isError?: boolean;
};

interface IterationState {
  iteration: number;
  startedAt?: number;
  endedAt?: number;
  usage?: EventIterationUsage;
  toolCalls: ToolCallState[];
  texts: SessionIterationView["texts"][number][];
  userLogs: SessionIterationView["userLogs"][number][];
}

interface SessionState {
  sessionId: string;
  ticketId: string;
  scenario: string;
  laneId: string;
  startedAt: number;
  endedAt?: number;
  outcome?: SessionOutcome;
  iterations: Map<number, IterationState>;
  iterationOrder: number[];
  commits: SessionView["commits"][number][];
  errors: SessionView["errors"][number][];
}

const emptyTokens = (): TokenTotals => ({
  input: 0,
  output: 0,
  cacheCreation: 0,
  cacheRead: 0,
});

const addUsage = (
  totals: TokenTotals,
  usage: EventIterationUsage,
): TokenTotals => ({
  input: totals.input + usage.inputTokens,
  output: totals.output + usage.outputTokens,
  cacheCreation: totals.cacheCreation + usage.cacheCreationInputTokens,
  cacheRead: totals.cacheRead + usage.cacheReadInputTokens,
});

const sumTokens = (a: TokenTotals, b: TokenTotals): TokenTotals => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheCreation: a.cacheCreation + b.cacheCreation,
  cacheRead: a.cacheRead + b.cacheRead,
});

const buildIterationView = (it: IterationState): SessionIterationView => ({
  iteration: it.iteration,
  startedAt: it.startedAt,
  endedAt: it.endedAt,
  usage: it.usage,
  toolCalls: it.toolCalls.slice(),
  texts: it.texts.slice(),
  userLogs: it.userLogs.slice(),
});

const buildSessionView = (s: SessionState): SessionView => {
  const iterations = s.iterationOrder.map((n) =>
    buildIterationView(s.iterations.get(n)!),
  );
  let totalTokens = emptyTokens();
  for (const it of iterations) {
    if (it.usage) totalTokens = addUsage(totalTokens, it.usage);
  }
  const wallTimeMs =
    s.endedAt !== undefined ? s.endedAt - s.startedAt : undefined;
  const rollup: SessionRollup = {
    totalTokens,
    iterationCount: iterations.length,
    wallTimeMs,
  };
  return {
    sessionId: s.sessionId,
    ticketId: s.ticketId,
    scenario: s.scenario,
    laneId: s.laneId,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    outcome: s.outcome,
    iterations,
    commits: s.commits.slice(),
    errors: s.errors.slice(),
    rollup,
  };
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createSessionIndex = (): SessionIndex => {
  const sessions = new Map<string, SessionState>();
  const byTicket = new Map<string, Set<string>>();

  const ensureIteration = (
    s: SessionState,
    iteration: number,
  ): IterationState => {
    let it = s.iterations.get(iteration);
    if (!it) {
      it = {
        iteration,
        toolCalls: [],
        texts: [],
        userLogs: [],
      };
      s.iterations.set(iteration, it);
      s.iterationOrder.push(iteration);
    }
    return it;
  };

  const add = (event: SandcastleEvent): void => {
    switch (event.type) {
      case "session.start": {
        if (sessions.has(event.sessionId)) return; // idempotent on replay
        const state: SessionState = {
          sessionId: event.sessionId,
          ticketId: event.ticketId,
          scenario: event.scenario,
          laneId: event.laneId,
          startedAt: event.startedAt,
          iterations: new Map(),
          iterationOrder: [],
          commits: [],
          errors: [],
        };
        sessions.set(event.sessionId, state);
        let bucket = byTicket.get(event.ticketId);
        if (!bucket) {
          bucket = new Set();
          byTicket.set(event.ticketId, bucket);
        }
        bucket.add(event.sessionId);
        return;
      }
      case "session.end": {
        const s = sessions.get(event.sessionId);
        if (!s) return;
        s.endedAt = event.endedAt;
        s.outcome = event.outcome;
        return;
      }
      case "iteration.start": {
        const s = sessions.get(event.sessionId);
        if (!s) return;
        const it = ensureIteration(s, event.iteration);
        it.startedAt = event.startedAt;
        return;
      }
      case "iteration.end": {
        const s = sessions.get(event.sessionId);
        if (!s) return;
        const it = ensureIteration(s, event.iteration);
        it.endedAt = event.endedAt;
        if (event.usage) it.usage = event.usage;
        return;
      }
      case "agent.text": {
        const s = sessions.get(event.sessionId);
        if (!s) return;
        const it = ensureIteration(s, event.iteration);
        it.texts.push({ text: event.text, timestamp: event.timestamp });
        return;
      }
      case "agent.toolCall": {
        const s = sessions.get(event.sessionId);
        if (!s) return;
        const it = ensureIteration(s, event.iteration);
        it.toolCalls.push({
          toolName: event.toolName,
          formattedArgs: event.formattedArgs,
          timestamp: event.timestamp,
          toolUseId: event.toolUseId,
        });
        return;
      }
      case "agent.toolResult": {
        const s = sessions.get(event.sessionId);
        if (!s) return;
        const it = ensureIteration(s, event.iteration);
        // Pair with the originating call by toolUseId. We search the most
        // recent calls first since results typically follow their calls
        // closely in time. Orphan results (no matching call) are dropped.
        for (let i = it.toolCalls.length - 1; i >= 0; i--) {
          const call = it.toolCalls[i]!;
          if (call.toolUseId === event.toolUseId) {
            call.result = event.result;
            call.isError = event.isError;
            return;
          }
        }
        return;
      }
      case "user.log": {
        const s = sessions.get(event.sessionId);
        if (!s) return;
        // user.log carries no iteration field — bucket it under the most
        // recent iteration if one exists; otherwise drop it on the floor of
        // iteration 0 placeholder so it is not lost.
        const lastIter =
          s.iterationOrder.length > 0
            ? s.iterationOrder[s.iterationOrder.length - 1]!
            : 0;
        const it = ensureIteration(s, lastIter);
        it.userLogs.push({
          payload: event.payload,
          timestamp: event.timestamp,
        });
        return;
      }
      case "commit": {
        const s = sessions.get(event.sessionId);
        if (!s) return;
        s.commits.push({ sha: event.sha, timestamp: event.timestamp });
        return;
      }
      case "error": {
        const s = sessions.get(event.sessionId);
        if (!s) return;
        s.errors.push({
          kind: event.kind,
          reason: event.reason,
          timestamp: event.timestamp,
        });
        return;
      }
    }
  };

  const getSession = (sessionId: string): SessionView | undefined => {
    const s = sessions.get(sessionId);
    return s ? buildSessionView(s) : undefined;
  };

  const listByTicket = (ticketId: string): SessionView[] => {
    const ids = byTicket.get(ticketId);
    if (!ids) return [];
    const views: SessionView[] = [];
    for (const id of ids) {
      const s = sessions.get(id);
      if (s) views.push(buildSessionView(s));
    }
    views.sort((a, b) => a.startedAt - b.startedAt);
    return views;
  };

  const listSessions = (options?: ListSessionsOptions): SessionView[] => {
    const since = options?.since;
    const views: SessionView[] = [];
    for (const s of sessions.values()) {
      if (since !== undefined && s.startedAt < since) continue;
      views.push(buildSessionView(s));
    }
    views.sort((a, b) => b.startedAt - a.startedAt);
    if (options?.limit !== undefined) {
      return views.slice(0, options.limit);
    }
    return views;
  };

  const getRollups = (
    scope: RollupScope,
  ): SessionRollup | TicketRollup | undefined => {
    if (scope.type === "session") {
      const view = getSession(scope.sessionId);
      return view?.rollup;
    }
    const sessionsForTicket = listByTicket(scope.ticketId);
    if (sessionsForTicket.length === 0) return undefined;

    let totalTokens = emptyTokens();
    let totalIterations = 0;
    let totalWallTimeMs = 0;
    let firstStart = Number.POSITIVE_INFINITY;
    let lastDoneEnd: number | undefined;
    for (const s of sessionsForTicket) {
      totalTokens = sumTokens(totalTokens, s.rollup.totalTokens);
      totalIterations += s.rollup.iterationCount;
      if (s.rollup.wallTimeMs !== undefined) {
        totalWallTimeMs += s.rollup.wallTimeMs;
      }
      if (s.startedAt < firstStart) firstStart = s.startedAt;
      if (
        s.outcome === "done" &&
        s.endedAt !== undefined &&
        (lastDoneEnd === undefined || s.endedAt > lastDoneEnd)
      ) {
        lastDoneEnd = s.endedAt;
      }
    }
    const timeToCloseMs =
      lastDoneEnd !== undefined ? lastDoneEnd - firstStart : undefined;
    return {
      ticketId: scope.ticketId,
      sessionCount: sessionsForTicket.length,
      totalTokens,
      totalIterations,
      totalWallTimeMs,
      averageIterationsPerSession:
        sessionsForTicket.length === 0
          ? 0
          : totalIterations / sessionsForTicket.length,
      timeToCloseMs,
    };
  };

  return { add, getSession, listByTicket, listSessions, getRollups };
};

/** Convenience: build an index by replaying a finite event sequence. */
export const buildSessionIndex = (
  events: Iterable<SandcastleEvent>,
): SessionIndex => {
  const idx = createSessionIndex();
  for (const e of events) idx.add(e);
  return idx;
};
