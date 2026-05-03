import { describe, expect, it, vi } from "vitest";

import type { SandcastleEvent } from "./EventStore.js";
import {
  buildSessionIndex,
  createSessionIndex,
  type TicketRollup,
} from "./SessionIndex.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const sessionStart = (
  sessionId: string,
  ticketId: string,
  startedAt: number,
  scenario = "default",
): SandcastleEvent => ({
  type: "session.start",
  laneId: "main",
  timestamp: startedAt,
  sessionId,
  ticketId,
  scenario,
  startedAt,
});

const sessionEnd = (
  sessionId: string,
  outcome: "done" | "errored" | "halted",
  endedAt: number,
): SandcastleEvent => ({
  type: "session.end",
  laneId: "main",
  timestamp: endedAt,
  sessionId,
  outcome,
  endedAt,
});

const iterationStart = (
  sessionId: string,
  iteration: number,
  startedAt: number,
): SandcastleEvent => ({
  type: "iteration.start",
  laneId: "main",
  timestamp: startedAt,
  sessionId,
  iteration,
  startedAt,
});

const iterationEnd = (
  sessionId: string,
  iteration: number,
  endedAt: number,
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  },
): SandcastleEvent => ({
  type: "iteration.end",
  laneId: "main",
  timestamp: endedAt,
  sessionId,
  iteration,
  endedAt,
  usage,
});

const text = (
  sessionId: string,
  iteration: number,
  ts: number,
  text: string,
): SandcastleEvent => ({
  type: "agent.text",
  laneId: "main",
  timestamp: ts,
  sessionId,
  iteration,
  text,
});

const toolCall = (
  sessionId: string,
  iteration: number,
  ts: number,
  toolName: string,
  formattedArgs = "{}",
): SandcastleEvent => ({
  type: "agent.toolCall",
  laneId: "main",
  timestamp: ts,
  sessionId,
  iteration,
  toolName,
  formattedArgs,
});

const commit = (
  sessionId: string,
  ts: number,
  sha: string,
): SandcastleEvent => ({
  type: "commit",
  laneId: "main",
  timestamp: ts,
  sessionId,
  sha,
});

const errorEvent = (
  sessionId: string,
  ts: number,
  kind: string,
  reason: string,
): SandcastleEvent => ({
  type: "error",
  laneId: "main",
  timestamp: ts,
  sessionId,
  kind,
  reason,
});

const userLog = (
  sessionId: string,
  ts: number,
  payload: unknown,
): SandcastleEvent => ({
  type: "user.log",
  laneId: "main",
  timestamp: ts,
  sessionId,
  payload,
});

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

describe("SessionIndex grouping", () => {
  it("groups events into a ticket-bounded session with iteration children", () => {
    const idx = buildSessionIndex([
      sessionStart("s1", "T-1", 1000),
      iterationStart("s1", 1, 1100),
      text("s1", 1, 1110, "hi"),
      toolCall("s1", 1, 1120, "Read"),
      iterationEnd("s1", 1, 1200),
      iterationStart("s1", 2, 1300),
      iterationEnd("s1", 2, 1400),
      sessionEnd("s1", "done", 1500),
    ]);

    const view = idx.getSession("s1")!;
    expect(view.ticketId).toBe("T-1");
    expect(view.outcome).toBe("done");
    expect(view.iterations).toHaveLength(2);
    expect(view.iterations[0]!.iteration).toBe(1);
    expect(view.iterations[0]!.texts.map((t) => t.text)).toEqual(["hi"]);
    expect(view.iterations[0]!.toolCalls.map((c) => c.toolName)).toEqual([
      "Read",
    ]);
    expect(view.iterations[1]!.iteration).toBe(2);
  });

  it("listByTicket returns every session bound to the ticket, sorted by startedAt", () => {
    const idx = buildSessionIndex([
      sessionStart("s2", "T-1", 2000),
      sessionEnd("s2", "errored", 2100),
      sessionStart("s1", "T-1", 1000),
      sessionEnd("s1", "done", 1500),
      sessionStart("s3", "T-OTHER", 1100),
    ]);

    const sessions = idx.listByTicket("T-1");
    expect(sessions.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
    expect(idx.listByTicket("T-OTHER").map((s) => s.sessionId)).toEqual(["s3"]);
    expect(idx.listByTicket("T-MISSING")).toEqual([]);
  });

  it("listSessions returns newest-first and respects since/limit", () => {
    const idx = buildSessionIndex([
      sessionStart("s1", "T-1", 1000),
      sessionStart("s2", "T-2", 2000),
      sessionStart("s3", "T-3", 3000),
    ]);

    expect(idx.listSessions().map((s) => s.sessionId)).toEqual([
      "s3",
      "s2",
      "s1",
    ]);
    expect(idx.listSessions({ limit: 2 }).map((s) => s.sessionId)).toEqual([
      "s3",
      "s2",
    ]);
    expect(idx.listSessions({ since: 2000 }).map((s) => s.sessionId)).toEqual([
      "s3",
      "s2",
    ]);
  });

  it("ignores events for a session that never had session.start", () => {
    const idx = buildSessionIndex([
      iterationStart("ghost", 1, 1),
      text("ghost", 1, 2, "no anchor"),
      commit("ghost", 3, "abc"),
    ]);
    expect(idx.getSession("ghost")).toBeUndefined();
    expect(idx.listSessions()).toHaveLength(0);
  });

  it("session.start is idempotent on replay", () => {
    const idx = createSessionIndex();
    idx.add(sessionStart("s1", "T-1", 1000));
    idx.add(text("s1", 1, 1100, "first"));
    // Replaying the start event again must not wipe the iteration we already
    // recorded.
    idx.add(sessionStart("s1", "T-1", 1000));
    const view = idx.getSession("s1")!;
    expect(view.iterations).toHaveLength(1);
    expect(view.iterations[0]!.texts.map((t) => t.text)).toEqual(["first"]);
  });

  it("attaches commits and errors at the session level", () => {
    const idx = buildSessionIndex([
      sessionStart("s1", "T-1", 1000),
      commit("s1", 1100, "abc123"),
      commit("s1", 1200, "def456"),
      errorEvent("s1", 1300, "max-iterations", "hit cap"),
      sessionEnd("s1", "errored", 1400),
    ]);

    const view = idx.getSession("s1")!;
    expect(view.commits.map((c) => c.sha)).toEqual(["abc123", "def456"]);
    expect(view.errors.map((e) => e.reason)).toEqual(["hit cap"]);
  });

  it("buckets user.log under the most recent iteration", () => {
    const idx = buildSessionIndex([
      sessionStart("s1", "T-1", 1000),
      iterationStart("s1", 1, 1100),
      userLog("s1", 1110, { tag: "hello" }),
      iterationEnd("s1", 1, 1200),
      iterationStart("s1", 2, 1300),
      userLog("s1", 1310, { tag: "world" }),
    ]);

    const view = idx.getSession("s1")!;
    expect(view.iterations[0]!.userLogs.map((u) => u.payload)).toEqual([
      { tag: "hello" },
    ]);
    expect(view.iterations[1]!.userLogs.map((u) => u.payload)).toEqual([
      { tag: "world" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

describe("SessionIndex rollups", () => {
  const usage = (
    inputTokens: number,
    outputTokens: number,
    cc = 0,
    cr = 0,
  ): {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  } => ({
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: cc,
    cacheReadInputTokens: cr,
  });

  it("session rollup sums iteration usage and computes wall time", () => {
    const idx = buildSessionIndex([
      sessionStart("s1", "T-1", 1000),
      iterationStart("s1", 1, 1100),
      iterationEnd("s1", 1, 1200, usage(50, 20, 5, 100)),
      iterationStart("s1", 2, 1300),
      iterationEnd("s1", 2, 1400, usage(30, 10, 2, 200)),
      sessionEnd("s1", "done", 1500),
    ]);

    const rollup = idx.getRollups({ type: "session", sessionId: "s1" });
    expect(rollup).toEqual({
      totalTokens: { input: 80, output: 30, cacheCreation: 7, cacheRead: 300 },
      iterationCount: 2,
      wallTimeMs: 500,
    });
  });

  it("session wallTimeMs is undefined while the session is in flight", () => {
    const idx = buildSessionIndex([
      sessionStart("s1", "T-1", 1000),
      iterationStart("s1", 1, 1100),
    ]);

    const rollup = idx.getRollups({ type: "session", sessionId: "s1" });
    expect(rollup).toMatchObject({ wallTimeMs: undefined, iterationCount: 1 });
  });

  it("ticket rollup aggregates across every session for the ticket", () => {
    const idx = buildSessionIndex([
      sessionStart("s1", "T-1", 1000),
      iterationStart("s1", 1, 1100),
      iterationEnd("s1", 1, 1200, usage(10, 5)),
      sessionEnd("s1", "errored", 1300),

      sessionStart("s2", "T-1", 2000),
      iterationStart("s2", 1, 2100),
      iterationEnd("s2", 1, 2200, usage(20, 10)),
      iterationStart("s2", 2, 2300),
      iterationEnd("s2", 2, 2400, usage(30, 15)),
      sessionEnd("s2", "done", 2500),
    ]);

    const rollup = idx.getRollups({
      type: "ticket",
      ticketId: "T-1",
    }) as TicketRollup;

    expect(rollup.sessionCount).toBe(2);
    expect(rollup.totalIterations).toBe(3);
    expect(rollup.totalTokens).toEqual({
      input: 60,
      output: 30,
      cacheCreation: 0,
      cacheRead: 0,
    });
    expect(rollup.totalWallTimeMs).toBe(300 + 500);
    expect(rollup.averageIterationsPerSession).toBeCloseTo(1.5);
    // Time-to-close: first start (s1 = 1000) → last done end (s2 = 2500).
    expect(rollup.timeToCloseMs).toBe(1500);
  });

  it("ticket time-to-close is undefined until at least one session ends with outcome 'done'", () => {
    const idx = buildSessionIndex([
      sessionStart("s1", "T-1", 1000),
      sessionEnd("s1", "errored", 1500),
    ]);
    const rollup = idx.getRollups({
      type: "ticket",
      ticketId: "T-1",
    }) as TicketRollup;
    expect(rollup.timeToCloseMs).toBeUndefined();
  });

  it("ticket rollup is undefined when no sessions exist for the ticket", () => {
    const idx = buildSessionIndex([sessionStart("s1", "T-1", 1000)]);
    expect(
      idx.getRollups({ type: "ticket", ticketId: "T-MISSING" }),
    ).toBeUndefined();
  });
});

describe("SessionIndex tool-result pairing", () => {
  const toolCall = (
    sessionId: string,
    iteration: number,
    toolUseId: string,
    timestamp: number,
  ): SandcastleEvent => ({
    type: "agent.toolCall",
    laneId: "main",
    timestamp,
    sessionId,
    iteration,
    toolUseId,
    toolName: "Bash",
    formattedArgs: '{"command":"ls"}',
  });
  const toolResult = (
    sessionId: string,
    iteration: number,
    toolUseId: string,
    result: string,
    timestamp: number,
    isError = false,
  ): SandcastleEvent => ({
    type: "agent.toolResult",
    laneId: "main",
    timestamp,
    sessionId,
    iteration,
    toolUseId,
    result,
    isError,
  });

  it("pairs a tool result with its tool call by toolUseId", () => {
    const idx = buildSessionIndex([
      sessionStart("s1", "T-1", 100),
      {
        type: "iteration.start",
        laneId: "main",
        timestamp: 110,
        sessionId: "s1",
        iteration: 1,
        startedAt: 110,
      },
      toolCall("s1", 1, "toolu_a", 120),
      toolResult("s1", 1, "toolu_a", "ok\n", 130),
    ]);
    const view = idx.getSession("s1");
    expect(view?.iterations[0]?.toolCalls).toHaveLength(1);
    expect(view?.iterations[0]?.toolCalls[0]).toMatchObject({
      toolName: "Bash",
      result: "ok\n",
      isError: false,
    });
  });

  it("preserves a tool call when no matching result has arrived yet", () => {
    const idx = buildSessionIndex([
      sessionStart("s1", "T-1", 100),
      {
        type: "iteration.start",
        laneId: "main",
        timestamp: 110,
        sessionId: "s1",
        iteration: 1,
        startedAt: 110,
      },
      toolCall("s1", 1, "toolu_a", 120),
    ]);
    const tc = idx.getSession("s1")?.iterations[0]?.toolCalls[0];
    expect(tc?.toolName).toBe("Bash");
    expect(tc?.result).toBeUndefined();
  });

  it("ignores a tool result whose toolUseId does not match any tool call", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const idx = buildSessionIndex([
        sessionStart("s1", "T-1", 100),
        {
          type: "iteration.start",
          laneId: "main",
          timestamp: 110,
          sessionId: "s1",
          iteration: 1,
          startedAt: 110,
        },
        toolCall("s1", 1, "toolu_a", 120),
        toolResult("s1", 1, "toolu_orphan", "should be dropped", 130),
      ]);
      const tc = idx.getSession("s1")?.iterations[0]?.toolCalls[0];
      expect(tc?.result).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("toolu_orphan"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("flags an error result with isError=true", () => {
    const idx = buildSessionIndex([
      sessionStart("s1", "T-1", 100),
      {
        type: "iteration.start",
        laneId: "main",
        timestamp: 110,
        sessionId: "s1",
        iteration: 1,
        startedAt: 110,
      },
      toolCall("s1", 1, "toolu_a", 120),
      toolResult("s1", 1, "toolu_a", "command not found", 130, true),
    ]);
    const tc = idx.getSession("s1")?.iterations[0]?.toolCalls[0];
    expect(tc?.isError).toBe(true);
    expect(tc?.result).toBe("command not found");
  });
});
