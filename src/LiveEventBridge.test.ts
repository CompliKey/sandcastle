/**
 * Verify that the bridge tails the on-disk EventStore, fans events out to the
 * broadcaster, and updates the SessionIndex so REST snapshots stay current.
 *
 * The bridge is what couples a fresh `sandcastle ui` process to events being
 * appended by a separate `sandcastle autopilot` process — without it the UI
 * is frozen at the moment of startup.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEventBroadcaster } from "./EventBroadcaster.js";
import { createEventStore, type SandcastleEvent } from "./EventStore.js";
import { startLiveEventBridge } from "./LiveEventBridge.js";
import { createSessionIndex } from "./SessionIndex.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sandcastle-bridge-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sessionStart = (sessionId: string, t: number): SandcastleEvent => ({
  type: "session.start",
  laneId: "main",
  timestamp: t,
  sessionId,
  ticketId: "VGD-127",
  scenario: "implement",
  startedAt: t,
});

const text = (sessionId: string, iter: number, t: number): SandcastleEvent => ({
  type: "agent.text",
  laneId: "main",
  timestamp: t,
  sessionId,
  iteration: iter,
  text: `t-${t}`,
});

describe("startLiveEventBridge", () => {
  it("publishes new events written by a separate writer to the broadcaster", async () => {
    const writer = createEventStore({ dir });
    const reader = createEventStore({ dir });
    const index = createSessionIndex();
    const broadcaster = createEventBroadcaster();
    const ac = new AbortController();

    await writer.append(sessionStart("ses_1", 100));

    const received: SandcastleEvent[] = [];
    broadcaster.subscribe({ type: "session", id: "ses_1" }, (e) => {
      received.push(e);
    });

    const bridge = startLiveEventBridge({
      store: reader,
      index,
      broadcaster,
      signal: ac.signal,
      pollIntervalMs: 25,
    });

    // Existing event should land first.
    await waitFor(() => received.length >= 1, 1000);

    // Now append while the bridge is running.
    await writer.append(text("ses_1", 1, 110));
    await waitFor(() => received.length >= 2, 1000);

    ac.abort();
    await bridge;
    await writer.close();
    await reader.close();

    expect(received.map((e) => e.type)).toEqual([
      "session.start",
      "agent.text",
    ]);
  });

  it("keeps the SessionIndex up to date so REST snapshots reflect new events", async () => {
    const writer = createEventStore({ dir });
    const reader = createEventStore({ dir });
    const index = createSessionIndex();
    const broadcaster = createEventBroadcaster();
    const ac = new AbortController();

    await writer.append(sessionStart("ses_2", 200));

    const bridge = startLiveEventBridge({
      store: reader,
      index,
      broadcaster,
      signal: ac.signal,
      pollIntervalMs: 25,
    });

    await waitFor(() => index.getSession("ses_2") !== undefined, 1000);

    await writer.append({
      type: "iteration.start",
      laneId: "main",
      timestamp: 210,
      sessionId: "ses_2",
      iteration: 1,
      startedAt: 210,
    });

    await waitFor(
      () => (index.getSession("ses_2")?.iterations.length ?? 0) >= 1,
      1000,
    );

    ac.abort();
    await bridge;
    await writer.close();
    await reader.close();

    const view = index.getSession("ses_2");
    expect(view?.iterations).toHaveLength(1);
    expect(view?.iterations[0]?.iteration).toBe(1);
  });
});

const waitFor = async (
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error("waitFor timed out");
};
