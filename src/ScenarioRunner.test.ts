import { fork as realFork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createEventStore,
  type EventStore,
  type SandcastleEvent,
} from "./EventStore.js";
import { runScenario } from "./ScenarioRunner.js";
import { SCENARIO_ENV } from "./scenarioIpcProtocol.js";

// ---------------------------------------------------------------------------
// Fake ChildProcess driven by the test
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  public connected = true;
  public killed = false;
  public lastSignal: NodeJS.Signals | null = null;

  disconnect(): void {
    this.connected = false;
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.lastSignal = (signal as NodeJS.Signals | undefined) ?? "SIGTERM";
    return true;
  }
}

const makeFakeFork = (
  drive: (child: FakeChild) => void,
): {
  fork: typeof realFork;
  lastChild: () => FakeChild;
  lastEnv: () => NodeJS.ProcessEnv | undefined;
} => {
  let lastChild: FakeChild | undefined;
  let lastEnv: NodeJS.ProcessEnv | undefined;
  const fork = ((modulePath, args, opts) => {
    const child = new FakeChild();
    lastChild = child;
    lastEnv = (opts as { env?: NodeJS.ProcessEnv } | undefined)?.env;
    // Defer driving until the runner has registered listeners.
    setImmediate(() => drive(child));
    return child as unknown as ChildProcess;
  }) as typeof realFork;
  return {
    fork,
    lastChild: () => lastChild!,
    lastEnv: () => lastEnv,
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const collectEvents = async (store: EventStore): Promise<SandcastleEvent[]> => {
  const events: SandcastleEvent[] = [];
  for await (const { event } of store.replay()) events.push(event);
  return events;
};

const tickClock = (start = 1_700_000_000_000): (() => number) => {
  let t = start;
  return () => t++;
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("ScenarioRunner", () => {
  let dir: string;
  let store: EventStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "scenario-runner-"));
    store = createEventStore({
      dir,
      clock: () => new Date("2026-05-01T12:00:00Z"),
    });
  });

  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("emits session.start, child events in order, and a session.end with outcome=done", async () => {
    const { fork, lastEnv } = makeFakeFork((child) => {
      child.emit("message", {
        kind: "iteration.start",
        iteration: 1,
      });
      child.emit("message", {
        kind: "agent.text",
        iteration: 1,
        text: "hello",
      });
      child.emit("message", {
        kind: "agent.toolCall",
        iteration: 1,
        toolName: "Read",
        formattedArgs: '{"path":"/tmp/x"}',
      });
      child.emit("message", { kind: "iteration.end", iteration: 1 });
      child.emit("message", { kind: "commit", sha: "abc1234" });
      child.emit("exit", 0, null);
    });

    const result = await runScenario({
      scenario: "ship-ticket",
      ticketId: "VGD-137",
      configPath: "/tmp/main.ts",
      store,
      sessionId: "ses-1",
      clock: tickClock(),
      childModulePath: "/dev/null",
      fork,
    });

    expect(result.outcome).toBe("done");
    expect(result.exitCode).toBe(0);

    // Env vars get propagated to the child.
    const env = lastEnv();
    expect(env?.[SCENARIO_ENV.scenario]).toBe("ship-ticket");
    expect(env?.[SCENARIO_ENV.ticketId]).toBe("VGD-137");
    expect(env?.[SCENARIO_ENV.sessionId]).toBe("ses-1");
    expect(env?.[SCENARIO_ENV.ipcMode]).toBe("1");

    const events = await collectEvents(store);
    expect(events.map((e) => e.type)).toEqual([
      "session.start",
      "iteration.start",
      "agent.text",
      "agent.toolCall",
      "iteration.end",
      "commit",
      "session.end",
    ]);
    const start = events[0]!;
    const end = events.at(-1)!;
    if (start.type !== "session.start") {
      throw new Error("expected session.start at offset 0");
    }
    expect(start.sessionId).toBe("ses-1");
    expect(start.scenario).toBe("ship-ticket");
    expect(start.ticketId).toBe("VGD-137");
    expect(start.laneId).toBe("main");
    expect(end.type).toBe("session.end");
    if (end.type === "session.end") {
      expect(end.outcome).toBe("done");
    }
  });

  it("non-zero exit code → outcome=errored", async () => {
    const { fork } = makeFakeFork((child) => {
      child.emit("message", {
        kind: "error",
        errorKind: "scenario.threw",
        reason: "boom",
      });
      child.emit("exit", 1, null);
    });

    const result = await runScenario({
      scenario: "ship-ticket",
      ticketId: "VGD-137",
      configPath: "/tmp/main.ts",
      store,
      sessionId: "ses-2",
      clock: tickClock(),
      childModulePath: "/dev/null",
      fork,
    });

    expect(result.outcome).toBe("errored");
    expect(result.exitCode).toBe(1);

    const events = await collectEvents(store);
    const end = events.at(-1)!;
    expect(end.type).toBe("session.end");
    if (end.type === "session.end") expect(end.outcome).toBe("errored");
    // The pre-exit `error` event survives.
    expect(events.find((e) => e.type === "error")).toBeDefined();
  });

  it("hard crash (no IPC, signal exit) → outcome=errored with session.end last", async () => {
    const { fork } = makeFakeFork((child) => {
      // Simulate SIGSEGV — no messages, signal-style exit.
      child.emit("exit", null, "SIGSEGV");
    });

    const result = await runScenario({
      scenario: "ship-ticket",
      ticketId: "VGD-137",
      configPath: "/tmp/main.ts",
      store,
      sessionId: "ses-3",
      clock: tickClock(),
      childModulePath: "/dev/null",
      fork,
    });

    expect(result.outcome).toBe("errored");
    expect(result.signal).toBe("SIGSEGV");

    const events = await collectEvents(store);
    expect(events.map((e) => e.type)).toEqual(["session.start", "session.end"]);
    const end = events.at(-1)!;
    if (end.type === "session.end") expect(end.outcome).toBe("errored");
  });

  it("aborting signal forwards SIGTERM and sets outcome=halted", async () => {
    const ac = new AbortController();
    const { fork, lastChild } = makeFakeFork((child) => {
      child.emit("message", { kind: "iteration.start", iteration: 1 });
      // Simulate the host sending SIGTERM to the parent. We trigger it via the
      // controller, then resolve the child exit a tick later (as if the child
      // honoured SIGTERM).
      setImmediate(() => {
        ac.abort();
        setImmediate(() => child.emit("exit", null, "SIGTERM"));
      });
    });

    const result = await runScenario({
      scenario: "ship-ticket",
      ticketId: "VGD-137",
      configPath: "/tmp/main.ts",
      store,
      sessionId: "ses-4",
      clock: tickClock(),
      childModulePath: "/dev/null",
      fork,
      signal: ac.signal,
    });

    expect(result.outcome).toBe("halted");
    expect(lastChild().killed).toBe(true);
    expect(lastChild().lastSignal).toBe("SIGTERM");

    const events = await collectEvents(store);
    const end = events.at(-1)!;
    if (end.type === "session.end") expect(end.outcome).toBe("halted");
  });

  it("already-aborted signal at entry kills the child immediately", async () => {
    const ac = new AbortController();
    ac.abort();
    const { fork, lastChild } = makeFakeFork((child) => {
      // Runner should have killed us before drive runs; emit exit so the
      // pending exit promise resolves.
      child.emit("exit", null, "SIGTERM");
    });

    const result = await runScenario({
      scenario: "ship-ticket",
      ticketId: "VGD-137",
      configPath: "/tmp/main.ts",
      store,
      sessionId: "ses-5",
      clock: tickClock(),
      childModulePath: "/dev/null",
      fork,
      signal: ac.signal,
    });

    expect(result.outcome).toBe("halted");
    expect(lastChild().killed).toBe(true);
  });

  it("rejects alien IPC payloads and keeps streaming valid ones", async () => {
    const { fork } = makeFakeFork((child) => {
      child.emit("message", { kind: "not-a-real-kind", iteration: 1 });
      child.emit("message", "naked string");
      child.emit("message", null);
      child.emit("message", {
        kind: "user.log",
        event: "checkpoint",
        data: { step: "after-build" },
      });
      child.emit("exit", 0, null);
    });

    const result = await runScenario({
      scenario: "ship-ticket",
      ticketId: "VGD-137",
      configPath: "/tmp/main.ts",
      store,
      sessionId: "ses-6",
      clock: tickClock(),
      childModulePath: "/dev/null",
      fork,
    });

    expect(result.outcome).toBe("done");
    const events = await collectEvents(store);
    expect(events.map((e) => e.type)).toEqual([
      "session.start",
      "user.log",
      "session.end",
    ]);
    const userLog = events.find((e) => e.type === "user.log")!;
    if (userLog.type === "user.log") {
      expect(userLog.payload).toEqual({
        event: "checkpoint",
        data: { step: "after-build" },
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Real-fork integration: actual node child, real IPC channel.
// One scripted scenario per case, written to a temp file.
// ---------------------------------------------------------------------------

describe("ScenarioRunner — real fork integration", () => {
  let dir: string;
  let store: EventStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "scenario-runner-real-"));
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

  it("delivers IPC events from a real child in arrival order", async () => {
    const child = await writeChild(
      "happy-child.mjs",
      `
      process.send({ kind: "iteration.start", iteration: 1 });
      process.send({ kind: "agent.text", iteration: 1, text: "hi" });
      process.send({ kind: "iteration.end", iteration: 1 });
      // Give the parent a tick to drain before exiting.
      setTimeout(() => process.exit(0), 25);
      `,
    );

    const result = await runScenario({
      scenario: "ship-ticket",
      ticketId: "VGD-137",
      configPath: "/tmp/main.ts",
      store,
      childModulePath: child,
      stdio: "ignore",
    });

    expect(result.outcome).toBe("done");
    expect(result.exitCode).toBe(0);
    const types = (await collectEvents(store)).map((e) => e.type);
    expect(types).toEqual([
      "session.start",
      "iteration.start",
      "agent.text",
      "iteration.end",
      "session.end",
    ]);
  });

  it("child crash without warning yields outcome=errored", async () => {
    const child = await writeChild("crash-child.mjs", `process.exit(42);`);

    const result = await runScenario({
      scenario: "ship-ticket",
      ticketId: "VGD-137",
      configPath: "/tmp/main.ts",
      store,
      childModulePath: child,
      stdio: "ignore",
    });

    expect(result.outcome).toBe("errored");
    expect(result.exitCode).toBe(42);
    const events = await collectEvents(store);
    expect(events.map((e) => e.type)).toEqual(["session.start", "session.end"]);
    const end = events.at(-1)!;
    if (end.type === "session.end") expect(end.outcome).toBe("errored");
  });

  it("SIGTERM on the parent terminates the child and writes session.end", async () => {
    const child = await writeChild(
      "long-child.mjs",
      `
      process.send({ kind: "iteration.start", iteration: 1 });
      // Park forever; only SIGTERM gets us out.
      process.on("SIGTERM", () => process.exit(0));
      setInterval(() => {}, 1000);
      `,
    );

    const ac = new AbortController();
    // Once the child is up and has sent its first message, abort.
    const abortSoon = setTimeout(() => ac.abort(), 100);

    const result = await runScenario({
      scenario: "ship-ticket",
      ticketId: "VGD-137",
      configPath: "/tmp/main.ts",
      store,
      childModulePath: child,
      stdio: "ignore",
      signal: ac.signal,
    });
    clearTimeout(abortSoon);

    expect(result.outcome).toBe("halted");

    const events = await collectEvents(store);
    const end = events.at(-1)!;
    expect(end.type).toBe("session.end");
    if (end.type === "session.end") expect(end.outcome).toBe("halted");

    // Sanity: events landed on disk in the expected JSONL file.
    const months = await store.listMonths();
    expect(months).toHaveLength(1);
    const onDisk = await readFile(
      join(dir, `events-${months[0]}.jsonl`),
      "utf8",
    );
    expect(onDisk.split("\n").filter((l) => l).length).toBe(events.length);
  });
});
