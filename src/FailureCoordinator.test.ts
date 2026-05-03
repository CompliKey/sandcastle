import { beforeEach, describe, expect, it } from "vitest";

import type {
  BacklogManagerHostInterface,
  BacklogTicket,
  ListPendingOptions,
  MarkErroredArgs,
} from "./defineSandcastle.js";
import { createFailureCoordinator } from "./FailureCoordinator.js";

class FakeBacklogManager implements BacklogManagerHostInterface {
  public readonly markErroredCalls: MarkErroredArgs[] = [];
  public readonly clearErroredCalls: string[] = [];

  async listPending(_options?: ListPendingOptions): Promise<BacklogTicket[]> {
    return [];
  }
  async getTicket(id: string): Promise<BacklogTicket> {
    return { id, title: "t", body: "", labels: [], url: "https://x/" };
  }
  async markErrored(args: MarkErroredArgs): Promise<void> {
    this.markErroredCalls.push(args);
  }
  async clearErrored(id: string): Promise<void> {
    this.clearErroredCalls.push(id);
  }
}

describe("FailureCoordinator", () => {
  let backlog: FakeBacklogManager;

  beforeEach(() => {
    backlog = new FakeBacklogManager();
  });

  it("ticket-level failure → markErrored called with reason + comment, returns continue", async () => {
    const coord = createFailureCoordinator({ backlogManager: backlog });

    const result = await coord.handleFailure({
      ticketId: "VGD-1",
      category: "agent.max-iterations",
      message: "agent reached maxIterations=10 without COMPLETE",
    });

    expect(result.action).toBe("continue");
    expect(result.kind).toBe("ticket-level");
    expect(backlog.markErroredCalls).toHaveLength(1);
    expect(backlog.markErroredCalls[0]).toMatchObject({
      id: "VGD-1",
      reason: expect.stringContaining("max iterations"),
    });
    expect(backlog.markErroredCalls[0]?.comment).toContain(
      "agent reached maxIterations=10",
    );
  });

  it("infra-level failure does NOT call markErrored and returns halt", async () => {
    const coord = createFailureCoordinator({ backlogManager: backlog });

    const result = await coord.handleFailure({
      ticketId: "VGD-1",
      category: "sandbox.provider.error",
      message: "docker daemon unreachable",
    });

    expect(result.kind).toBe("infra-level");
    expect(result.action).toBe("halt");
    expect(backlog.markErroredCalls).toHaveLength(0);
  });

  it("circuit-breaker tripping STILL labels the ticket — `markErrored.reason` stays per-ticket; `haltReason` carries breaker context", async () => {
    const coord = createFailureCoordinator({ backlogManager: backlog });
    // Default threshold = 3. Two prior ticket-level failures get us to the boundary.
    await coord.handleFailure({
      ticketId: "VGD-1",
      category: "agent.max-iterations",
      message: "1st",
    });
    await coord.handleFailure({
      ticketId: "VGD-2",
      category: "agent.max-iterations",
      message: "2nd",
    });
    expect(coord.consecutiveTicketLevelFailures()).toBe(2);

    const result = await coord.handleFailure({
      ticketId: "VGD-3",
      category: "agent.max-iterations",
      message: "3rd",
    });

    expect(result.action).toBe("halt");
    expect(result.kind).toBe("ticket-level");
    // Per-ticket reason stays greppable.
    expect(result.reason).toBe("agent hit max iterations without completing");
    expect(result.haltReason).toBe("3 consecutive ticket-level failures");
    // The third ticket still gets labelled — only the queue halts. And the
    // reason JIRA receives is the per-ticket reason, NOT the breaker context.
    expect(backlog.markErroredCalls).toHaveLength(3);
    expect(backlog.markErroredCalls[2]).toMatchObject({
      id: "VGD-3",
      reason: "agent hit max iterations without completing",
    });
    expect(backlog.markErroredCalls[2]?.reason).not.toMatch(/consecutive/);
  });

  it("noteSuccess resets the consecutive failure counter", async () => {
    const coord = createFailureCoordinator({ backlogManager: backlog });
    await coord.handleFailure({
      ticketId: "VGD-1",
      category: "agent.max-iterations",
      message: "boom",
    });
    await coord.handleFailure({
      ticketId: "VGD-2",
      category: "agent.idle-timeout",
      message: "boom",
    });
    expect(coord.consecutiveTicketLevelFailures()).toBe(2);

    coord.noteSuccess();
    expect(coord.consecutiveTicketLevelFailures()).toBe(0);

    // Next ticket-level failure should now be the 1st of a new streak — continues.
    const after = await coord.handleFailure({
      ticketId: "VGD-3",
      category: "agent.max-iterations",
      message: "fresh",
    });
    expect(after.action).toBe("continue");
  });

  it("infra-level failures do not increment the ticket-level counter", async () => {
    const coord = createFailureCoordinator({ backlogManager: backlog });
    await coord.handleFailure({
      ticketId: "VGD-1",
      category: "sandbox.provider.error",
      message: "infra",
    });
    await coord.handleFailure({
      ticketId: "VGD-2",
      category: "spawn.failed",
      message: "infra",
    });
    expect(coord.consecutiveTicketLevelFailures()).toBe(0);
  });

  it("respects an injected policyConfig (threshold = 1) — first failure halts", async () => {
    const coord = createFailureCoordinator({
      backlogManager: backlog,
      policyConfig: { consecutiveFailureThreshold: 1 },
    });

    const result = await coord.handleFailure({
      ticketId: "VGD-1",
      category: "agent.max-iterations",
      message: "msg",
    });

    expect(result.action).toBe("halt");
    expect(backlog.markErroredCalls).toHaveLength(1);
  });

  it("omits `comment` from markErrored when the message is empty/whitespace", async () => {
    const coord = createFailureCoordinator({ backlogManager: backlog });

    await coord.handleFailure({
      ticketId: "VGD-1",
      category: "agent.max-iterations",
      message: "",
    });
    await coord.handleFailure({
      ticketId: "VGD-2",
      category: "agent.max-iterations",
      message: "   \n  \t",
    });

    expect(backlog.markErroredCalls).toHaveLength(2);
    expect(backlog.markErroredCalls[0]).not.toHaveProperty("comment");
    expect(backlog.markErroredCalls[1]).not.toHaveProperty("comment");
  });

  it("trims whitespace from `comment` when message has leading/trailing whitespace", async () => {
    const coord = createFailureCoordinator({ backlogManager: backlog });

    await coord.handleFailure({
      ticketId: "VGD-1",
      category: "agent.max-iterations",
      message: "  the actual message  \n",
    });

    expect(backlog.markErroredCalls[0]?.comment).toBe("the actual message");
  });

  it("never calls clearErrored — that's the host orchestrator's job, not the coordinator's", async () => {
    const coord = createFailureCoordinator({ backlogManager: backlog });

    await coord.handleFailure({
      ticketId: "VGD-1",
      category: "agent.max-iterations",
      message: "boom",
    });
    coord.noteSuccess();
    await coord.handleFailure({
      ticketId: "VGD-2",
      category: "sandbox.provider.error",
      message: "infra boom",
    });

    expect(backlog.clearErroredCalls).toHaveLength(0);
  });

  it("propagates a thrown markErrored AND leaves the consecutive counter unchanged (load-bearing)", async () => {
    // If the backlog system is down, we propagate the error and do NOT
    // increment — a permanently-broken backlog must not false-trip the
    // breaker against tickets it never managed to label.
    const throwing: BacklogManagerHostInterface = {
      async listPending() {
        return [];
      },
      async getTicket(id) {
        return { id, title: "t", body: "", labels: [], url: "https://x/" };
      },
      async markErrored() {
        throw new Error("JIRA 503");
      },
      async clearErrored() {
        /* unused */
      },
    };
    const coord = createFailureCoordinator({ backlogManager: throwing });

    await expect(
      coord.handleFailure({
        ticketId: "VGD-1",
        category: "agent.max-iterations",
        message: "boom",
      }),
    ).rejects.toThrow("JIRA 503");

    expect(coord.consecutiveTicketLevelFailures()).toBe(0);

    // And again, just to make sure repeated failures against a broken backlog
    // can never trip the breaker on their own.
    await expect(
      coord.handleFailure({
        ticketId: "VGD-2",
        category: "agent.max-iterations",
        message: "boom",
      }),
    ).rejects.toThrow();
    expect(coord.consecutiveTicketLevelFailures()).toBe(0);
  });

  it("returns haltReason on infra-level failures (mirrors reason)", async () => {
    const coord = createFailureCoordinator({ backlogManager: backlog });

    const result = await coord.handleFailure({
      ticketId: "VGD-1",
      category: "sandbox.provider.error",
      message: "docker down",
    });

    expect(result.action).toBe("halt");
    expect(result.haltReason).toBe(result.reason);
  });

  it("does not include haltReason on continue results", async () => {
    const coord = createFailureCoordinator({ backlogManager: backlog });

    const result = await coord.handleFailure({
      ticketId: "VGD-1",
      category: "agent.max-iterations",
      message: "boom",
    });

    expect(result.action).toBe("continue");
    expect(result).not.toHaveProperty("haltReason");
  });
});
