/**
 * End-to-end smoke test for the autopilot path.
 *
 * Wires the real {@link runOrchestrationLoop} + real {@link createFailureCoordinator}
 * + real {@link runScenario} (with scripted ESM child modules) + an in-memory
 * backlog manager that honours the `BacklogManagerHostInterface` contract.
 *
 * Catches integration regressions the per-module unit tests miss:
 *  - The loop's `runScenario` shim correctly threads `ticketId` into the child.
 *  - `markErrored` actually excludes the ticket from the next `listPending`.
 *  - Circuit-breaker halt on consecutive child crashes works with the real
 *    `ScenarioRunner` outcome semantics (not just stubbed ones).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  BacklogManagerHostInterface,
  BacklogTicket,
  ListPendingOptions,
  MarkErroredArgs,
} from "./defineSandcastle.js";
import { createEventStore, type EventStore } from "./EventStore.js";
import { createFailureCoordinator } from "./FailureCoordinator.js";
import { runOrchestrationLoop } from "./OrchestrationLoop.js";
import { runScenario } from "./ScenarioRunner.js";

class InMemoryBacklog implements BacklogManagerHostInterface {
  public readonly markErroredCalls: MarkErroredArgs[] = [];
  private readonly tickets: BacklogTicket[];

  constructor(initial: readonly BacklogTicket[]) {
    this.tickets = initial.map((t) => ({ ...t, labels: [...t.labels] }));
  }
  async listPending(options?: ListPendingOptions): Promise<BacklogTicket[]> {
    return this.tickets
      .filter(
        (t) => options?.includeErrored || !t.labels.includes("agent-error"),
      )
      .map((t) => ({ ...t, labels: [...t.labels] }));
  }
  async getTicket(id: string): Promise<BacklogTicket> {
    const found = this.tickets.find((t) => t.id === id);
    if (!found) throw new Error(`unknown ticket ${id}`);
    return { ...found, labels: [...found.labels] };
  }
  async markErrored(args: MarkErroredArgs): Promise<void> {
    this.markErroredCalls.push(args);
    const t = this.tickets.find((x) => x.id === args.id);
    if (t && !t.labels.includes("agent-error")) {
      (t.labels as string[]).push("agent-error");
    }
  }
  async clearErrored(id: string): Promise<void> {
    const t = this.tickets.find((x) => x.id === id);
    if (t) (t.labels as string[]) = t.labels.filter((l) => l !== "agent-error");
  }
  /** Called by the test harness when a scenario "ships" a ticket. */
  complete(id: string): void {
    const idx = this.tickets.findIndex((t) => t.id === id);
    if (idx >= 0) this.tickets.splice(idx, 1);
  }
}

const ticket = (id: string): BacklogTicket => ({
  id,
  title: `${id} title`,
  body: "",
  labels: [],
  url: `https://example/${id}`,
});

describe("OrchestrationLoop — autopilot end-to-end smoke", () => {
  let dir: string;
  let store: EventStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "autopilot-smoke-"));
    store = createEventStore({ dir });
  });

  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const writeChild = async (
    filename: string,
    source: string,
  ): Promise<string> => {
    const path = join(dir, filename);
    await writeFile(path, source, "utf8");
    return path;
  };

  it("drains a queue end-to-end: 2 successes + 1 ticket-level failure with markErrored", async () => {
    // Child looks at SANDCASTLE_TICKET_ID and decides whether to "succeed" or
    // "crash". Successful runs are reported back to the harness via stderr so
    // the harness can call `backlog.complete()` to mirror a merged PR.
    const child = await writeChild(
      "smart-child.mjs",
      `
      const id = process.env.SANDCASTLE_TICKET_ID;
      if (id === "FAIL") {
        process.exit(7);
      } else {
        process.send({ kind: "iteration.start", iteration: 1 });
        process.send({ kind: "agent.text", iteration: 1, text: "shipped " + id });
        process.send({ kind: "iteration.end", iteration: 1 });
        setTimeout(() => process.exit(0), 25);
      }
      `,
    );

    const backlog = new InMemoryBacklog([
      ticket("OK-1"),
      ticket("FAIL"),
      ticket("OK-2"),
    ]);
    const coordinator = createFailureCoordinator({ backlogManager: backlog });
    const ac = new AbortController();

    // Idle sleep aborts the loop so the test terminates after the queue drains.
    const sleep = async (_ms: number, _signal: AbortSignal): Promise<void> => {
      ac.abort();
    };

    const result = await runOrchestrationLoop({
      scenario: "ship-ticket",
      backlogManager: backlog,
      failureCoordinator: coordinator,
      signal: ac.signal,
      sleep,
      runScenario: async (args) => {
        const res = await runScenario({
          scenario: args.scenario,
          ticketId: args.ticketId,
          configPath: "/tmp/main.ts",
          store,
          childModulePath: child,
          stdio: "ignore",
        });
        // Simulate "PR merged → ticket transitioned → drops out of backlog".
        if (res.outcome === "done") backlog.complete(args.ticketId);
        return res;
      },
    });

    expect(result.status).toBe("aborted");
    expect(result.ticketsAttempted).toBe(3);
    expect(result.ticketsCompleted).toBe(2);
    expect(result.ticketsErrored).toBe(1);
    expect(backlog.markErroredCalls).toHaveLength(1);
    expect(backlog.markErroredCalls[0]?.id).toBe("FAIL");
  });

  it("circuit-breaker halts after 3 consecutive child crashes", async () => {
    const child = await writeChild("crash-child.mjs", `process.exit(13);`);

    const backlog = new InMemoryBacklog([
      ticket("F-1"),
      ticket("F-2"),
      ticket("F-3"),
      ticket("F-4"),
    ]);
    const coordinator = createFailureCoordinator({ backlogManager: backlog });
    const ac = new AbortController();

    const result = await runOrchestrationLoop({
      scenario: "ship-ticket",
      backlogManager: backlog,
      failureCoordinator: coordinator,
      signal: ac.signal,
      runScenario: (args) =>
        runScenario({
          scenario: args.scenario,
          ticketId: args.ticketId,
          configPath: "/tmp/main.ts",
          store,
          childModulePath: child,
          stdio: "ignore",
        }),
    });

    expect(result.status).toBe("halted");
    expect(result.reason).toBe("3 consecutive ticket-level failures");
    expect(result.ticketsErrored).toBe(3);
    expect(backlog.markErroredCalls.map((c) => c.id)).toEqual([
      "F-1",
      "F-2",
      "F-3",
    ]);
  });
});
