import { describe, expect, it, vi } from "vitest";

import type {
  BacklogManagerHostInterface,
  BacklogTicket,
  ListPendingOptions,
  MarkErroredArgs,
} from "./defineSandcastle.js";
import { createFailureCoordinator } from "./FailureCoordinator.js";
import {
  DEFAULT_IDLE_POLL_INTERVAL_MS,
  runOrchestrationLoop,
  type OrchestrationLoopOptions,
  type RunScenarioArgs,
} from "./OrchestrationLoop.js";
import type { ScenarioRunResult } from "./ScenarioRunner.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const ticket = (id: string, labels: readonly string[] = []): BacklogTicket => ({
  id,
  title: `${id} title`,
  body: "",
  labels,
  url: `https://example/${id}`,
});

/**
 * In-memory backlog manager that honors the host-interface contract:
 *  - listPending excludes tickets whose label set contains `agent-error`
 *  - markErrored adds `agent-error` to the ticket's labels
 *  - `complete(id)` is a test-only hook simulating a successful run removing
 *    the ticket from the backlog (in real JIRA this happens via PR merge →
 *    transition; the fake collapses that whole arc to a single call so the
 *    loop sees real "ticket disappears" behaviour between polls).
 */
class FakeBacklog implements BacklogManagerHostInterface {
  public listCalls = 0;
  public readonly markErroredCalls: MarkErroredArgs[] = [];
  public readonly clearErroredCalls: string[] = [];
  public listPendingError: Error | undefined;
  private readonly tickets: BacklogTicket[];

  constructor(initial: readonly BacklogTicket[]) {
    this.tickets = initial.map((t) => ({ ...t, labels: [...t.labels] }));
  }

  async listPending(options?: ListPendingOptions): Promise<BacklogTicket[]> {
    if (this.listPendingError) throw this.listPendingError;
    this.listCalls += 1;
    return this.tickets
      .filter(
        (t) => options?.includeErrored || !t.labels.includes("agent-error"),
      )
      .map((t) => ({ ...t, labels: [...t.labels] }));
  }
  async getTicket(id: string): Promise<BacklogTicket> {
    const found = this.tickets.find((t) => t.id === id);
    return found ? { ...found, labels: [...found.labels] } : ticket(id);
  }
  async markErrored(args: MarkErroredArgs): Promise<void> {
    this.markErroredCalls.push(args);
    const t = this.tickets.find((x) => x.id === args.id);
    if (t && !t.labels.includes("agent-error")) {
      (t.labels as string[]).push("agent-error");
    }
  }
  async clearErrored(id: string): Promise<void> {
    this.clearErroredCalls.push(id);
    const t = this.tickets.find((x) => x.id === id);
    if (t) {
      (t.labels as string[]) = t.labels.filter((l) => l !== "agent-error");
    }
  }
  /** Test-only: drop a ticket entirely (simulates "scenario completed → PR merged"). */
  complete(id: string): void {
    const idx = this.tickets.findIndex((t) => t.id === id);
    if (idx >= 0) this.tickets.splice(idx, 1);
  }
}

const result = (
  outcome: ScenarioRunResult["outcome"],
  overrides: Partial<ScenarioRunResult> = {},
): ScenarioRunResult => ({
  sessionId: overrides.sessionId ?? `sess-${outcome}`,
  outcome,
  exitCode: overrides.exitCode ?? (outcome === "done" ? 0 : 1),
  signal: overrides.signal ?? null,
});

const baseOptions = (
  partial: Partial<OrchestrationLoopOptions> & {
    backlogManager: BacklogManagerHostInterface;
    runScenario: OrchestrationLoopOptions["runScenario"];
    signal: AbortSignal;
  },
): OrchestrationLoopOptions => ({
  scenario: "default",
  failureCoordinator: createFailureCoordinator({
    backlogManager: partial.backlogManager,
  }),
  // Tests inject sleep so empty-queue idle returns immediately.
  sleep: async () => undefined,
  ...partial,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OrchestrationLoop", () => {
  it("drains a queue of N tickets, marking each done, then idles when empty", async () => {
    const backlog = new FakeBacklog([
      ticket("T-1"),
      ticket("T-2"),
      ticket("T-3"),
    ]);
    // A successful run "completes" the ticket — in real JIRA the merged PR
    // transitions it; here the fake drops it from the backlog.
    const runScenario = vi.fn(async (args: RunScenarioArgs) => {
      backlog.complete(args.ticketId);
      return result("done");
    });
    const ac = new AbortController();

    // Idle sleep aborts the loop so the test terminates after the queue drains.
    const sleep = vi.fn(async (_ms: number, signal: AbortSignal) => {
      ac.abort();
      // Mirror the real sleep contract: respect the signal.
      if (signal.aborted) return;
    });

    const res = await runOrchestrationLoop(
      baseOptions({
        backlogManager: backlog,
        runScenario,
        signal: ac.signal,
        sleep,
      }),
    );

    expect(runScenario).toHaveBeenCalledTimes(3);
    expect(runScenario.mock.calls.map((c) => c[0].ticketId)).toEqual([
      "T-1",
      "T-2",
      "T-3",
    ]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(res.status).toBe("aborted");
    expect(res.ticketsAttempted).toBe(3);
    expect(res.ticketsCompleted).toBe(3);
    expect(res.ticketsErrored).toBe(0);
    expect(backlog.markErroredCalls).toHaveLength(0);
  });

  it("on errored outcome, marks ticket errored via coordinator and continues", async () => {
    const backlog = new FakeBacklog([ticket("T-1"), ticket("T-2")]);
    const runScenario = vi
      .fn<OrchestrationLoopOptions["runScenario"]>()
      .mockImplementationOnce(async () => result("errored", { exitCode: 2 }))
      .mockImplementationOnce(async ({ ticketId }) => {
        backlog.complete(ticketId);
        return result("done");
      });
    const ac = new AbortController();
    const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {
      ac.abort();
    });

    const res = await runOrchestrationLoop(
      baseOptions({
        backlogManager: backlog,
        runScenario,
        signal: ac.signal,
        sleep,
      }),
    );

    expect(runScenario).toHaveBeenCalledTimes(2);
    expect(backlog.markErroredCalls).toHaveLength(1);
    expect(backlog.markErroredCalls[0]).toMatchObject({
      id: "T-1",
      reason: expect.stringContaining("scenario threw"),
    });
    expect(res.status).toBe("aborted");
    expect(res.ticketsAttempted).toBe(2);
    expect(res.ticketsCompleted).toBe(1);
    expect(res.ticketsErrored).toBe(1);
  });

  it("halts with circuit-breaker reason after N consecutive ticket-level failures", async () => {
    const backlog = new FakeBacklog([
      ticket("T-1"),
      ticket("T-2"),
      ticket("T-3"),
      ticket("T-4"),
    ]);
    const runScenario = vi.fn(async () => result("errored", { exitCode: 1 }));
    const ac = new AbortController();

    const res = await runOrchestrationLoop(
      baseOptions({
        backlogManager: backlog,
        runScenario,
        signal: ac.signal,
      }),
    );

    // Default threshold = 3; loop halts on the 3rd failure (T-3) without ever
    // pulling T-4. All three failed tickets are marked.
    expect(runScenario).toHaveBeenCalledTimes(3);
    expect(backlog.markErroredCalls.map((c) => c.id)).toEqual([
      "T-1",
      "T-2",
      "T-3",
    ]);
    expect(res.status).toBe("halted");
    expect(res.reason).toBe("3 consecutive ticket-level failures");
    expect(res.ticketsAttempted).toBe(3);
    expect(res.ticketsErrored).toBe(3);
  });

  it("halted outcome from runScenario exits cleanly without circuit-breaker accounting", async () => {
    const backlog = new FakeBacklog([ticket("T-1")]);
    const runScenario = vi.fn(async () =>
      result("halted", { signal: "SIGTERM" }),
    );
    const ac = new AbortController();

    const res = await runOrchestrationLoop(
      baseOptions({
        backlogManager: backlog,
        runScenario,
        signal: ac.signal,
      }),
    );

    // halted is the user pressing Ctrl-C — not a policy failure.
    expect(backlog.markErroredCalls).toHaveLength(0);
    expect(res.status).toBe("aborted");
    expect(res.ticketsErrored).toBe(0);
    expect(res.ticketsCompleted).toBe(0);
  });

  it("on listPending error, halts with infra-level reason without invoking scenario", async () => {
    const backlog = new FakeBacklog([]);
    backlog.listPendingError = new Error("backlog API down");
    const runScenario = vi.fn();
    const ac = new AbortController();

    const res = await runOrchestrationLoop(
      baseOptions({
        backlogManager: backlog,
        runScenario,
        signal: ac.signal,
      }),
    );

    expect(runScenario).not.toHaveBeenCalled();
    expect(res.status).toBe("halted");
    expect(res.reason).toContain("listPending failed");
    expect(res.reason).toContain("backlog API down");
  });

  it("idles using the default poll interval and signals the sleep with the loop signal", async () => {
    const backlog = new FakeBacklog([]);
    const runScenario = vi.fn();
    const ac = new AbortController();
    const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {
      ac.abort();
    });

    await runOrchestrationLoop(
      baseOptions({
        backlogManager: backlog,
        runScenario,
        signal: ac.signal,
        sleep,
      }),
    );

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]?.[0]).toBe(DEFAULT_IDLE_POLL_INTERVAL_MS);
    expect(sleep.mock.calls[0]?.[1]).toBe(ac.signal);
  });

  it("respects a custom idlePollIntervalMs", async () => {
    const backlog = new FakeBacklog([]);
    const runScenario = vi.fn();
    const ac = new AbortController();
    const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {
      ac.abort();
    });

    await runOrchestrationLoop(
      baseOptions({
        backlogManager: backlog,
        runScenario,
        signal: ac.signal,
        sleep,
        idlePollIntervalMs: 250,
      }),
    );

    expect(sleep.mock.calls[0]?.[0]).toBe(250);
  });

  it("when signal is already aborted, exits immediately without listPending", async () => {
    const backlog = new FakeBacklog([ticket("T-1")]);
    const runScenario = vi.fn();
    const ac = new AbortController();
    ac.abort();

    const res = await runOrchestrationLoop(
      baseOptions({
        backlogManager: backlog,
        runScenario,
        signal: ac.signal,
      }),
    );

    expect(backlog.listCalls).toBe(0);
    expect(runScenario).not.toHaveBeenCalled();
    expect(res.status).toBe("aborted");
  });

  it("done outcome resets the consecutive-failure counter", async () => {
    const backlog = new FakeBacklog([
      ticket("E-1"),
      ticket("E-2"),
      ticket("OK"),
      ticket("E-3"),
      ticket("E-4"),
    ]);
    const runScenario = vi
      .fn<OrchestrationLoopOptions["runScenario"]>()
      .mockImplementationOnce(async () => result("errored"))
      .mockImplementationOnce(async () => result("errored"))
      .mockImplementationOnce(async ({ ticketId }) => {
        backlog.complete(ticketId);
        return result("done");
      })
      .mockImplementationOnce(async () => result("errored"))
      .mockImplementationOnce(async () => result("errored"));
    const ac = new AbortController();
    const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {
      ac.abort();
    });

    const res = await runOrchestrationLoop(
      baseOptions({
        backlogManager: backlog,
        runScenario,
        signal: ac.signal,
        sleep,
      }),
    );

    // Counter goes 1, 2, 0 (reset by OK), 1, 2 — never trips the breaker.
    expect(res.status).toBe("aborted");
    expect(res.ticketsCompleted).toBe(1);
    expect(res.ticketsErrored).toBe(4);
    expect(backlog.markErroredCalls.map((c) => c.id)).toEqual([
      "E-1",
      "E-2",
      "E-3",
      "E-4",
    ]);
  });

  it("emits structured logger events for major lifecycle transitions when logger provided", async () => {
    const backlog = new FakeBacklog([ticket("T-1")]);
    const runScenario = vi.fn(async ({ ticketId }) => {
      backlog.complete(ticketId);
      return result("done");
    });
    const ac = new AbortController();
    const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {
      ac.abort();
    });
    const logger = vi.fn();

    await runOrchestrationLoop(
      baseOptions({
        backlogManager: backlog,
        runScenario,
        signal: ac.signal,
        sleep,
        logger,
      }),
    );

    const events = logger.mock.calls.map((c) => c[0]);
    expect(events).toContain("autopilot.ticket.start");
    expect(events).toContain("autopilot.ticket.done");
    expect(events).toContain("autopilot.idle");
  });
});
