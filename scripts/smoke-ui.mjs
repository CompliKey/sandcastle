/**
 * Standalone smoke-test driver: boots a UiServer with a synthetic backlog
 * manager + autopilot controller pre-seeded with fixtures so a browser can
 * exercise the autopilot toggle, halt banner, and retry button without
 * needing a real `.sandcastle/main.ts` config.
 *
 * Usage: `node scripts/smoke-ui.mjs --port 4321`
 *   then open http://127.0.0.1:4321 in a browser.
 *
 * Hooked from Playwright/MCP smoke tests. Not bundled into the published CLI.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAutopilotController } from "../dist/AutopilotController.js";
import { buildSessionIndex } from "../dist/SessionIndex.js";
import { startUiServer } from "../dist/UiServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const assetsDir = join(repoRoot, "dist", "ui");

const portArgIdx = process.argv.indexOf("--port");
const port =
  portArgIdx >= 0 ? Number.parseInt(process.argv[portArgIdx + 1], 10) : 4321;
const startHalted = process.argv.includes("--start-halted");

const sessions = [
  {
    type: "session.start",
    laneId: "main",
    timestamp: Date.now() - 200_000,
    sessionId: "ses_a",
    ticketId: "VGD-127",
    scenario: "default-claude-code",
    startedAt: Date.now() - 200_000,
  },
  {
    type: "session.end",
    laneId: "main",
    timestamp: Date.now() - 100_000,
    sessionId: "ses_a",
    outcome: "done",
    endedAt: Date.now() - 100_000,
  },
  {
    type: "session.start",
    laneId: "main",
    timestamp: Date.now() - 90_000,
    sessionId: "ses_b",
    ticketId: "VGD-118",
    scenario: "default-claude-code",
    startedAt: Date.now() - 90_000,
  },
  {
    type: "error",
    laneId: "main",
    timestamp: Date.now() - 80_000,
    sessionId: "ses_b",
    kind: "agent.max-iterations",
    reason: "agent hit max iterations",
  },
  {
    type: "session.end",
    laneId: "main",
    timestamp: Date.now() - 80_000,
    sessionId: "ses_b",
    outcome: "errored",
    endedAt: Date.now() - 80_000,
  },
];

const index = buildSessionIndex(sessions);

const cleared = [];
let backlogBroken = startHalted;
const backlogManager = {
  async listPending() {
    if (backlogBroken) throw new Error("simulated infra failure");
    return [];
  },
  async getTicket(id) {
    return { id, title: id, body: "", labels: [], url: "" };
  },
  async markErrored() {},
  async clearErrored(id) {
    cleared.push(id);
  },
};

const autopilot = createAutopilotController({
  backlogManager,
  // Stub: pretend each invocation completes instantly. Avoids spawning real
  // children in the smoke test.
  runScenario: async ({ ticketId }) => ({
    sessionId: `ses_${ticketId}_smoke`,
    outcome: "done",
    exitCode: 0,
    signal: null,
  }),
  idlePollIntervalMs: 50,
});

let nextSessionId = 1;
const runScenarioAdapter = async ({ scenario, ticketId }) => {
  const sessionId = `ses_smoke_${nextSessionId++}`;
  return {
    sessionId,
    done: Promise.resolve({
      sessionId,
      outcome: "done",
      exitCode: 0,
      signal: null,
    }),
  };
};

const server = await startUiServer({
  index,
  port,
  host: "127.0.0.1",
  assetsDir,
  scenarios: [{ name: "default-claude-code", maxIterations: 12 }],
  backlogManager,
  runScenario: runScenarioAdapter,
  autopilot,
  version: "smoke",
});

if (startHalted) {
  // Kick off a loop that will fail listPending immediately and halt.
  autopilot.start({ scenario: "default-claude-code" });
  // Wait for the loop to settle into halted before we accept browser traffic.
  await new Promise((r) => setTimeout(r, 100));
  // Then "fix" the backlog so a Resume click recovers cleanly.
  backlogBroken = false;
}

console.log(JSON.stringify({ url: server.url, port: server.port }));

const onSig = async () => {
  await autopilot.shutdown();
  await server.close();
  process.exit(0);
};
process.on("SIGINT", onSig);
process.on("SIGTERM", onSig);
