/**
 * ScenarioRunner — parent-side coordinator that spawns a single scenario in a
 * child process, streams IPC events into the {@link EventStore}, and resolves
 * with a `SessionOutcome` derived from how the child exited.
 *
 * Lifecycle owned here (not in the child):
 *  - `session.start` is appended before fork.
 *  - `session.end` is appended after the child exits, with outcome decided by
 *    the parent — never by the child. A child crash that bypasses any cleanup
 *    still produces a final `session.end` with `outcome: "errored"` (AC#6).
 *
 * Outcome mapping
 *  - `done`     — child exited cleanly (code 0, no signal, no SIGTERM-by-us).
 *  - `errored`  — child exited with non-zero code or via an unrequested signal,
 *                 OR config/spawn failed before any child code ran.
 *  - `halted`   — parent's `signal` aborted (e.g. SIGTERM forwarded from the
 *                 host process) and we forwarded SIGTERM to the child. This
 *                 wins over the child's eventual exit shape: a halted run is
 *                 halted even if the child exited non-zero on the way out.
 */

import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { EventStore, SessionOutcome } from "./EventStore.js";
import {
  buildSessionEndEvent,
  buildSessionStartEvent,
  isScenarioChildMessage,
  messageToEvent,
  SCENARIO_ENV,
  type ScenarioChildMessage,
} from "./scenarioIpcProtocol.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface ScenarioRunnerOptions {
  /** Scenario name as keyed in the user's `defineSandcastle({ scenarios })`. */
  readonly scenario: string;
  /** Backlog ticket id passed to the child via `SANDCASTLE_TICKET_ID`. */
  readonly ticketId: string;
  /** Absolute path to the user's `.sandcastle/main.ts` config. */
  readonly configPath: string;
  /** Destination for events. */
  readonly store: EventStore;
  /** v1 always passes `"main"`. */
  readonly laneId?: string;
  /** Overridable for deterministic tests; defaults to `randomUUID()`. */
  readonly sessionId?: string;
  /** Overridable for deterministic tests; defaults to `Date.now`. */
  readonly clock?: () => number;
  /**
   * Path to the child entry module. Defaults to the bundled
   * `dist/scenarioChild.js` resolved relative to this module. Tests pass a
   * stub child module to exercise runner behaviour in isolation.
   */
  readonly childModulePath?: string;
  /** When set, the child's stdout/stderr inherit the parent's. Default: `"inherit"`. */
  readonly stdio?: ForkOptions["stdio"];
  /**
   * Pass-through env for the child. Merged on top of `process.env`. The
   * `SANDCASTLE_*` vars in {@link SCENARIO_ENV} are appended/overridden by the
   * runner — caller-provided values for those keys are ignored.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Aborting this signal forwards `SIGTERM` to the child and forces the final
   * outcome to `"halted"` regardless of how the child exits. Callers wire it
   * up to the host process's SIGTERM/SIGINT handler.
   */
  readonly signal?: AbortSignal;
  /**
   * Override the `fork()` implementation. Used by tests to inject a fake
   * child process without spawning a real one.
   */
  readonly fork?: typeof fork;
}

export interface ScenarioRunResult {
  readonly sessionId: string;
  readonly outcome: SessionOutcome;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

// ---------------------------------------------------------------------------
// Default child module path — `dist/scenarioChild.js` next to this file.
// ---------------------------------------------------------------------------

const defaultChildModulePath = (): string =>
  fileURLToPath(new URL("./scenarioChild.js", import.meta.url));

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export const runScenario = async (
  options: ScenarioRunnerOptions,
): Promise<ScenarioRunResult> => {
  const sessionId = options.sessionId ?? randomUUID();
  const laneId = options.laneId ?? "main";
  const clock = options.clock ?? Date.now;
  const childModulePath = options.childModulePath ?? defaultChildModulePath();
  const stdio: ForkOptions["stdio"] = options.stdio ?? "inherit";
  const forkImpl = options.fork ?? fork;

  await options.store.append(
    buildSessionStartEvent({
      sessionId,
      laneId,
      ticketId: options.ticketId,
      scenario: options.scenario,
      startedAt: clock(),
    }),
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    [SCENARIO_ENV.scenario]: options.scenario,
    [SCENARIO_ENV.ticketId]: options.ticketId,
    [SCENARIO_ENV.configPath]: options.configPath,
    [SCENARIO_ENV.sessionId]: sessionId,
    [SCENARIO_ENV.laneId]: laneId,
    [SCENARIO_ENV.ipcMode]: "1",
  };

  // Track every append we kick off so we can flush before emitting session.end.
  // EventStore.append serialises internally via its writeChain, but we still
  // need to *await* every promise so that an append rejection surfaces as a
  // runner failure rather than an unhandled rejection.
  const pendingAppends: Promise<void>[] = [];

  let child: ChildProcess;
  try {
    child = forkImpl(childModulePath, [], { env, stdio });
  } catch (err) {
    return finalize({
      store: options.store,
      sessionId,
      laneId,
      clock,
      pendingAppends,
      outcome: "errored",
      exitCode: null,
      signal: null,
      preEnd: () =>
        options.store.append({
          type: "error",
          sessionId,
          laneId,
          timestamp: clock(),
          kind: "spawn.failed",
          reason: err instanceof Error ? err.message : String(err),
        }),
    });
  }

  let halted = false;

  const onAbort = (): void => {
    if (halted) return;
    halted = true;
    if (child.connected) child.disconnect();
    if (!child.killed) child.kill("SIGTERM");
  };
  if (options.signal) {
    if (options.signal.aborted) {
      onAbort();
    } else {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  child.on("message", (msg) => {
    if (!isScenarioChildMessage(msg)) return; // tolerate alien IPC payloads
    pendingAppends.push(
      options.store.append(
        messageToEvent(msg as ScenarioChildMessage, {
          sessionId,
          laneId,
          timestamp: clock(),
        }),
      ),
    );
  });

  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    let settled = false;
    const settle = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    };
    child.once("exit", (code, signal) => settle(code, signal));
    // Spawn errors (e.g. ENOENT for childModulePath) surface via "error" with
    // no subsequent "exit". Treat them as a non-zero exit so the outcome
    // mapping below classifies them as `errored`.
    child.once("error", () => settle(1, null));
  });

  if (options.signal) {
    options.signal.removeEventListener("abort", onAbort);
  }

  const outcome: SessionOutcome = halted
    ? "halted"
    : exit.code === 0 && exit.signal === null
      ? "done"
      : "errored";

  return finalize({
    store: options.store,
    sessionId,
    laneId,
    clock,
    pendingAppends,
    outcome,
    exitCode: exit.code,
    signal: exit.signal,
  });
};

// ---------------------------------------------------------------------------
// Finalization helper — flushes pending appends, emits session.end last.
// ---------------------------------------------------------------------------

const finalize = async (params: {
  readonly store: EventStore;
  readonly sessionId: string;
  readonly laneId: string;
  readonly clock: () => number;
  readonly pendingAppends: Promise<void>[];
  readonly outcome: SessionOutcome;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly preEnd?: () => Promise<void>;
}): Promise<ScenarioRunResult> => {
  await Promise.allSettled(params.pendingAppends);
  if (params.preEnd) await params.preEnd();
  await params.store.append(
    buildSessionEndEvent({
      sessionId: params.sessionId,
      laneId: params.laneId,
      outcome: params.outcome,
      endedAt: params.clock(),
    }),
  );
  return {
    sessionId: params.sessionId,
    outcome: params.outcome,
    exitCode: params.exitCode,
    signal: params.signal,
  };
};
