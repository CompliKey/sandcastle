/**
 * Integration test for the hand-rolled WebSocket adapter.
 *
 * Boots a real http server, performs the upgrade with Node's built-in
 * (undici) WebSocket client, and verifies bidirectional traffic + clean close.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attachWebSocket, type WebSocketConnection } from "./WebSocket.js";

const listenOnEphemeralPort = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) resolve(addr.port);
      else reject(new Error("no address"));
    });
  });

describe("attachWebSocket integration", () => {
  let server: Server;
  let port: number;
  let onConnection: (conn: WebSocketConnection) => void = () => {};

  beforeEach(async () => {
    server = createServer();
    server.on("upgrade", (req, socket) => {
      const conn = attachWebSocket(req, socket);
      if (conn) onConnection(conn);
    });
    port = await listenOnEphemeralPort(server);
  });

  afterEach(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  it("server can push text frames that the client receives", async () => {
    const url = `ws://127.0.0.1:${port}/ws`;
    onConnection = (conn) => {
      conn.send("first");
      conn.send("second");
    };

    const messages = await collectMessages(url, 2);
    expect(messages).toEqual(["first", "second"]);
  });

  it("client text messages reach the server-side onMessage sink", async () => {
    const received: string[] = [];
    onConnection = (conn) => {
      conn.onMessage((text) => received.push(text));
    };

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitOpen(ws);
    ws.send("from-client-1");
    ws.send("from-client-2");
    // Give the server a moment to drain.
    await new Promise((r) => setTimeout(r, 30));
    ws.close();
    await waitClose(ws);

    expect(received).toEqual(["from-client-1", "from-client-2"]);
  });

  it("server-initiated close fires onClose and the client sees the close event", async () => {
    let serverClosed = false;
    onConnection = (conn) => {
      conn.onClose(() => {
        serverClosed = true;
      });
      conn.send("hi");
      setTimeout(() => conn.close(1000, "bye"), 10);
    };

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitOpen(ws);
    await waitClose(ws);
    expect(serverClosed).toBe(true);
  });
});

const collectMessages = (url: string, count: number): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const out: string[] = [];
    ws.addEventListener("message", (ev) => {
      out.push(typeof ev.data === "string" ? ev.data : "");
      if (out.length >= count) {
        ws.close();
      }
    });
    ws.addEventListener("close", () => resolve(out));
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });

const waitOpen = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("open failed")), {
      once: true,
    });
  });

const waitClose = (ws: WebSocket): Promise<void> =>
  new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.addEventListener("close", () => resolve(), { once: true });
  });
