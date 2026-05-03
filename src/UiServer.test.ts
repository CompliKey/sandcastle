import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildSessionIndex } from "./SessionIndex.js";
import type {
  BacklogManagerHostInterface,
  BacklogTicket,
} from "./defineSandcastle.js";
import type { SandcastleEvent } from "./EventStore.js";
import type { ScenarioRunResult } from "./ScenarioRunner.js";
import {
  type RunScenarioRequestFn,
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

describe("UiServer — commits + diff", () => {
  const fakeCommit = {
    sha: "deadbeef",
    parentSha: "cafebabe",
    subject: "feat: do the thing",
    authorName: "ci",
    authorEmail: "ci@example.com",
    authorTime: 1_700_000_000_000,
    files: [
      {
        path: "src/foo.ts",
        status: "M" as const,
        insertions: 5,
        deletions: 1,
      },
    ],
  };

  it("returns commit metadata for a session-known sha", async () => {
    const index = buildSessionIndex(sampleEvents());
    server = await startUiServer({
      index,
      port: 0,
      gitDiffService: {
        getCommit: async () => fakeCommit,
        getFileDiff: async () => ({
          path: "src/foo.ts",
          diff: "diff body",
          status: "M",
          insertions: 5,
          deletions: 1,
        }),
        hasCommit: async () => true,
      },
    });

    const res = await fetch(
      `${server.url}/api/sessions/ses_a/commits/deadbeef`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commit: { subject: string } };
    expect(body.commit.subject).toBe("feat: do the thing");
  });

  it("404s when the sha is not recorded in the session view", async () => {
    const index = buildSessionIndex(sampleEvents());
    server = await startUiServer({
      index,
      port: 0,
      gitDiffService: {
        getCommit: async () => fakeCommit,
        getFileDiff: async () => ({
          path: "x",
          diff: "",
          status: "M",
        }),
        hasCommit: async () => true,
      },
    });

    // Valid hex but not in ses_a's commits list.
    const res = await fetch(
      `${server.url}/api/sessions/ses_a/commits/abcdefab`,
    );
    expect(res.status).toBe(404);
  });

  it("503s when the diff service isn't configured", async () => {
    const index = buildSessionIndex(sampleEvents());
    server = await startUiServer({ index, port: 0 });

    const res = await fetch(
      `${server.url}/api/sessions/ses_a/commits/deadbeef`,
    );
    expect(res.status).toBe(503);
  });

  it("returns the unified diff for a path", async () => {
    const index = buildSessionIndex(sampleEvents());
    server = await startUiServer({
      index,
      port: 0,
      gitDiffService: {
        getCommit: async () => fakeCommit,
        getFileDiff: async (sha, path) => ({
          path,
          diff: `diff for ${sha} ${path}`,
          status: "M",
          insertions: 5,
          deletions: 1,
        }),
        hasCommit: async () => true,
      },
    });

    const res = await fetch(
      `${server.url}/api/sessions/ses_a/commits/deadbeef/diff?path=${encodeURIComponent(
        "src/foo.ts",
      )}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      diff: { path: string; diff: string };
    };
    expect(body.diff.path).toBe("src/foo.ts");
    expect(body.diff.diff).toBe("diff for deadbeef src/foo.ts");
  });

  it("400s on diff requests with no ?path=", async () => {
    const index = buildSessionIndex(sampleEvents());
    server = await startUiServer({
      index,
      port: 0,
      gitDiffService: {
        getCommit: async () => fakeCommit,
        getFileDiff: async () => ({
          path: "x",
          diff: "",
          status: "M",
        }),
        hasCommit: async () => true,
      },
    });

    const res = await fetch(
      `${server.url}/api/sessions/ses_a/commits/deadbeef/diff`,
    );
    expect(res.status).toBe(400);
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

const ticket = (overrides: Partial<BacklogTicket> = {}): BacklogTicket => ({
  id: overrides.id ?? "VGD-200",
  title: overrides.title ?? "Implement thing",
  body: overrides.body ?? "",
  labels: overrides.labels ?? [],
  url: overrides.url ?? "https://jira.example/browse/VGD-200",
  ...(overrides.priority !== undefined ? { priority: overrides.priority } : {}),
  ...(overrides.createdAt !== undefined
    ? { createdAt: overrides.createdAt }
    : {}),
});

const fakeBacklogManager = (
  tickets: readonly BacklogTicket[],
): BacklogManagerHostInterface => ({
  listPending: async () => tickets,
  getTicket: async (id) => {
    const t = tickets.find((x) => x.id === id);
    if (!t) throw new Error(`unknown ticket ${id}`);
    return t;
  },
  markErrored: async () => {},
  clearErrored: async () => {},
});

describe("UiServer — GET /api/queue", () => {
  it("returns 503 when no backlog manager is configured", async () => {
    const index = buildSessionIndex([]);
    server = await startUiServer({ index, port: 0 });
    const res = await fetch(`${server.url}/api/queue`);
    expect(res.status).toBe(503);
  });

  it("lists pending tickets in backlog-manager order", async () => {
    const index = buildSessionIndex([]);
    const backlogManager = fakeBacklogManager([
      ticket({ id: "VGD-201", title: "First", priority: "High" }),
      ticket({ id: "VGD-202", title: "Second" }),
    ]);
    server = await startUiServer({ index, port: 0, backlogManager });

    const res = await fetch(`${server.url}/api/queue`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tickets: Array<{ id: string; title: string; priority?: string }>;
    };
    expect(body.tickets.map((t) => t.id)).toEqual(["VGD-201", "VGD-202"]);
    expect(body.tickets[0]!.priority).toBe("High");
    expect(body.tickets[1]!.priority).toBeUndefined();
  });

  it("forwards listPending failures as 502", async () => {
    const index = buildSessionIndex([]);
    const backlogManager: BacklogManagerHostInterface = {
      listPending: async () => {
        throw new Error("upstream down");
      },
      getTicket: async () => ticket(),
      markErrored: async () => {},
      clearErrored: async () => {},
    };
    server = await startUiServer({ index, port: 0, backlogManager });
    const res = await fetch(`${server.url}/api/queue`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("upstream down");
  });
});

describe("UiServer — GET /api/scenarios", () => {
  it("returns the scenarios catalogue when configured", async () => {
    const index = buildSessionIndex([]);
    server = await startUiServer({
      index,
      port: 0,
      scenarios: [
        { name: "default-claude-code", maxIterations: 12 },
        { name: "verify-only", description: "Run tests only" },
      ],
    });
    const res = await fetch(`${server.url}/api/scenarios`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scenarios: Array<{
        name: string;
        maxIterations?: number;
        description?: string;
      }>;
    };
    expect(body.scenarios.map((s) => s.name)).toEqual([
      "default-claude-code",
      "verify-only",
    ]);
    expect(body.scenarios[0]!.maxIterations).toBe(12);
    expect(body.scenarios[1]!.description).toBe("Run tests only");
  });

  it("returns an empty list when scenarios is unset", async () => {
    const index = buildSessionIndex([]);
    server = await startUiServer({ index, port: 0 });
    const res = await fetch(`${server.url}/api/scenarios`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scenarios: unknown[] };
    expect(body.scenarios).toEqual([]);
  });
});

describe("UiServer — POST /api/run-scenario", () => {
  const post = (url: string, body: unknown): Promise<Response> =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const startedFor = (
    sessionId: string,
  ): Promise<{
    sessionId: string;
    done: Promise<ScenarioRunResult>;
  }> =>
    Promise.resolve({
      sessionId,
      done: Promise.resolve<ScenarioRunResult>({
        sessionId,
        outcome: "done",
        exitCode: 0,
        signal: null,
      }),
    });

  it("returns 503 when no runScenario adapter is configured", async () => {
    const index = buildSessionIndex([]);
    server = await startUiServer({ index, port: 0 });
    const res = await post(`${server.url}/api/run-scenario`, {
      scenario: "x",
      ticketId: "VGD-1",
    });
    expect(res.status).toBe(503);
  });

  it("starts a run and returns 202 with the allocated sessionId", async () => {
    const index = buildSessionIndex([]);
    const runScenario = vi.fn<RunScenarioRequestFn>(() => startedFor("ses_x"));
    server = await startUiServer({
      index,
      port: 0,
      scenarios: [{ name: "default-claude-code" }],
      runScenario,
    });

    const res = await post(`${server.url}/api/run-scenario`, {
      scenario: "default-claude-code",
      ticketId: "VGD-200",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { sessionId: string };
    expect(body.sessionId).toBe("ses_x");
    expect(runScenario).toHaveBeenCalledWith({
      scenario: "default-claude-code",
      ticketId: "VGD-200",
    });
  });

  it("forwards overrides verbatim to the adapter", async () => {
    const index = buildSessionIndex([]);
    const runScenario = vi.fn<RunScenarioRequestFn>(() =>
      startedFor("ses_overrides"),
    );
    server = await startUiServer({
      index,
      port: 0,
      scenarios: [{ name: "default-claude-code" }],
      runScenario,
    });

    const overrides = {
      maxIterations: 5,
      model: "claude-sonnet-4-6",
      promptArgs: { focusFiles: ["a.ts"] },
    };
    const res = await post(`${server.url}/api/run-scenario`, {
      scenario: "default-claude-code",
      ticketId: "VGD-200",
      overrides,
    });
    expect(res.status).toBe(202);
    expect(runScenario).toHaveBeenCalledWith({
      scenario: "default-claude-code",
      ticketId: "VGD-200",
      overrides,
    });
  });

  it("rejects unknown scenario names against the configured catalogue", async () => {
    const index = buildSessionIndex([]);
    const runScenario = vi.fn<RunScenarioRequestFn>(() => startedFor("unused"));
    server = await startUiServer({
      index,
      port: 0,
      scenarios: [{ name: "default-claude-code" }],
      runScenario,
    });
    const res = await post(`${server.url}/api/run-scenario`, {
      scenario: "nope",
      ticketId: "VGD-200",
    });
    expect(res.status).toBe(400);
    expect(runScenario).not.toHaveBeenCalled();
  });

  it("rejects malformed overrides", async () => {
    const index = buildSessionIndex([]);
    const runScenario = vi.fn<RunScenarioRequestFn>(() => startedFor("unused"));
    server = await startUiServer({
      index,
      port: 0,
      scenarios: [{ name: "x" }],
      runScenario,
    });

    // maxIterations must be a positive integer.
    const r1 = await post(`${server.url}/api/run-scenario`, {
      scenario: "x",
      ticketId: "VGD-1",
      overrides: { maxIterations: 0 },
    });
    expect(r1.status).toBe(400);

    // promptArgs must be a plain object, not an array.
    const r2 = await post(`${server.url}/api/run-scenario`, {
      scenario: "x",
      ticketId: "VGD-1",
      overrides: { promptArgs: ["nope"] },
    });
    expect(r2.status).toBe(400);

    expect(runScenario).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const index = buildSessionIndex([]);
    server = await startUiServer({
      index,
      port: 0,
      scenarios: [{ name: "x" }],
      runScenario: () => startedFor("unused"),
    });
    const res = await fetch(`${server.url}/api/run-scenario`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});
