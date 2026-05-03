/**
 * Live `/ws` channel — verify the snapshot-then-events protocol that the
 * frontend relies on.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEventBroadcaster } from "./EventBroadcaster.js";
import type { SandcastleEvent } from "./EventStore.js";
import { buildSessionIndex } from "./SessionIndex.js";
import { startUiServer, type UiServer } from "./UiServer.js";

const baseEvents = (): SandcastleEvent[] => [
  {
    type: "session.start",
    laneId: "main",
    timestamp: 100,
    sessionId: "ses_live",
    ticketId: "VGD-127",
    scenario: "implement",
    startedAt: 100,
  },
  {
    type: "iteration.start",
    laneId: "main",
    timestamp: 110,
    sessionId: "ses_live",
    iteration: 1,
    startedAt: 110,
  },
];

let server: UiServer | undefined;

beforeEach(() => {
  server = undefined;
});

afterEach(async () => {
  if (server) await server.close();
});

const waitOpen = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws open failed")), {
      once: true,
    });
  });

const nextMessage = (ws: WebSocket): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent): void => {
      ws.removeEventListener("message", onMsg);
      try {
        resolve(JSON.parse(typeof ev.data === "string" ? ev.data : ""));
      } catch (err) {
        reject(err);
      }
    };
    ws.addEventListener("message", onMsg);
  });

describe("UiServer /ws live channel", () => {
  it("first message is a snapshot of the requested session", async () => {
    const index = buildSessionIndex(baseEvents());
    const broadcaster = createEventBroadcaster();
    server = await startUiServer({ index, broadcaster, port: 0 });

    const ws = new WebSocket(
      `${server.url.replace(/^http/, "ws")}/ws?session=ses_live`,
    );
    await waitOpen(ws);
    const first = (await nextMessage(ws)) as {
      type: string;
      view?: { sessionId: string; iterations: unknown[] };
    };
    ws.close();

    expect(first.type).toBe("snapshot");
    expect(first.view?.sessionId).toBe("ses_live");
    expect(first.view?.iterations).toHaveLength(1);
  });

  it("forwards subsequent events for the subscribed session", async () => {
    const index = buildSessionIndex(baseEvents());
    const broadcaster = createEventBroadcaster();
    // Producer wires both: every event hits the index and the broadcaster.
    const publish = (event: SandcastleEvent): void => {
      index.add(event);
      broadcaster.publish(event);
    };
    server = await startUiServer({ index, broadcaster, port: 0 });

    const ws = new WebSocket(
      `${server.url.replace(/^http/, "ws")}/ws?session=ses_live`,
    );
    await waitOpen(ws);
    // Skip snapshot.
    await nextMessage(ws);

    publish({
      type: "agent.text",
      laneId: "main",
      timestamp: 120,
      sessionId: "ses_live",
      iteration: 1,
      text: "tracer",
    });

    const msg = (await nextMessage(ws)) as {
      type: string;
      event?: SandcastleEvent;
    };
    ws.close();

    expect(msg.type).toBe("event");
    expect(msg.event).toMatchObject({ type: "agent.text", text: "tracer" });
  });

  it("does not forward events for other sessions", async () => {
    const events = [
      ...baseEvents(),
      {
        type: "session.start" as const,
        laneId: "main",
        timestamp: 100,
        sessionId: "ses_other",
        ticketId: "VGD-128",
        scenario: "implement",
        startedAt: 100,
      },
    ];
    const index = buildSessionIndex(events);
    const broadcaster = createEventBroadcaster();
    server = await startUiServer({ index, broadcaster, port: 0 });

    const ws = new WebSocket(
      `${server.url.replace(/^http/, "ws")}/ws?session=ses_live`,
    );
    await waitOpen(ws);
    await nextMessage(ws); // snapshot

    let received = false;
    ws.addEventListener("message", () => {
      received = true;
    });

    broadcaster.publish({
      type: "agent.text",
      laneId: "main",
      timestamp: 200,
      sessionId: "ses_other",
      iteration: 1,
      text: "leak",
    });

    await new Promise((r) => setTimeout(r, 30));
    ws.close();
    expect(received).toBe(false);
  });

  it("returns 404 snapshot when the session id is unknown", async () => {
    const index = buildSessionIndex(baseEvents());
    const broadcaster = createEventBroadcaster();
    server = await startUiServer({ index, broadcaster, port: 0 });

    const ws = new WebSocket(
      `${server.url.replace(/^http/, "ws")}/ws?session=nonexistent`,
    );
    await waitOpen(ws);
    const first = (await nextMessage(ws)) as { type: string; reason?: string };
    ws.close();

    expect(first.type).toBe("error");
    expect(first.reason).toMatch(/unknown session/i);
  });
});
