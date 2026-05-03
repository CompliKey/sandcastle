/**
 * End-to-end smoke test for the `sandcastle ui` CLI. Boots the server in a
 * scratch repo with a real `.sandcastle/state/events.jsonl` file, hits each
 * REST endpoint, then proves the second-invocation handoff path: a second
 * `sandcastle ui --no-open` exits cleanly with the "already running" message
 * instead of EADDRINUSE.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SandcastleEvent } from "./EventStore.js";

const cliPath = join(import.meta.dirname, "..", "dist", "main.js");

const seedEvents = async (stateDir: string): Promise<void> => {
  await mkdir(stateDir, { recursive: true });
  const events: SandcastleEvent[] = [
    {
      type: "session.start",
      laneId: "main",
      timestamp: 100,
      sessionId: "ses_smoke",
      ticketId: "VGD-127",
      scenario: "implement",
      startedAt: 100,
    },
    {
      type: "session.end",
      laneId: "main",
      timestamp: 200,
      sessionId: "ses_smoke",
      outcome: "done",
      endedAt: 200,
    },
  ];
  const yyyymm = new Date(100).toISOString().slice(0, 7);
  await writeFile(
    join(stateDir, `events-${yyyymm}.jsonl`),
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
    "utf8",
  );
};

const pickFreePort = async (): Promise<number> => {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr !== "object" || !addr) {
        srv.close();
        reject(new Error("no address"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
};

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "sandcastle-ui-smoke-"));
  await mkdir(join(cwd, ".sandcastle"));
  await seedEvents(join(cwd, ".sandcastle", "state"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("sandcastle ui — end-to-end", () => {
  it("pushes a config.changed WS event when .sandcastle/main.ts is modified", async () => {
    const port = await pickFreePort();
    // Seed an in-flight session — write only `session.start`, no end. The
    // smoke test elsewhere uses a finished session; we override the seed
    // here with `node:fs` writes so the WS upgrade succeeds.
    const stateDir = join(cwd, ".sandcastle", "state");
    const startedAt = Date.now();
    const yyyymm = new Date(startedAt).toISOString().slice(0, 7);
    const inflight: SandcastleEvent[] = [
      {
        type: "session.start",
        laneId: "main",
        timestamp: startedAt,
        sessionId: "ses_inflight",
        ticketId: "VGD-146",
        scenario: "implement",
        startedAt,
      },
    ];
    await writeFile(
      join(stateDir, `events-${yyyymm}.jsonl`),
      `${inflight.map((e) => JSON.stringify(e)).join("\n")}\n`,
      "utf8",
    );

    // The watcher needs main.ts to exist at start so chokidar picks up the
    // 'change' event (rather than 'add', which we also handle but takes a
    // different code path).
    const mainPath = join(cwd, ".sandcastle", "main.ts");
    await writeFile(mainPath, "// initial\n", "utf8");

    const child = spawn(
      "node",
      [cliPath, "ui", "--no-open", "--port", String(port)],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      const url = `http://127.0.0.1:${port}`;
      expect(await waitForReady(url, 5000)).toBe(true);

      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws?session=ses_inflight`,
      );
      const messages: Array<{ type: string; path?: string }> = [];
      ws.addEventListener("message", (ev) => {
        try {
          messages.push(
            JSON.parse(typeof ev.data === "string" ? ev.data : "") as {
              type: string;
              path?: string;
            },
          );
        } catch {
          // ignore malformed
        }
      });
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener(
          "error",
          () => reject(new Error("ws open failed")),
          {
            once: true,
          },
        );
      });

      // Wait for snapshot before mutating, to ensure we don't race the
      // backfill window.
      const deadline = Date.now() + 2_000;
      while (
        !messages.some((m) => m.type === "snapshot") &&
        Date.now() < deadline
      ) {
        await wait(20);
      }

      // Trigger a real config change: rewrite main.ts with new content.
      await writeFile(mainPath, "// MUTATED\n", "utf8");

      const seenDeadline = Date.now() + 5_000;
      while (
        !messages.some((m) => m.type === "config.changed") &&
        Date.now() < seenDeadline
      ) {
        await wait(50);
      }
      ws.close();

      const cfg = messages.find((m) => m.type === "config.changed");
      expect(cfg).toBeDefined();
      expect(cfg?.path).toBe(mainPath);
    } finally {
      child.kill("SIGINT");
      await waitForExit(child, 5000);
    }
  });

  it("serves /api/sessions from the on-disk event log", async () => {
    const port = await pickFreePort();
    const child = spawn(
      "node",
      [cliPath, "ui", "--no-open", "--port", String(port)],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      // Wait for the server to be ready by polling /api/health.
      const url = `http://127.0.0.1:${port}`;
      const ready = await waitForReady(url, 5000);
      expect(ready).toBe(true);

      const sessionsRes = await fetch(`${url}/api/sessions`);
      expect(sessionsRes.status).toBe(200);
      const body = (await sessionsRes.json()) as {
        sessions: Array<{ ticketId: string; outcome: string }>;
      };
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0]?.ticketId).toBe("VGD-127");
      expect(body.sessions[0]?.outcome).toBe("done");

      // Second invocation: should detect the live server and exit 0.
      const second = await runOnce(["ui", "--no-open"], cwd, 5000);
      expect(second.code).toBe(0);
      expect(second.stdout + second.stderr).toMatch(/already running/);
    } finally {
      child.kill("SIGINT");
      await waitForExit(child, 5000);
    }
  });
});

const waitForReady = async (
  url: string,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return true;
    } catch {
      // server not up yet
    }
    await wait(50);
  }
  return false;
};

const waitForExit = (
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });

const runOnce = (
  args: string[],
  runCwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn("node", [cliPath, ...args], {
      cwd: runCwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
