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

  it("circuit-breaker tripping STILL labels the ticket but returns halt", async () => {
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
    expect(result.reason).toMatch(/^halted: 3 consecutive/);
    // The third ticket still gets labelled — only the queue halts.
    expect(backlog.markErroredCalls).toHaveLength(3);
    expect(backlog.markErroredCalls[2]?.id).toBe("VGD-3");
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
});
