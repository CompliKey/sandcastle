/**
 * Pre-wires `run` / `createSandbox` / `interactive` for use inside a scenario
 * child process so user-authored scenarios don't have to thread `signal` and
 * `logging` through manually.
 *
 * The wiring detects whether we're in a scenario child via the `IS_IPC_MODE`
 * predicate (set by env var + Node IPC channel presence). When true, it
 * injects an `onAgentStreamEvent` callback that forwards each agent stream
 * event to the parent over IPC as `agent.text` / `agent.toolCall` messages —
 * iteration boundaries are inferred from transitions in the stream. When
 * false (e.g. unit tests calling these helpers directly), the wiring is a
 * pass-through. The user's own logging callback, if any, is chained — IPC
 * forwarding is additive, not exclusive.
 */

import type { AgentStreamEvent } from "./AgentStreamEmitter.js";
import type {
  CreateSandboxOptions,
  Sandbox,
  SandboxInteractiveOptions,
  SandboxInteractiveResult,
  SandboxRunOptions,
  SandboxRunResult,
} from "./createSandbox.js";
import { createSandbox as realCreateSandbox } from "./createSandbox.js";
import { interactive as realInteractive } from "./interactive.js";
import type { InteractiveOptions } from "./interactive.js";
import { run as realRun } from "./run.js";
import type { LoggingOption, RunOptions, RunResult } from "./run.js";
import {
  SCENARIO_ENV,
  type ScenarioChildMessage,
} from "./scenarioIpcProtocol.js";

// ---------------------------------------------------------------------------
// IPC sender — abstracted so tests can inject a recorder
// ---------------------------------------------------------------------------

export type IpcSender = (msg: ScenarioChildMessage) => void;

/**
 * Default sender. Resolves `process.send` once at call site (it is `undefined`
 * outside an IPC channel) and tolerates absent IPC by no-op'ing — the wiring
 * is safe to call in any context.
 */
export const defaultIpcSender: IpcSender = (msg) => {
  if (typeof process.send === "function") {
    process.send(msg);
  }
};

/** True when the parent has marked this process as a scenario child. */
export const isInScenarioChild = (): boolean =>
  process.env[SCENARIO_ENV.ipcMode] === "1" &&
  typeof process.send === "function";

// ---------------------------------------------------------------------------
// Iteration-boundary tracker
// ---------------------------------------------------------------------------

/**
 * Wraps a stream callback so the caller sees both agent events AND inferred
 * iteration boundaries. The first event opens iteration 1; transitions emit a
 * `iteration.end` for the previous iteration and an `iteration.start` for the
 * new one. After the run resolves, the caller invokes `flush()` to close the
 * last iteration.
 *
 * This is approximate — `iteration.end.usage` is unavailable from the stream
 * alone — but it is enough for UI navigation by iteration in slice 4. Slices
 * that need exact `usage` figures can additionally consume `RunResult`.
 */
export interface IterationBoundaryTracker {
  readonly onEvent: (event: AgentStreamEvent) => void;
  readonly flush: () => void;
}

export const createIterationBoundaryTracker = (
  send: IpcSender,
): IterationBoundaryTracker => {
  let openIteration: number | null = null;
  return {
    onEvent: (event) => {
      const it = event.iteration;
      if (openIteration !== it) {
        if (openIteration !== null) {
          send({ kind: "iteration.end", iteration: openIteration });
        }
        send({ kind: "iteration.start", iteration: it });
        openIteration = it;
      }
      if (event.type === "text") {
        send({
          kind: "agent.text",
          iteration: it,
          text: event.message,
        });
      } else if (event.type === "toolResult") {
        send({
          kind: "agent.toolResult",
          iteration: it,
          toolUseId: event.toolUseId,
          result: event.result,
          isError: event.isError,
        });
      } else {
        send({
          kind: "agent.toolCall",
          iteration: it,
          toolUseId: event.toolUseId,
          toolName: event.name,
          formattedArgs: event.formattedArgs,
        });
      }
    },
    flush: () => {
      if (openIteration !== null) {
        send({ kind: "iteration.end", iteration: openIteration });
        openIteration = null;
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Logging-option enrichment — chains user callback with IPC forwarding
// ---------------------------------------------------------------------------

const ipcLogging = (
  user: LoggingOption | undefined,
  ipc: (event: AgentStreamEvent) => void,
): LoggingOption => {
  // `stdout` mode has no `onAgentStreamEvent` hook, so to forward events we
  // must coerce to file mode. The slice 7+ UI server is the consumer; the
  // log-file path is bookkeeping only.
  if (user === undefined || user.type === "stdout") {
    return {
      type: "file",
      path: defaultLogPath(),
      onAgentStreamEvent: ipc,
    };
  }
  const userCb = user.onAgentStreamEvent;
  return {
    ...user,
    onAgentStreamEvent: (event) => {
      ipc(event);
      if (userCb) {
        try {
          userCb(event);
        } catch {
          /* user-callback errors are swallowed — observability must not
             destabilise the run, mirroring AgentStreamEmitter semantics. */
        }
      }
    },
  };
};

const defaultLogPath = (): string => {
  // `.sandcastle/logs/<sessionId>.log` is the natural slot, but the wiring
  // does not have a sessionId in scope — `run()` already auto-generates a path
  // when given `{ type: "file" }` without one, but our shape requires `path`.
  // Pick a deterministic temp path; the file is incidental in IPC mode.
  return `${process.env.SANDCASTLE_LOG_PATH ?? "/tmp/sandcastle-scenario.log"}`;
};

// ---------------------------------------------------------------------------
// Wired wrappers
// ---------------------------------------------------------------------------

export interface WireDeps {
  readonly send?: IpcSender;
  readonly signal?: AbortSignal;
  readonly active?: () => boolean;
  /** Test seams. */
  readonly _runImpl?: typeof realRun;
  readonly _createSandboxImpl?: typeof realCreateSandbox;
  readonly _interactiveImpl?: typeof realInteractive;
}

const resolveDeps = (
  deps: WireDeps | undefined,
): Required<
  Omit<
    WireDeps,
    "_runImpl" | "_createSandboxImpl" | "_interactiveImpl" | "signal"
  >
> &
  Pick<
    WireDeps,
    "_runImpl" | "_createSandboxImpl" | "_interactiveImpl" | "signal"
  > => ({
  send: deps?.send ?? defaultIpcSender,
  active: deps?.active ?? isInScenarioChild,
  signal: deps?.signal,
  _runImpl: deps?._runImpl,
  _createSandboxImpl: deps?._createSandboxImpl,
  _interactiveImpl: deps?._interactiveImpl,
});

export const wireRun = (deps?: WireDeps) => {
  const d = resolveDeps(deps);
  const impl = d._runImpl ?? realRun;
  return async (options: RunOptions): Promise<RunResult> => {
    if (!d.active()) return impl(options);
    const tracker = createIterationBoundaryTracker(d.send);
    try {
      const result = await impl({
        ...options,
        signal: options.signal ?? d.signal,
        logging: ipcLogging(options.logging, tracker.onEvent),
      });
      return result;
    } finally {
      tracker.flush();
    }
  };
};

export const wireCreateSandbox = (deps?: WireDeps) => {
  const d = resolveDeps(deps);
  const impl = d._createSandboxImpl ?? realCreateSandbox;
  return async (options: CreateSandboxOptions): Promise<Sandbox> => {
    if (!d.active()) return impl(options);
    const sandbox = await impl(options);
    return wrapSandbox(sandbox, d.send, d.signal);
  };
};

export const wireInteractive = (deps?: WireDeps) => {
  const d = resolveDeps(deps);
  const impl = d._interactiveImpl ?? realInteractive;
  return async (options: InteractiveOptions) => {
    if (!d.active()) return impl(options);
    return impl({
      ...options,
      signal: options.signal ?? d.signal,
    });
  };
};

const wrapSandbox = (
  sandbox: Sandbox,
  send: IpcSender,
  signal: AbortSignal | undefined,
): Sandbox => ({
  ...sandbox,
  run: async (opts: SandboxRunOptions): Promise<SandboxRunResult> => {
    const tracker = createIterationBoundaryTracker(send);
    try {
      const result = await sandbox.run({
        ...opts,
        signal: opts.signal ?? signal,
        logging: ipcLogging(opts.logging, tracker.onEvent),
      });
      // Forward commits explicitly — they are not part of AgentStreamEvent.
      for (const c of result.commits) send({ kind: "commit", sha: c.sha });
      return result;
    } finally {
      tracker.flush();
    }
  },
  interactive: async (
    opts: SandboxInteractiveOptions,
  ): Promise<SandboxInteractiveResult> => {
    const result = await sandbox.interactive({
      ...opts,
      signal: opts.signal ?? signal,
    });
    for (const c of result.commits) send({ kind: "commit", sha: c.sha });
    return result;
  },
});
