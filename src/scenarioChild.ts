/**
 * Child-process entry point. The parent's {@link runScenario} forks this
 * module with a set of `SANDCASTLE_*` env vars; this module's job is to:
 *
 *   1. Read the env vars.
 *   2. Load the user's `defineSandcastle` config.
 *   3. Look up the named scenario and hydrate the ticket via the host-side
 *      backlog manager.
 *   4. Build a `ctx` with pre-wired `run` / `createSandbox` / `interactive`
 *      that route logging through IPC, plus a `signal` aborted on SIGTERM and
 *      a `log` helper that emits `user.log` IPC messages.
 *   5. Invoke the scenario's `run`.
 *   6. On success: disconnect IPC and exit 0.
 *      On failure: emit an IPC `error` message and exit non-zero.
 *
 * The parent owns `session.start` and `session.end`; this module never sends
 * those events directly. See {@link scenarioIpcProtocol} for the contract.
 */

import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";

import { loadSandcastleConfig } from "./ScenarioConfigLoader.js";
import { SCENARIO_ENV } from "./scenarioIpcProtocol.js";
import {
  defaultIpcSender,
  isInScenarioChild,
  wireCreateSandbox,
  wireInteractive,
  wireRun,
} from "./scenarioCtxWiring.js";
import type {
  ScenarioContext,
  ScenarioDefinition,
  ScenarioInput,
  ScenarioLogFn,
} from "./defineSandcastle.js";

interface ChildEnv {
  readonly scenario: string;
  readonly ticketId: string;
  readonly configPath: string;
  readonly sessionId: string;
  readonly laneId: string;
}

const readEnv = (): ChildEnv => {
  const required = (key: string): string => {
    const value = process.env[key];
    if (!value) {
      throw new Error(
        `scenarioChild: missing required env var ${key}. ` +
          `This module is intended to run as a forked child of ScenarioRunner.`,
      );
    }
    return value;
  };
  return {
    scenario: required(SCENARIO_ENV.scenario),
    ticketId: required(SCENARIO_ENV.ticketId),
    configPath: required(SCENARIO_ENV.configPath),
    sessionId: required(SCENARIO_ENV.sessionId),
    laneId: required(SCENARIO_ENV.laneId),
  };
};

export const runScenarioChild = async (): Promise<void> => {
  const env = readEnv();
  const send = defaultIpcSender;

  // SIGTERM from the parent → abort the scenario's signal cleanly. The parent
  // also has its own halt bookkeeping; this is so user-authored cleanup runs.
  const ac = new AbortController();
  const onSigterm = (): void => ac.abort();
  process.once("SIGTERM", onSigterm);

  const reportFailure = (kind: string, err: unknown): void => {
    const reason = err instanceof Error ? `${err.message}` : String(err);
    send({ kind: "error", errorKind: kind, reason });
  };

  // ── Phase 1: load + validate config ──────────────────────────────────────
  let loaded;
  try {
    loaded = await Effect.runPromise(
      loadSandcastleConfig(env.configPath).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );
  } catch (err) {
    reportFailure("loader.failed", err);
    process.exitCode = 11;
    return;
  }

  const scenario = loaded.config.scenarios[env.scenario] as
    | ScenarioDefinition
    | undefined;
  if (!scenario) {
    const available = Object.keys(loaded.config.scenarios).join(", ");
    reportFailure(
      "scenario.unknown",
      new Error(
        `Unknown scenario "${env.scenario}". Available: ${available || "(none)"}.`,
      ),
    );
    process.exitCode = 12;
    return;
  }

  // ── Phase 2: hydrate the ticket via the host-side backlog manager ────────
  let ticket;
  try {
    ticket = await loaded.backlogManager.getTicket(env.ticketId);
  } catch (err) {
    reportFailure("ticket.fetchFailed", err);
    process.exitCode = 13;
    return;
  }

  // ── Phase 3: build ctx and invoke ────────────────────────────────────────
  const log: ScenarioLogFn = (event, data) => {
    send({ kind: "user.log", event, data });
  };

  const ctx: ScenarioContext<ScenarioInput> = {
    input: scenario.input,
    ticket: { id: ticket.id, title: ticket.title },
    run: wireRun({ signal: ac.signal }),
    createSandbox: wireCreateSandbox({ signal: ac.signal }),
    interactive: wireInteractive({ signal: ac.signal }),
    signal: ac.signal,
    log,
  };

  try {
    await scenario.run(ctx);
    process.exitCode = 0;
  } catch (err) {
    reportFailure("scenario.threw", err);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", onSigterm);
    if (process.connected && typeof process.disconnect === "function") {
      process.disconnect();
    }
  }
};

// Run only when invoked as a forked child; importing this module from a test
// or other host-side code does NOT auto-run the entry. The IPC env-var pair
// is the safest gate — `process.send` alone is also true under e.g. PM2.
if (isInScenarioChild()) {
  void runScenarioChild().catch((err: unknown) => {
    // A bug in this module itself, not the user's scenario.
    try {
      defaultIpcSender({
        kind: "error",
        errorKind: "scenarioChild.bug",
        reason: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* IPC may already be torn down. */
    }
    process.exitCode = 70;
  });
}
