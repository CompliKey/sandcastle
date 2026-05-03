import { describe, expect, it } from "vitest";

import {
  classifyFailure,
  type FailureCategory,
  type FailureKind,
} from "./FailurePolicy.js";

describe("FailurePolicy.classifyFailure", () => {
  it("classifies agent.max-iterations as ticket-level → continue", () => {
    const result = classifyFailure({
      category: "agent.max-iterations",
      message: "agent reached maxIterations=10 without COMPLETE",
      consecutiveTicketLevelFailures: 0,
    });

    expect(result.kind).toBe("ticket-level");
    expect(result.action).toBe("continue");
    expect(result.reason).toContain("max iterations");
  });

  it("classifies sandbox.provider.error as infra-level → halt", () => {
    const result = classifyFailure({
      category: "sandbox.provider.error",
      message: "docker daemon unreachable",
      consecutiveTicketLevelFailures: 0,
    });

    expect(result.kind).toBe("infra-level");
    expect(result.action).toBe("halt");
    expect(result.reason).toContain("sandbox provider");
  });

  describe("v1 rule-set classification table", () => {
    const cases: ReadonlyArray<readonly [FailureCategory, FailureKind]> = [
      // ticket-level
      ["agent.max-iterations", "ticket-level"],
      ["agent.idle-timeout", "ticket-level"],
      ["agent.token-budget-exceeded", "ticket-level"],
      ["hook.ticket-bound.failed", "ticket-level"],
      ["scenario.threw", "ticket-level"],
      // infra-level
      ["sandbox.provider.error", "infra-level"],
      ["sandbox.container.start.failed", "infra-level"],
      ["env.resolution.failed", "infra-level"],
      ["hook.host.failed", "infra-level"],
      ["spawn.failed", "infra-level"],
      ["config.load.failed", "infra-level"],
    ];

    for (const [category, expectedKind] of cases) {
      it(`${category} → ${expectedKind}`, () => {
        const result = classifyFailure({
          category,
          message: "msg",
          consecutiveTicketLevelFailures: 0,
        });
        expect(result.kind).toBe(expectedKind);
        expect(result.action).toBe(
          expectedKind === "infra-level" ? "halt" : "continue",
        );
        expect(result.reason.length).toBeGreaterThan(0);
      });
    }
  });

  describe("circuit breaker", () => {
    it("just below the default threshold, ticket-level still continues", () => {
      // prior=1 + this = 2nd consecutive (default threshold 3) → continue.
      const result = classifyFailure({
        category: "agent.max-iterations",
        message: "msg",
        consecutiveTicketLevelFailures: 1,
      });
      expect(result.kind).toBe("ticket-level");
      expect(result.action).toBe("continue");
    });

    it("at the default threshold, action flips to halt with a circuit-breaker reason", () => {
      // prior=2 + this = 3rd consecutive (default threshold 3) → halt.
      const result = classifyFailure({
        category: "agent.max-iterations",
        message: "msg",
        consecutiveTicketLevelFailures: 2,
      });
      expect(result.kind).toBe("ticket-level");
      expect(result.action).toBe("halt");
      expect(result.reason).toMatch(
        /^halted: 3 consecutive ticket-level failures/,
      );
    });

    it("infra-level always halts and never reports the circuit-breaker reason", () => {
      const result = classifyFailure({
        category: "sandbox.provider.error",
        message: "msg",
        consecutiveTicketLevelFailures: 99,
      });
      expect(result.kind).toBe("infra-level");
      expect(result.action).toBe("halt");
      expect(result.reason).not.toMatch(/consecutive/);
    });

    it("respects a configured threshold of 1 — first ticket-level failure halts", () => {
      const result = classifyFailure(
        {
          category: "agent.max-iterations",
          message: "msg",
          consecutiveTicketLevelFailures: 0,
        },
        { consecutiveFailureThreshold: 1 },
      );
      expect(result.action).toBe("halt");
      expect(result.reason).toMatch(/^halted: 1 consecutive/);
    });

    it("respects a configured threshold of 5 — does not halt at 3", () => {
      const result = classifyFailure(
        {
          category: "agent.max-iterations",
          message: "msg",
          consecutiveTicketLevelFailures: 2, // 3rd consecutive
        },
        { consecutiveFailureThreshold: 5 },
      );
      expect(result.action).toBe("continue");
    });
  });
});
