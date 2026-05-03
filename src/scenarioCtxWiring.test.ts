import { describe, expect, it, vi } from "vitest";

import type { AgentStreamEvent } from "./AgentStreamEmitter.js";
import {
  createIterationBoundaryTracker,
  wireRun,
  type IpcSender,
} from "./scenarioCtxWiring.js";
import type { ScenarioChildMessage } from "./scenarioIpcProtocol.js";

const makeSender = (): {
  send: IpcSender;
  messages: ScenarioChildMessage[];
} => {
  const messages: ScenarioChildMessage[] = [];
  return { send: (m) => messages.push(m), messages };
};

const textEvent = (iter: number, message: string): AgentStreamEvent => ({
  type: "text",
  message,
  iteration: iter,
  timestamp: new Date(),
});

const toolEvent = (
  iter: number,
  name: string,
  formattedArgs: string,
): AgentStreamEvent => ({
  type: "toolCall",
  name,
  formattedArgs,
  iteration: iter,
  timestamp: new Date(),
});

describe("createIterationBoundaryTracker", () => {
  it("opens iteration 1 on the first event and projects text/toolCall faithfully", () => {
    const { send, messages } = makeSender();
    const t = createIterationBoundaryTracker(send);

    t.onEvent(textEvent(1, "hi"));
    t.onEvent(toolEvent(1, "Read", '{"path":"/a"}'));
    t.flush();

    expect(messages).toEqual([
      { kind: "iteration.start", iteration: 1 },
      { kind: "agent.text", iteration: 1, text: "hi" },
      {
        kind: "agent.toolCall",
        iteration: 1,
        toolName: "Read",
        formattedArgs: '{"path":"/a"}',
      },
      { kind: "iteration.end", iteration: 1 },
    ]);
  });

  it("emits iteration.end / iteration.start at iteration boundaries", () => {
    const { send, messages } = makeSender();
    const t = createIterationBoundaryTracker(send);

    t.onEvent(textEvent(1, "first"));
    t.onEvent(textEvent(2, "second")); // boundary
    t.onEvent(textEvent(3, "third")); // boundary
    t.flush();

    expect(messages.map((m) => m.kind)).toEqual([
      "iteration.start", // 1
      "agent.text",
      "iteration.end", // 1
      "iteration.start", // 2
      "agent.text",
      "iteration.end", // 2
      "iteration.start", // 3
      "agent.text",
      "iteration.end", // 3
    ]);
  });

  it("flush is idempotent and a no-op on an empty stream", () => {
    const { send, messages } = makeSender();
    const t = createIterationBoundaryTracker(send);
    t.flush();
    t.flush();
    expect(messages).toEqual([]);
  });
});

describe("wireRun", () => {
  it("passes through unchanged when not active", async () => {
    const impl = vi.fn(async () => ({
      iterations: [],
      commits: [],
      stdout: "",
    })) as never;
    const wired = wireRun({
      _runImpl: impl,
      active: () => false,
      send: () => {},
    });

    await wired({ agent: {} as never, sandbox: {} as never, prompt: "x" });
    expect(impl).toHaveBeenCalledTimes(1);
    const callArgs = (impl as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![0] as {
      logging?: unknown;
      signal?: unknown;
    };
    // No injection happened.
    expect(callArgs.logging).toBeUndefined();
  });

  it("when active, injects an onAgentStreamEvent callback that forwards to IPC", async () => {
    const messages: ScenarioChildMessage[] = [];
    const send: IpcSender = (m) => messages.push(m);

    const impl = vi.fn(
      async (opts: {
        logging?: { onAgentStreamEvent?: (e: AgentStreamEvent) => void };
      }) => {
        // Simulate the agent emitting two events across two iterations.
        opts.logging?.onAgentStreamEvent?.(textEvent(1, "alpha"));
        opts.logging?.onAgentStreamEvent?.(textEvent(2, "beta"));
        return { iterations: [], commits: [], stdout: "" };
      },
    ) as never;

    const wired = wireRun({
      _runImpl: impl,
      active: () => true,
      send,
    });

    await wired({ agent: {} as never, sandbox: {} as never, prompt: "x" });

    expect(messages.map((m) => m.kind)).toEqual([
      "iteration.start",
      "agent.text",
      "iteration.end",
      "iteration.start",
      "agent.text",
      "iteration.end", // flush
    ]);
  });

  it("chains a user-provided onAgentStreamEvent callback alongside IPC", async () => {
    const ipc: ScenarioChildMessage[] = [];
    const userCb = vi.fn();

    const impl = vi.fn(
      async (opts: {
        logging?: { onAgentStreamEvent?: (e: AgentStreamEvent) => void };
      }) => {
        opts.logging?.onAgentStreamEvent?.(textEvent(1, "x"));
        return { iterations: [], commits: [], stdout: "" };
      },
    ) as never;

    const wired = wireRun({
      _runImpl: impl,
      active: () => true,
      send: (m) => ipc.push(m),
    });

    await wired({
      agent: {} as never,
      sandbox: {} as never,
      prompt: "x",
      logging: { type: "file", path: "/tmp/x.log", onAgentStreamEvent: userCb },
    });

    expect(userCb).toHaveBeenCalledTimes(1);
    expect(ipc.find((m) => m.kind === "agent.text")).toBeDefined();
  });

  it("flushes the open iteration even if the underlying run rejects", async () => {
    const ipc: ScenarioChildMessage[] = [];
    const impl = vi.fn(
      async (opts: {
        logging?: { onAgentStreamEvent?: (e: AgentStreamEvent) => void };
      }) => {
        opts.logging?.onAgentStreamEvent?.(textEvent(1, "before-failure"));
        throw new Error("boom");
      },
    ) as never;

    const wired = wireRun({
      _runImpl: impl,
      active: () => true,
      send: (m) => ipc.push(m),
    });

    await expect(
      wired({ agent: {} as never, sandbox: {} as never, prompt: "x" }),
    ).rejects.toThrow("boom");

    // We still emitted an iteration.end before the rejection propagated.
    expect(ipc.map((m) => m.kind)).toEqual([
      "iteration.start",
      "agent.text",
      "iteration.end",
    ]);
  });
});
