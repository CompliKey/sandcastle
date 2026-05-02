/**
 * User-authored entry point for the `sandcastle ui` orchestration loop.
 *
 * A host repo's `.sandcastle/main.ts` exports a `defineSandcastle({...})` config
 * declaring a backlog manager and a map of named scenarios. The sandcastle
 * binary loads this config, reads scenario metadata, and dispatches scenarios
 * (each in its own child process) on demand.
 *
 * This module owns the public type contract. The `ScenarioConfigLoader` deep
 * module owns runtime validation. Other modules wire `ctx` and dispatch
 * scenario invocations — those land in later slices.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Pre-fetched ticket passed to a scenario's `run` via `ctx.ticket`.
 *
 * Minimal at v1 — additional fields (status, body, labels, etc.) land as the
 * orchestration loop slice fleshes out the lifecycle.
 */
export interface ScenarioTicket {
  readonly id: string;
  readonly title: string;
}

/**
 * Host-side capability surface a backlog manager exposes to the sandcastle
 * binary. The binary uses these methods to drive autopilot lifecycle:
 *
 * - `listPending`: tickets the agent should pull next, excluding those already
 *   labelled `agent-error`.
 * - `getTicket`: hydrate a specific ticket by id.
 * - `markErrored`: tag a ticket as a ticket-level failure and post a comment.
 * - `clearErrored`: strip the `agent-error` label and post a retry comment.
 *
 * Concrete shapes (parameters, return types) are intentionally loose at this
 * slice — the JIRA implementation lands in a later slice and pins them down.
 */
export interface BacklogManager {
  readonly listPending: (...args: any[]) => any;
  readonly getTicket: (...args: any[]) => any;
  readonly markErrored: (...args: any[]) => any;
  readonly clearErrored: (...args: any[]) => any;
}

/** v1 scenario input variant: a single ticket pulled from the backlog. */
export interface SingleTicketInput {
  readonly type: "single-ticket";
}

/**
 * Discriminated union of supported scenario inputs.
 *
 * Future variants (e.g. `errored-tickets`, `none`, parallel-multi-ticket) are
 * additive — adding a new member here does not break existing configs.
 * `SUPPORTED_INPUT_TYPES` in `ScenarioConfigLoader` must stay in sync.
 */
export type ScenarioInput = SingleTicketInput;

/**
 * `log` helper available to a scenario via `ctx.log`. Emits a structured
 * user-defined event into the events log. Wiring lands in a later slice.
 */
export type ScenarioLogFn = (
  event: string,
  data?: Record<string, unknown>,
) => void;

/**
 * The `ctx` passed to a scenario's `run`. Pre-wired plumbing means user code
 * does not have to instantiate `run`/`createSandbox`/`interactive` itself or
 * thread `signal`/`logging` through manually.
 *
 * Concrete function shapes for `run`/`createSandbox`/`interactive` are pinned
 * down in the slice that ships the child-process scenario runner; at this
 * slice we only fix the names so user-authored configs already type-check.
 */
export interface ScenarioContext<TInput extends ScenarioInput = ScenarioInput> {
  readonly input: TInput;
  readonly ticket: ScenarioTicket;
  readonly run: (...args: any[]) => Promise<any>;
  readonly createSandbox: (...args: any[]) => Promise<any>;
  readonly interactive: (...args: any[]) => Promise<any>;
  readonly signal: AbortSignal;
  readonly log: ScenarioLogFn;
}

/** A single named scenario in a `defineSandcastle({...})` config. */
export interface ScenarioDefinition<
  TInput extends ScenarioInput = ScenarioInput,
> {
  /** Optional human-readable summary, surfaced in the UI and `scenarios list`. */
  readonly description?: string;
  /** Discriminated input — controls how the binary feeds work to this scenario. */
  readonly input: TInput;
  /** User-authored body. Receives a fully wired `ctx`. */
  readonly run: (ctx: ScenarioContext<TInput>) => Promise<void>;
}

export interface SandcastleConfigInput {
  readonly backlogManager: BacklogManager;
  readonly scenarios: Record<string, ScenarioDefinition>;
}

/**
 * Brand field used by the loader to verify a default export was produced by
 * `defineSandcastle()` rather than hand-rolled. A non-enumerable string
 * property is realm-safe — `tsImport` may load `@ai-hero/sandcastle` from the
 * host repo's `node_modules`, so a `Symbol`-keyed brand would not match.
 */
export const SANDCASTLE_CONFIG_BRAND = "__sandcastleConfig" as const;

export interface SandcastleConfig extends SandcastleConfigInput {
  readonly [SANDCASTLE_CONFIG_BRAND]: 1;
}

/**
 * The user-facing factory. The runtime work is small (brand the input) — the
 * value is in pinning the type contract host repos compile against.
 */
export const defineSandcastle = (
  config: SandcastleConfigInput,
): SandcastleConfig => {
  const branded = { ...config };
  Object.defineProperty(branded, SANDCASTLE_CONFIG_BRAND, {
    value: 1,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return branded as SandcastleConfig;
};

/** Loader-facing predicate. Public so a future programmatic API can reuse it. */
export const isSandcastleConfig = (value: unknown): value is SandcastleConfig =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<string, unknown>)[SANDCASTLE_CONFIG_BRAND] === 1;
