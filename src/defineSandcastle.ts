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
 * A ticket as returned by `BacklogManagerHostInterface.listPending` and
 * `getTicket`. Backlog-system-agnostic shape — JIRA, GitHub Issues, Linear,
 * etc. all map onto it.
 */
export interface BacklogTicket {
  /** External ticket id, e.g. `"VGD-135"` for JIRA. */
  readonly id: string;
  /** Short single-line title. */
  readonly title: string;
  /** Full description / body in the source system's native format. */
  readonly body: string;
  /** All labels currently on the ticket, including `agent-error` if present. */
  readonly labels: readonly string[];
  /** Web URL for humans to open the ticket in a browser. */
  readonly url: string;
  /** Source-system priority name (e.g. `"Medium"`), if available. */
  readonly priority?: string;
  /** ISO-8601 creation timestamp, if available. */
  readonly createdAt?: string;
  /** ISO-8601 last-updated timestamp, if available. */
  readonly updatedAt?: string;
}

/** Argument shape for `BacklogManagerHostInterface.markErrored`. */
export interface MarkErroredArgs {
  readonly id: string;
  /**
   * Short, structured failure summary (e.g. `"max iterations exceeded"`).
   * Implementations include this verbatim in the posted comment so triage
   * can grep for known reason strings.
   */
  readonly reason: string;
  /**
   * Optional additional human-readable context appended to the comment
   * (stack trace excerpt, last agent message, etc.).
   */
  readonly comment?: string;
}

/** Argument shape for `BacklogManagerHostInterface.listPending`. */
export interface ListPendingOptions {
  /**
   * When `true`, tickets labelled `agent-error` are included in the result.
   * Default: `false` (autopilot must not re-pick known-bad tickets).
   */
  readonly includeErrored?: boolean;
}

/**
 * Host-side capability surface a backlog manager exposes to the sandcastle
 * binary. Lives in the host process — implementations call their backing
 * system's REST API directly. Distinct from the in-sandbox CLI command shape
 * (`jira-pickup`, `gh issue list`, etc.) which is set up by `init`.
 *
 * - `listPending`: tickets the agent should pull next; excludes tickets
 *   labelled `agent-error` unless `options.includeErrored` is true.
 * - `getTicket`: hydrate a specific ticket by id.
 * - `markErrored`: apply the `agent-error` label and post a comment with the
 *   failure reason and context. Does NOT transition status.
 * - `clearErrored`: strip the `agent-error` label and post a retry comment.
 */
export interface BacklogManagerHostInterface {
  listPending(options?: ListPendingOptions): Promise<readonly BacklogTicket[]>;
  getTicket(id: string): Promise<BacklogTicket>;
  markErrored(args: MarkErroredArgs): Promise<void>;
  clearErrored(id: string): Promise<void>;
}

/**
 * @deprecated Use `BacklogManagerHostInterface` directly. Kept as an alias for
 * backward compatibility with Slice 1's loose placeholder contract.
 */
export type BacklogManager = BacklogManagerHostInterface;

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
 * Per-invocation overrides supplied by a manual UI run.
 *
 * Two of the three fields are auto-applied by the scenario-ctx wiring layer:
 *
 *  - `maxIterations` replaces whatever value the scenario passes to
 *    `ctx.run({ maxIterations })`.
 *  - `promptArgs` is shallow-merged with the scenario's `promptArgs`; manual
 *    keys win on conflict.
 *
 * `model` is **not** auto-applied because agent providers are constructed up
 * front (e.g. `claudeCode("claude-opus-4-7")`) and the wiring layer does not
 * know how to rebuild a provider with a different model. Scenarios that want
 * to honour the model override must read `ctx.overrides.model` themselves and
 * pass it into their provider factory.
 */
export interface ScenarioOverrides {
  readonly maxIterations?: number;
  readonly model?: string;
  readonly promptArgs?: Record<string, unknown>;
}

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
  /**
   * Manual-mode overrides for this invocation. Always defined; an empty object
   * means autopilot or a manual run with no overrides set. See
   * {@link ScenarioOverrides} for which fields the wiring layer applies
   * automatically.
   */
  readonly overrides: ScenarioOverrides;
}

/** A single named scenario in a `defineSandcastle({...})` config. */
export interface ScenarioDefinition<
  TInput extends ScenarioInput = ScenarioInput,
> {
  /** Optional human-readable summary, surfaced in the UI and `scenarios list`. */
  readonly description?: string;
  /**
   * Optional declared cap on iterations the scenario expects to run. When set,
   * the live UI renders `iteration.length / maxIterations` (e.g. `3 / 10`) in
   * the metrics header; when omitted, only the elapsed count is shown. Must be
   * a positive integer. This is metadata for display only — the runtime cap on
   * a single `ctx.run()` call is set on that call's own `maxIterations` arg.
   */
  readonly maxIterations?: number;
  /** Discriminated input — controls how the binary feeds work to this scenario. */
  readonly input: TInput;
  /** User-authored body. Receives a fully wired `ctx`. */
  readonly run: (ctx: ScenarioContext<TInput>) => Promise<void>;
}

export interface SandcastleConfigInput {
  readonly backlogManager: BacklogManagerHostInterface;
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
