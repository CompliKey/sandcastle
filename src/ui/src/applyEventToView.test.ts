/**
 * Pure reducer that applies a SandcastleEvent on top of a SessionView. The
 * frontend uses it to keep its live state in sync with the WS event stream
 * without needing to re-fetch the snapshot every tick.
 *
 * Mirrors the semantics of `SessionIndex.add` on the backend — these tests
 * pin the contract that `applyEventToView(snapshot, event)` produces the
 * same output a backend index would after seeing one more event.
 */

import { describe, expect, it } from "vitest";

import { applyEventToView } from "./applyEventToView.js";
import type { SandcastleEvent, SessionView } from "./api.js";

const baseView = (overrides: Partial<SessionView> = {}): SessionView => ({
  sessionId: "ses_a",
  ticketId: "VGD-127",
  scenario: "implement",
  laneId: "main",
  startedAt: 100,
  iterations: [],
  commits: [],
  errors: [],
  rollup: {
    totalTokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    iterationCount: 0,
  },
  ...overrides,
});

describe("applyEventToView", () => {
  it("adds an iteration on iteration.start", () => {
    const next = applyEventToView(baseView(), {
      type: "iteration.start",
      laneId: "main",
      timestamp: 110,
      sessionId: "ses_a",
      iteration: 1,
      startedAt: 110,
    });
    expect(next.iterations).toHaveLength(1);
    expect(next.iterations[0]).toMatchObject({
      iteration: 1,
      startedAt: 110,
    });
    expect(next.rollup.iterationCount).toBe(1);
  });

  it("appends a tool call to its iteration on agent.toolCall", () => {
    const view = applyEventToView(baseView(), {
      type: "iteration.start",
      laneId: "main",
      timestamp: 110,
      sessionId: "ses_a",
      iteration: 1,
      startedAt: 110,
    });
    const next = applyEventToView(view, {
      type: "agent.toolCall",
      laneId: "main",
      timestamp: 120,
      sessionId: "ses_a",
      iteration: 1,
      toolName: "Bash",
      formattedArgs: '{"command":"ls"}',
    });
    expect(next.iterations[0]?.toolCalls).toHaveLength(1);
    expect(next.iterations[0]?.toolCalls[0]).toMatchObject({
      toolName: "Bash",
      formattedArgs: '{"command":"ls"}',
    });
  });

  it("rolls up token usage on iteration.end", () => {
    let view = applyEventToView(baseView(), {
      type: "iteration.start",
      laneId: "main",
      timestamp: 110,
      sessionId: "ses_a",
      iteration: 1,
      startedAt: 110,
    });
    view = applyEventToView(view, {
      type: "iteration.end",
      laneId: "main",
      timestamp: 200,
      sessionId: "ses_a",
      iteration: 1,
      endedAt: 200,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 30,
      },
    });
    expect(view.rollup.totalTokens).toEqual({
      input: 100,
      output: 50,
      cacheCreation: 20,
      cacheRead: 30,
    });
    expect(view.iterations[0]?.endedAt).toBe(200);
  });

  it("records session.end outcome and wall time", () => {
    const next = applyEventToView(baseView({ startedAt: 100 }), {
      type: "session.end",
      laneId: "main",
      timestamp: 500,
      sessionId: "ses_a",
      outcome: "done",
      endedAt: 500,
    });
    expect(next.outcome).toBe("done");
    expect(next.endedAt).toBe(500);
    expect(next.rollup.wallTimeMs).toBe(400);
  });

  it("appends commits at session level", () => {
    const next = applyEventToView(baseView(), {
      type: "commit",
      laneId: "main",
      timestamp: 150,
      sessionId: "ses_a",
      sha: "abc1234",
    });
    expect(next.commits).toEqual([{ sha: "abc1234", timestamp: 150 }]);
  });

  it("appends errors at session level", () => {
    const next = applyEventToView(baseView(), {
      type: "error",
      laneId: "main",
      timestamp: 160,
      sessionId: "ses_a",
      kind: "tool.failed",
      reason: "ENOENT",
    });
    expect(next.errors).toEqual([
      { kind: "tool.failed", reason: "ENOENT", timestamp: 160 },
    ]);
  });

  it("ignores events for other sessions", () => {
    const view = baseView();
    const next = applyEventToView(view, {
      type: "agent.text",
      laneId: "main",
      timestamp: 200,
      sessionId: "ses_other",
      iteration: 1,
      text: "leak",
    });
    expect(next).toBe(view);
  });
});
