/**
 * Implementation-agnostic contract tests for `BacklogManagerHostInterface`.
 *
 * Any concrete backlog manager (JIRA, GitHub Issues, an in-memory fake) is
 * expected to satisfy this suite. The fixture supplies seeding hooks and
 * out-of-band comment inspection so the suite can verify side effects that
 * the interface itself does not expose.
 *
 * Imported by `*.test.ts` files; not auto-discovered by vitest because it
 * does not match the `*.test.ts` glob.
 */

import { describe, expect, it } from "vitest";

import type {
  BacklogManagerHostInterface,
  BacklogTicket,
} from "./defineSandcastle.js";

/** Subset of `BacklogTicket` a contract fixture must accept when seeding. */
export interface SeedTicket {
  readonly id: string;
  readonly title: string;
  readonly body?: string;
  readonly labels?: readonly string[];
  readonly priority?: string;
}

export interface ContractFixture {
  readonly manager: BacklogManagerHostInterface;
  /** Replace the backing store with the given tickets. */
  readonly seed: (tickets: readonly SeedTicket[]) => void | Promise<void>;
  /** Read all comments posted to a ticket, oldest first. */
  readonly getComments: (
    id: string,
  ) => readonly string[] | Promise<readonly string[]>;
  /** Read current labels on a ticket from the backing store. */
  readonly getLabels: (
    id: string,
  ) => readonly string[] | Promise<readonly string[]>;
  /** Whether `markErrored` would have transitioned status (must always be false). */
  readonly statusChangedDuringErrorFlow: () => boolean;
}

const ids = (tickets: readonly BacklogTicket[]): readonly string[] =>
  tickets.map((t) => t.id);

/**
 * Run the contract suite against an implementation. Each `it(...)` block calls
 * `setup()` to get a fresh fixture, so implementations must produce a clean
 * backing store on every call.
 */
export const runBacklogManagerHostInterfaceContract = (
  name: string,
  setup: () => Promise<ContractFixture> | ContractFixture,
): void => {
  describe(`BacklogManagerHostInterface contract: ${name}`, () => {
    it("listPending returns seeded TODO tickets in their seeded order", async () => {
      const fx = await setup();
      await fx.seed([
        { id: "T-1", title: "First" },
        { id: "T-2", title: "Second" },
        { id: "T-3", title: "Third" },
      ]);

      const pending = await fx.manager.listPending();
      expect(ids(pending)).toEqual(["T-1", "T-2", "T-3"]);
    });

    it("listPending excludes tickets labelled agent-error by default", async () => {
      const fx = await setup();
      await fx.seed([
        { id: "T-1", title: "Healthy" },
        { id: "T-2", title: "Errored", labels: ["agent-error"] },
        { id: "T-3", title: "Healthy too" },
      ]);

      const pending = await fx.manager.listPending();
      expect(ids(pending)).toEqual(["T-1", "T-3"]);
    });

    it("listPending({ includeErrored: true }) includes agent-error tickets", async () => {
      const fx = await setup();
      await fx.seed([
        { id: "T-1", title: "Healthy" },
        { id: "T-2", title: "Errored", labels: ["agent-error"] },
      ]);

      const pending = await fx.manager.listPending({ includeErrored: true });
      expect([...ids(pending)].sort()).toEqual(["T-1", "T-2"]);
    });

    it("getTicket returns id, title, body, labels and url", async () => {
      const fx = await setup();
      await fx.seed([
        {
          id: "T-1",
          title: "First",
          body: "Body text",
          labels: ["a", "b"],
        },
      ]);

      const ticket = await fx.manager.getTicket("T-1");
      expect(ticket.id).toBe("T-1");
      expect(ticket.title).toBe("First");
      expect(ticket.body).toBe("Body text");
      expect([...ticket.labels].sort()).toEqual(["a", "b"]);
      expect(ticket.url).toMatch(/^https?:\/\//);
    });

    it("markErrored applies agent-error label without transitioning status", async () => {
      const fx = await setup();
      await fx.seed([{ id: "T-1", title: "Healthy" }]);

      await fx.manager.markErrored({
        id: "T-1",
        reason: "max iterations exceeded",
      });

      expect(await fx.getLabels("T-1")).toContain("agent-error");
      expect(fx.statusChangedDuringErrorFlow()).toBe(false);

      const pending = await fx.manager.listPending();
      expect(ids(pending)).not.toContain("T-1");

      const pendingWithErrored = await fx.manager.listPending({
        includeErrored: true,
      });
      expect(ids(pendingWithErrored)).toContain("T-1");
    });

    it("markErrored posts a comment containing the reason and additional context", async () => {
      const fx = await setup();
      await fx.seed([{ id: "T-1", title: "Healthy" }]);

      await fx.manager.markErrored({
        id: "T-1",
        reason: "max iterations exceeded",
        comment: "last assistant message: 'I give up.'",
      });

      const comments = await fx.getComments("T-1");
      expect(comments).toHaveLength(1);
      expect(comments[0]).toContain("max iterations exceeded");
      expect(comments[0]).toContain("last assistant message: 'I give up.'");
    });

    it("markErrored is idempotent — applying twice keeps a single agent-error label", async () => {
      const fx = await setup();
      await fx.seed([{ id: "T-1", title: "Healthy" }]);

      await fx.manager.markErrored({ id: "T-1", reason: "first" });
      await fx.manager.markErrored({ id: "T-1", reason: "second" });

      const labels = await fx.getLabels("T-1");
      expect(labels.filter((l) => l === "agent-error")).toHaveLength(1);
    });

    it("clearErrored strips the agent-error label and posts a retry comment", async () => {
      const fx = await setup();
      await fx.seed([
        { id: "T-1", title: "Errored", labels: ["agent-error", "keep-me"] },
      ]);

      await fx.manager.clearErrored("T-1");

      const labels = await fx.getLabels("T-1");
      expect(labels).not.toContain("agent-error");
      expect(labels).toContain("keep-me");

      const comments = await fx.getComments("T-1");
      expect(comments).toHaveLength(1);
      expect(comments[0]?.toLowerCase()).toMatch(/retr(y|ied)/);

      const pending = await fx.manager.listPending();
      expect(ids(pending)).toContain("T-1");
    });

    it("clearErrored on a ticket without the label is a no-op for the label set", async () => {
      const fx = await setup();
      await fx.seed([{ id: "T-1", title: "Healthy", labels: ["keep-me"] }]);

      await fx.manager.clearErrored("T-1");

      const labels = await fx.getLabels("T-1");
      expect(labels).toContain("keep-me");
      expect(labels).not.toContain("agent-error");
    });
  });
};
