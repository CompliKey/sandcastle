/**
 * Reads a `.sandcastle/main.ts` config and returns scenario metadata.
 *
 * Pure parse-and-validate: this module imports the user's config (via tsx's
 * `tsImport`), checks the default export came from `defineSandcastle()`, and
 * extracts each scenario's name, input shape, and description. It does not
 * invoke any scenario, spawn a child process, or touch persistence — those
 * concerns belong to later slices.
 *
 * The loader's job is to give the user a clear, attributable error for the
 * most likely config-time mistakes (missing default export, scenario `run`
 * not async, unknown `input.type`, etc.). Every error names the file, the
 * scenario (when applicable), and the expected fix.
 */

import { Effect } from "effect";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

import { isSandcastleConfig, type ScenarioInput } from "./defineSandcastle.js";
import { ScenarioConfigError } from "./errors.js";

/** Public metadata shape returned for each scenario. */
export interface ScenarioMetadata {
  readonly name: string;
  readonly description?: string;
  readonly input: ScenarioInput;
}

export interface SandcastleConfigMetadata {
  readonly scenarios: readonly ScenarioMetadata[];
}

/**
 * Currently the only valid `input.type`. Add new variants here in lockstep
 * with the `ScenarioInput` union in `defineSandcastle.ts`.
 */
const SUPPORTED_INPUT_TYPES: readonly string[] = ["single-ticket"];

const fail = (message: string) =>
  Effect.fail(new ScenarioConfigError({ message }));

/**
 * Load and validate a sandcastle config.
 *
 * @param configPath  Path to the user's config (typically `.sandcastle/main.ts`).
 *                    Relative paths resolve against `process.cwd()`.
 */
export const loadScenarioConfig = (
  configPath: string,
): Effect.Effect<SandcastleConfigMetadata, ScenarioConfigError> =>
  Effect.gen(function* () {
    const absolute = resolve(configPath);

    if (!existsSync(absolute)) {
      return yield* fail(
        `Config file not found: ${absolute}. Run \`sandcastle init\` to scaffold one.`,
      );
    }

    const mod = yield* Effect.tryPromise({
      try: () => tsImport(pathToFileURL(absolute).href, import.meta.url),
      catch: (err) =>
        new ScenarioConfigError({
          message: `Failed to load ${absolute}: ${err instanceof Error ? err.message : String(err)}`,
        }),
    });

    // tsx's `tsImport` returns a `mod` whose `default` property is itself a
    // Module Namespace Object (or a CJS-interop wrapper with `__esModule: true`).
    // Unwrap one level so `export default defineSandcastle({...})` lands on
    // `defaultExport` directly, and a config with NO default export surfaces
    // as `defaultExport === undefined` rather than a confusing wrapper object.
    const rawDefault = (mod as { default?: unknown }).default;
    const isWrappedDefault =
      rawDefault !== null &&
      typeof rawDefault === "object" &&
      ((rawDefault as { [Symbol.toStringTag]?: string })[Symbol.toStringTag] ===
        "Module" ||
        (rawDefault as Record<string, unknown>).__esModule === true);
    const defaultExport: unknown = isWrappedDefault
      ? (rawDefault as { default?: unknown }).default
      : rawDefault;

    if (defaultExport === undefined) {
      return yield* fail(
        `${absolute}: missing default export. Expected \`export default defineSandcastle({ ... })\`.`,
      );
    }

    if (!isSandcastleConfig(defaultExport)) {
      return yield* fail(
        `${absolute}: default export is not the result of \`defineSandcastle()\`. ` +
          `Wrap your config with \`export default defineSandcastle({ ... })\`.`,
      );
    }

    const { scenarios: scenariosObject } = defaultExport;

    if (
      typeof scenariosObject !== "object" ||
      scenariosObject === null ||
      Array.isArray(scenariosObject)
    ) {
      return yield* fail(
        `${absolute}: \`scenarios\` must be an object keyed by scenario name.`,
      );
    }

    const entries = Object.entries(scenariosObject);
    if (entries.length === 0) {
      return yield* fail(
        `${absolute}: no scenarios defined. Add at least one entry to \`scenarios\`.`,
      );
    }

    const metadata: ScenarioMetadata[] = [];
    for (const [name, raw] of entries) {
      metadata.push(yield* validateScenario(absolute, name, raw));
    }

    return { scenarios: metadata };
  });

const validateScenario = (
  configPath: string,
  name: string,
  raw: unknown,
): Effect.Effect<ScenarioMetadata, ScenarioConfigError> =>
  Effect.gen(function* () {
    const where = `${configPath}: scenario "${name}"`;

    if (typeof raw !== "object" || raw === null) {
      return yield* fail(
        `${where}: must be an object with \`input\` and \`run\` fields.`,
      );
    }

    const obj = raw as Record<string, unknown>;

    if (typeof obj.run !== "function") {
      return yield* fail(`${where}: \`run\` must be a function.`);
    }
    // Heuristic: the user wrote `run() {}` or `run: function () {}` instead of
    // `async run() {}`. Catches the listed user mistake without invoking the
    // function. Users who genuinely need a non-async function returning a
    // Promise can wrap it: `async (ctx) => existingPromiseFn(ctx)`.
    if (
      (obj.run as { constructor?: { name?: string } }).constructor?.name !==
      "AsyncFunction"
    ) {
      return yield* fail(
        `${where}: \`run\` must be an async function (declared with the \`async\` keyword).`,
      );
    }

    if (typeof obj.input !== "object" || obj.input === null) {
      return yield* fail(
        `${where}: missing \`input\` field. Expected \`input: { type: "single-ticket" }\`.`,
      );
    }

    const input = obj.input as Record<string, unknown>;
    if (typeof input.type !== "string") {
      return yield* fail(`${where}: \`input.type\` must be a string.`);
    }
    if (!SUPPORTED_INPUT_TYPES.includes(input.type)) {
      const supported = SUPPORTED_INPUT_TYPES.map((s) => `"${s}"`).join(", ");
      return yield* fail(
        `${where}: unknown \`input.type\` "${input.type}". Supported: ${supported}.`,
      );
    }

    let description: string | undefined;
    if (obj.description !== undefined) {
      if (typeof obj.description !== "string") {
        return yield* fail(
          `${where}: \`description\` must be a string when provided.`,
        );
      }
      description = obj.description;
    }

    return {
      name,
      description,
      input: input as unknown as ScenarioInput,
    };
  });
