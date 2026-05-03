import { describe, expect, it } from "vitest";

import type {
  BacklogManagerHostInterface,
  BacklogTicket,
  ListPendingOptions,
  MarkErroredArgs,
} from "./defineSandcastle.js";
import type { ScenarioRunResult } from "./ScenarioRunner.js";
import { createAutopilotController } from "./AutopilotController.js";

// ---------------------------------------------------------------------------
// Fakes — kept inline rather than depending on FailureCoordinator.test.ts to
// avoid a test-helper export surface that would creep into production.
// ---------------------------------------------------------------------------

class FakeBacklog implements BacklogManagerHostInterface {
  public readonly markErroredCalls: MarkErroredArgs[] = [];
  public readonly clearErroredCalls: string[] = [];
  public listPendingResults: BacklogTicket[][] = [];

  async listPending(_options?: ListPendingOptions): Promise<BacklogTicket[]> {
    return this.listPendingResults.shift() ?? [];
  }
  async getTicket(id: string): Promise<BacklogTicket> {
    return { id, title: id, body: "", labels: [], url: "https://x/" };
  }
  async markErrored(args: MarkErroredArgs): Promise<void> {
    this.markErroredCalls.push(args);
  }
  async clearErrored(id: string): Promise<void> {
    this.clearErroredCalls.push(id);
  }
}

const ticket = (id: string): BacklogTicket => ({
  id,
  title: id,
  body: "",
  labels: [],
  url: "https://x/",
});

const doneResult = (sessionId: string): ScenarioRunResult => ({
  sessionId,
  outcome: "done",
  exitCode: 0,
  signal: null,
});

const erroredResult = (sessionId: string): ScenarioRunResult => ({
  sessionId,
  outcome: "errored",
  exitCode: 1,
  signal: null,
});

// Wait for a few microtask + setTimeout(0) ticks so the loop's `done` promise
// settles after we abort. The loop polls + sleeps with the test's clock.
const flush = async (n: number = 5): Promise<void> => {
  for (let i = 0; i < n; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
};

describe("AutopilotController — initial state", () => {
  it("starts in `off` with zero counters", () => {
    const backlog = new FakeBacklog();
    const ctrl = createAutopilotController({
      backlogManager: backlog,
      runScenario: () => Promise.resolve(doneResult("ses_x")),
    });
    expect(ctrl.state()).toEqual({
      status: "off",
      ticketsAttempted: 0,
      ticketsCompleted: 0,
      ticketsErrored: 0,
    });
  });
});

describe("AutopilotController — start / stop", () => {
  it("rejects start with empty scenario", () => {
    const ctrl = createAutopilotController({
      backlogManager: new FakeBacklog(),
      runScenario: () => Promise.resolve(doneResult("ses_x")),
    });
    const r = ctrl.start({ scenario: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("transitions to `on` immediately on start, then `off` on stop after the loop drains", async () => {
    const backlog = new FakeBacklog();
    // Empty queue so the loop sleeps idle until aborted.
    backlog.listPendingResults = [[]];

    const ctrl = createAutopilotController({
      backlogManager: backlog,
      runScenario: () => Promise.resolve(doneResult("ses_x")),
      idlePollIntervalMs: 1,
    });

    const r = ctrl.start({ scenario: "default" });
    expect(r.ok).toBe(true);
    expect(ctrl.state().status).toBe("on");
    expect(ctrl.state().scenario).toBe("default");

    const stopped = ctrl.stop();
    expect(stopped.ok).toBe(true);
    expect(ctrl.state().status).toBe("off");

    await ctrl.shutdown();
  });

  it("rejects start while already running", () => {
    const ctrl = createAutopilotController({
      backlogManager: new FakeBacklog(),
      runScenario: () => Promise.resolve(doneResult("ses_x")),
      idlePollIntervalMs: 1,
    });
    ctrl.start({ scenario: "x" });
    const second = ctrl.start({ scenario: "y" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.status).toBe(409);
  });
});

describe("AutopilotController — halt + resume", () => {
  it("transitions to `halted` when the loop returns an infra-level halt", async () => {
    const backlog = new FakeBacklog();
    // listPending throws → infra-level halt
    backlog.listPending = async () => {
      throw new Error("backlog unreachable");
    };
    const ctrl = createAutopilotController({
      backlogManager: backlog,
      runScenario: () => Promise.resolve(doneResult("unused")),
      idlePollIntervalMs: 1,
    });

    ctrl.start({ scenario: "default" });
    await flush(20);

    const s = ctrl.state();
    expect(s.status).toBe("halted");
    expect(s.haltKind).toBe("infra-level");
    expect(s.haltReason).toMatch(/listPending failed/);
    expect(s.scenario).toBe("default");
  });

  it("transitions to `halted` with `ticket-level` kind when the breaker trips", async () => {
    const backlog = new FakeBacklog();
    // 3 errored tickets → breaker (default threshold 3) trips on the 3rd.
    backlog.listPendingResults = [
      [ticket("VGD-1")],
      [ticket("VGD-2")],
      [ticket("VGD-3")],
    ];

    const ctrl = createAutopilotController({
      backlogManager: backlog,
      runScenario: ({ ticketId }) =>
        Promise.resolve(erroredResult(`ses_${ticketId}`)),
      idlePollIntervalMs: 1,
    });

    ctrl.start({ scenario: "default" });
    await flush(30);

    const s = ctrl.state();
    expect(s.status).toBe("halted");
    expect(s.haltKind).toBe("ticket-level");
    expect(s.haltReason).toMatch(/consecutive ticket-level failures/);
    expect(s.ticketsAttempted).toBe(3);
    expect(s.ticketsErrored).toBe(3);
  });

  it("resume() rejects when not halted", () => {
    const ctrl = createAutopilotController({
      backlogManager: new FakeBacklog(),
      runScenario: () => Promise.resolve(doneResult("x")),
    });
    const r = ctrl.resume();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it("resume() restarts with the same scenario and resets the breaker counter", async () => {
    const backlog = new FakeBacklog();
    backlog.listPending = async () => {
      throw new Error("infra-fail");
    };
    const ctrl = createAutopilotController({
      backlogManager: backlog,
      runScenario: () => Promise.resolve(doneResult("x")),
      idlePollIntervalMs: 1,
    });
    ctrl.start({ scenario: "default" });
    await flush(20);
    expect(ctrl.state().status).toBe("halted");

    // Fix the backlog so the resumed loop idles cleanly.
    backlog.listPending = async () => [];

    const r = ctrl.resume();
    expect(r.ok).toBe(true);
    expect(ctrl.state().status).toBe("on");
    expect(ctrl.state().scenario).toBe("default");

    ctrl.stop();
    await ctrl.shutdown();
  });
});

describe("AutopilotController — onStateChange + counters", () => {
  it("notifies onStateChange on every transition and tracks attempted/completed counters live", async () => {
    const backlog = new FakeBacklog();
    backlog.listPendingResults = [[ticket("VGD-A")], [ticket("VGD-B")], []];

    const transitions: string[] = [];
    const ctrl = createAutopilotController({
      backlogManager: backlog,
      runScenario: ({ ticketId }) =>
        Promise.resolve(doneResult(`ses_${ticketId}`)),
      idlePollIntervalMs: 1,
      onStateChange: (s) =>
        transitions.push(
          `${s.status}/${s.ticketsAttempted}/${s.ticketsCompleted}`,
        ),
    });

    ctrl.start({ scenario: "default" });
    await flush(30);
    ctrl.stop();
    await ctrl.shutdown();

    // First transition is on→0/0/0 (start), then attempted++ as tickets are
    // picked, then completed++ as they succeed. Order is: start, attempt-A,
    // done-A, attempt-B, done-B, ... then off when stopped.
    expect(transitions[0]).toBe("on/0/0");
    expect(transitions).toContain("on/1/0");
    expect(transitions).toContain("on/2/2");
    // Final transition is the off after stop().
    expect(transitions[transitions.length - 1]?.startsWith("off")).toBe(true);
  });
});
