import { describe, expect, it } from "vitest";

import { createEventBroadcaster } from "./EventBroadcaster.js";
import type { SandcastleEvent } from "./EventStore.js";

const sampleEvent = (
  overrides: Partial<SandcastleEvent> = {},
): SandcastleEvent =>
  ({
    type: "agent.text",
    laneId: "main",
    timestamp: 1_000,
    sessionId: "sess_1",
    iteration: 1,
    text: "hello",
    ...overrides,
  }) as SandcastleEvent;

describe("EventBroadcaster", () => {
  it("delivers a published event to a subscriber on the matching session channel", () => {
    const bus = createEventBroadcaster();
    const received: SandcastleEvent[] = [];
    bus.subscribe({ type: "session", id: "sess_1" }, (e) => {
      received.push(e);
    });

    bus.publish(sampleEvent());

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "agent.text", text: "hello" });
  });

  it("does not deliver to subscribers on a different session channel", () => {
    const bus = createEventBroadcaster();
    const received: SandcastleEvent[] = [];
    bus.subscribe({ type: "session", id: "sess_other" }, (e) => {
      received.push(e);
    });

    bus.publish(sampleEvent({ sessionId: "sess_1" }));

    expect(received).toHaveLength(0);
  });

  it("delivers a published event to all-channel subscribers", () => {
    const bus = createEventBroadcaster();
    const received: SandcastleEvent[] = [];
    bus.subscribe({ type: "all" }, (e) => {
      received.push(e);
    });

    bus.publish(sampleEvent());

    expect(received).toHaveLength(1);
  });

  it("delivers a published event to lane-channel subscribers", () => {
    const bus = createEventBroadcaster();
    const received: SandcastleEvent[] = [];
    bus.subscribe({ type: "lane", id: "main" }, (e) => {
      received.push(e);
    });

    bus.publish(sampleEvent({ laneId: "main" }));

    expect(received).toHaveLength(1);
  });

  it("does not deliver to lane subscribers when laneId differs", () => {
    const bus = createEventBroadcaster();
    const received: SandcastleEvent[] = [];
    bus.subscribe({ type: "lane", id: "main" }, (e) => {
      received.push(e);
    });

    bus.publish(sampleEvent({ laneId: "secondary" }));

    expect(received).toHaveLength(0);
  });

  it("returned unsubscribe function stops further delivery", () => {
    const bus = createEventBroadcaster();
    const received: SandcastleEvent[] = [];
    const unsub = bus.subscribe({ type: "session", id: "sess_1" }, (e) => {
      received.push(e);
    });

    bus.publish(sampleEvent());
    unsub();
    bus.publish(sampleEvent({ text: "after-unsub" }));

    expect(received).toHaveLength(1);
  });

  it("survives a subscriber that throws — other subscribers still receive", () => {
    const bus = createEventBroadcaster();
    const received: SandcastleEvent[] = [];
    bus.subscribe({ type: "session", id: "sess_1" }, () => {
      throw new Error("subscriber blew up");
    });
    bus.subscribe({ type: "session", id: "sess_1" }, (e) => {
      received.push(e);
    });

    expect(() => bus.publish(sampleEvent())).not.toThrow();
    expect(received).toHaveLength(1);
  });
});
