/**
 * End-to-end integration: real fork → tsx-loaded `scenarioChild.ts` →
 * user-authored `defineSandcastle` config → ScenarioRunner persists IPC
 * events through to `.sandcastle/state/events.jsonl`.
 *
 * The test fixture replaces npm-built `dist/scenarioChild.js` with a tiny
 * bootstrap `.mjs` that uses tsx's `tsImport` to load `scenarioChild.ts`
 * directly. No build step required.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createEventStore,
  type EventStore,
  type SandcastleEvent,
} from "./EventStore.js";
import { runScenario } from "./ScenarioRunner.js";

const REPO_SRC_DIR = fileURLToPath(new URL(".", import.meta.url));

const collectEvents = async (store: EventStore): Promise<SandcastleEvent[]> => {
  const out: SandcastleEvent[] = [];
  for await (const { event } of store.replay()) out.push(event);
  return out;
};

/**
 * Write a tsx-bootstrap that imports the real `scenarioChild.ts` via tsx's
 * runtime hook. Returns the path to a `.mjs` that the parent forks.
 *
 * We resolve `tsx/esm/api` to an absolute file URL so the bootstrap works
 * even though it lives in a tempdir outside the project's node_modules.
 */
const TSX_API_URL = new URL(
  "../node_modules/tsx/dist/esm/api/index.mjs",
  import.meta.url,
).href;

const writeBootstrap = async (dir: string): Promise<string> => {
  const path = join(dir, "child-bootstrap.mjs");
  const childTs = join(REPO_SRC_DIR, "scenarioChild.ts");
  const source = `
    import { tsImport } from ${JSON.stringify(TSX_API_URL)};
    import { pathToFileURL } from "node:url";
    try {
      await tsImport(pathToFileURL(${JSON.stringify(childTs)}).href, import.meta.url);
    } catch (err) {
      console.error("[scenarioChild bootstrap] failed:", err);
      process.exit(70);
    }
  `;
  await writeFile(path, source, "utf8");
  return path;
};

const writeConfig = async (
  dir: string,
  scenarioBody: string,
  opts: { failGetTicket?: boolean } = {},
): Promise<string> => {
  const configPath = join(dir, "main.ts");
  // Import directly from the source module rather than the package barrel —
  // tsx's tsImport does not retrace `.js` → `.ts` extensions on transitive
  // imports, and the barrel re-exports modules whose `.js` paths only exist
  // post-build (mirroring how ScenarioConfigLoader's own tests sidestep this).
  const defineSandcastleSrc = join(REPO_SRC_DIR, "defineSandcastle.ts");
  const failBlock = opts.failGetTicket
    ? `throw new Error("simulated backlog manager failure");`
    : `return { id, title: "Test ticket " + id, body: "", labels: [], url: "https://example/" + id };`;
  const source = `
    import { defineSandcastle } from ${JSON.stringify(defineSandcastleSrc)};
    export default defineSandcastle({
      backlogManager: {
        listPending: async () => [],
        getTicket: async (id) => { ${failBlock} },
        markErrored: async () => {},
        clearErrored: async () => {},
      },
      scenarios: {
        "happy": {
          input: { type: "single-ticket" },
          run: async (ctx) => {
            ${scenarioBody}
          },
        },
      },
    });
  `;
  await writeFile(configPath, source, "utf8");
  return configPath;
};

describe("scenarioChild — end-to-end with real defineSandcastle config", () => {
  let dir: string;
  let store: EventStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "scenario-child-e2e-"));
    store = createEventStore({ dir });
  });

  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("loads config, fetches ticket, invokes scenario, and persists events.jsonl", async () => {
    const bootstrap = await writeBootstrap(dir);
    const configPath = await writeConfig(
      dir,
      `
        ctx.log("scenario.started", { ticket: ctx.ticket.id });
        ctx.log("scenario.midway");
        ctx.log("scenario.finished", { ok: true });
        `,
    );

    const result = await runScenario({
      scenario: "happy",
      ticketId: "T-1",
      configPath,
      store,
      childModulePath: bootstrap,
      stdio: "ignore",
    });

    expect(result.outcome).toBe("done");
    expect(result.exitCode).toBe(0);

    const events = await collectEvents(store);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("session.start");
    expect(types.at(-1)).toBe("session.end");
    const userLogs = events.filter((e) => e.type === "user.log");
    expect(userLogs).toHaveLength(3);
    const first = userLogs[0]!;
    if (first.type === "user.log") {
      expect(first.payload).toEqual({
        event: "scenario.started",
        data: { ticket: "T-1" },
      });
    }

    // events.jsonl on disk has all of them in arrival order.
    const months = await store.listMonths();
    const onDisk = await readFile(
      join(dir, `events-${months[0]}.jsonl`),
      "utf8",
    );
    const lines = onDisk.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(events.length);
  }, 20_000);

  it("scenario throws → child emits error message and parent records outcome=errored", async () => {
    const bootstrap = await writeBootstrap(dir);
    const configPath = await writeConfig(
      dir,
      `
        ctx.log("about-to-fail");
        throw new Error("intentional scenario failure");
        `,
    );

    const result = await runScenario({
      scenario: "happy",
      ticketId: "T-2",
      configPath,
      store,
      childModulePath: bootstrap,
      stdio: "ignore",
    });

    expect(result.outcome).toBe("errored");
    expect(result.exitCode).toBe(1);

    const events = await collectEvents(store);
    const errEvent = events.find((e) => e.type === "error");
    expect(errEvent).toBeDefined();
    if (errEvent && errEvent.type === "error") {
      expect(errEvent.kind).toBe("scenario.threw");
      expect(errEvent.reason).toContain("intentional scenario failure");
    }
    const end = events.at(-1)!;
    if (end.type === "session.end") expect(end.outcome).toBe("errored");
  }, 20_000);

  it("unknown scenario name → error event + non-zero exit", async () => {
    const bootstrap = await writeBootstrap(dir);
    const configPath = await writeConfig(dir, `ctx.log("never-runs");`);

    const result = await runScenario({
      scenario: "does-not-exist",
      ticketId: "T-3",
      configPath,
      store,
      childModulePath: bootstrap,
      stdio: "ignore",
    });

    expect(result.outcome).toBe("errored");
    const events = await collectEvents(store);
    const errEvent = events.find((e) => e.type === "error");
    expect(errEvent).toBeDefined();
    if (errEvent && errEvent.type === "error") {
      expect(errEvent.kind).toBe("scenario.unknown");
      expect(errEvent.reason).toContain("Unknown scenario");
    }
  }, 20_000);
});
