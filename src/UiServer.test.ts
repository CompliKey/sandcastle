import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSessionIndex } from "./SessionIndex.js";
import type { SandcastleEvent } from "./EventStore.js";
import {
  type UiServer,
  probeExistingServer,
  startUiServer,
} from "./UiServer.js";

const sampleEvents = (): SandcastleEvent[] => [
  {
    type: "session.start",
    laneId: "main",
    timestamp: 100,
    sessionId: "ses_a",
    ticketId: "VGD-127",
    scenario: "implement",
    startedAt: 100,
  },
  {
    type: "iteration.start",
    laneId: "main",
    timestamp: 110,
    sessionId: "ses_a",
    iteration: 1,
    startedAt: 110,
  },
  {
    type: "iteration.end",
    laneId: "main",
    timestamp: 200,
    sessionId: "ses_a",
    iteration: 1,
    endedAt: 200,
    usage: {
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 5000,
    },
  },
  {
    type: "commit",
    laneId: "main",
    timestamp: 210,
    sessionId: "ses_a",
    sha: "deadbeef",
  },
  {
    type: "session.end",
    laneId: "main",
    timestamp: 300,
    sessionId: "ses_a",
    outcome: "done",
    endedAt: 300,
  },
  {
    type: "session.start",
    laneId: "main",
    timestamp: 1000,
    sessionId: "ses_b",
    ticketId: "VGD-128",
    scenario: "implement",
    startedAt: 1000,
  },
  {
    type: "session.end",
    laneId: "main",
    timestamp: 1100,
    sessionId: "ses_b",
    outcome: "errored",
    endedAt: 1100,
  },
];

let server: UiServer | null;

beforeEach(() => {
  server = null;
});

afterEach(async () => {
  if (server) await server.close();
});

describe("UiServer — REST surface", () => {
  it("returns health payload at /api/health", async () => {
    const index = buildSessionIndex([]);
    server = await startUiServer({ index, port: 0, version: "1.2.3" });

    const res = await fetch(`${server.url}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.application).toBe("sandcastle");
    expect(body.version).toBe("1.2.3");
    expect(typeof body.pid).toBe("number");
    expect(typeof body.startedAt).toBe("number");
  });

  it("lists sessions newest-first", async () => {
    const index = buildSessionIndex(sampleEvents());
    server = await startUiServer({ index, port: 0 });

    const res = await fetch(`${server.url}/api/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{ sessionId: string }>;
    };
    expect(body.sessions.map((s) => s.sessionId)).toEqual(["ses_b", "ses_a"]);
  });

  it("honours the ?limit query parameter", async () => {
    const index = buildSessionIndex(sampleEvents());
    server = await startUiServer({ index, port: 0 });

    const res = await fetch(`${server.url}/api/sessions?limit=1`);
    const body = (await res.json()) as { sessions: Array<unknown> };
    expect(body.sessions.length).toBe(1);
  });

  it("returns a single session at /api/sessions/:id", async () => {
    const index = buildSessionIndex(sampleEvents());
    server = await startUiServer({ index, port: 0 });

    const res = await fetch(`${server.url}/api/sessions/ses_a`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { ticketId: string } };
    expect(body.session.ticketId).toBe("VGD-127");
  });

  it("404s for an unknown session", async () => {
    const index = buildSessionIndex(sampleEvents());
    server = await startUiServer({ index, port: 0 });

    const res = await fetch(`${server.url}/api/sessions/nope`);
    expect(res.status).toBe(404);
  });

  it("lists sessions for a ticket", async () => {
    const index = buildSessionIndex(sampleEvents());
    server = await startUiServer({ index, port: 0 });

    const res = await fetch(`${server.url}/api/tickets/VGD-127/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ticketId: string;
      sessions: Array<{ sessionId: string }>;
    };
    expect(body.ticketId).toBe("VGD-127");
    expect(body.sessions.map((s) => s.sessionId)).toEqual(["ses_a"]);
  });

  it("404s on unknown api endpoints", async () => {
    const index = buildSessionIndex([]);
    server = await startUiServer({ index, port: 0 });

    const res = await fetch(`${server.url}/api/no-such-thing`);
    expect(res.status).toBe(404);
  });

  it("rejects non-GET methods on api endpoints", async () => {
    const index = buildSessionIndex([]);
    server = await startUiServer({ index, port: 0 });

    const res = await fetch(`${server.url}/api/sessions`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("UiServer — static assets", () => {
  let assetsDir: string;

  beforeEach(async () => {
    assetsDir = await mkdtemp(join(tmpdir(), "sandcastle-uiserver-assets-"));
  });

  afterEach(async () => {
    await rm(assetsDir, { recursive: true, force: true });
  });

  it("serves index.html at /", async () => {
    await writeFile(
      join(assetsDir, "index.html"),
      "<!doctype html>hello",
      "utf8",
    );
    const index = buildSessionIndex([]);
    server = await startUiServer({ index, assetsDir, port: 0 });

    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toContain("hello");
  });

  it("falls back to index.html for unknown SPA routes", async () => {
    await writeFile(
      join(assetsDir, "index.html"),
      "<!doctype html>spa",
      "utf8",
    );
    const index = buildSessionIndex([]);
    server = await startUiServer({ index, assetsDir, port: 0 });

    const res = await fetch(`${server.url}/sessions/abc`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("spa");
  });

  it("serves hashed assets with immutable cache-control", async () => {
    await mkdir(join(assetsDir, "assets"), { recursive: true });
    await writeFile(
      join(assetsDir, "assets", "index-deadbeef.js"),
      "console.log('hi')",
      "utf8",
    );
    const index = buildSessionIndex([]);
    server = await startUiServer({ index, assetsDir, port: 0 });

    const res = await fetch(`${server.url}/assets/index-deadbeef.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("rejects path traversal attempts", async () => {
    await writeFile(
      join(assetsDir, "index.html"),
      "<!doctype html>spa",
      "utf8",
    );
    const index = buildSessionIndex([]);
    server = await startUiServer({ index, assetsDir, port: 0 });

    const res = await fetch(`${server.url}/..%2F..%2Fetc%2Fpasswd`);
    // Either 400 (rejected) or 200 with index.html (SPA fallback) is fine —
    // what we care about is that the actual filesystem path was not served.
    if (res.status === 200) {
      const body = await res.text();
      expect(body).not.toContain("root:");
    } else {
      expect(res.status).toBe(400);
    }
  });

  it("returns a placeholder page when assetsDir is unset", async () => {
    const index = buildSessionIndex([]);
    server = await startUiServer({ index, port: 0 });

    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("not built yet");
  });
});

describe("probeExistingServer", () => {
  it("returns the health payload for a live sandcastle server", async () => {
    const index = buildSessionIndex([]);
    server = await startUiServer({ index, port: 0, version: "9.9.9" });

    const probed = await probeExistingServer(server.url);
    expect(probed).not.toBeNull();
    expect(probed?.application).toBe("sandcastle");
    expect(probed?.version).toBe("9.9.9");
  });

  it("returns null when no server is listening", async () => {
    // Use a definitely-unused port: bind & close to find one, then probe it.
    const index = buildSessionIndex([]);
    const tmp = await startUiServer({ index, port: 0 });
    const url = tmp.url;
    await tmp.close();

    const probed = await probeExistingServer(url, { timeoutMs: 200 });
    expect(probed).toBeNull();
  });

  it("returns null when the server reports a different application", async () => {
    const index = buildSessionIndex([]);
    server = await startUiServer({ index, port: 0, application: "other-app" });

    const probed = await probeExistingServer(server.url);
    expect(probed).toBeNull();
  });
});
