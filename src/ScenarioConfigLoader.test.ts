import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadScenarioConfig } from "./ScenarioConfigLoader.js";
import { ScenarioConfigError } from "./errors.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

// Absolute path to the loader's sibling `defineSandcastle.ts`. Fixtures import
// from this path so that the brand identity is the SAME module instance the
// loader checks against — emulating what production gets from `tsImport`
// resolving `@ai-hero/sandcastle` to a single `node_modules` copy.
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFINE_MODULE_URL = pathToFileURL(join(HERE, "defineSandcastle.ts")).href;

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "scenario-config-loader-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const writeFixture = (name: string, contents: string): string => {
  const filePath = join(tmpRoot, name);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
  return filePath;
};

const run = <A>(effect: Effect.Effect<A, ScenarioConfigError>): Promise<A> =>
  Effect.runPromise(effect);

const expectFailure = async (
  effect: Effect.Effect<unknown, ScenarioConfigError>,
  matcher: RegExp,
): Promise<void> => {
  const exit = await Effect.runPromiseExit(effect);
  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") return;
  // Squash the Cause to a string for matching.
  const message = JSON.stringify(exit.cause);
  expect(message).toMatch(matcher);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadScenarioConfig", () => {
  it("returns metadata for a valid config", async () => {
    const path = writeFixture(
      "valid.ts",
      `
        import { defineSandcastle } from "${DEFINE_MODULE_URL}";
        const backlog = {
          listPending: async () => [],
          getTicket: async () => ({}),
          markErrored: async () => {},
          clearErrored: async () => {},
        };
        export default defineSandcastle({
          backlogManager: backlog,
          scenarios: {
            "fix-bug": {
              description: "Fix a single bug ticket",
              maxIterations: 10,
              input: { type: "single-ticket" },
              run: async () => {},
            },
            "review-pr": {
              input: { type: "single-ticket" },
              run: async () => {},
            },
          },
        });
      `,
    );

    const result = await run(loadScenarioConfig(path));

    expect(result.scenarios).toHaveLength(2);
    expect(result.scenarios[0]).toEqual({
      name: "fix-bug",
      description: "Fix a single bug ticket",
      input: { type: "single-ticket" },
      maxIterations: 10,
    });
    expect(result.scenarios[1]).toEqual({
      name: "review-pr",
      description: undefined,
      input: { type: "single-ticket" },
      maxIterations: undefined,
    });
  });

  it("errors when the config file does not exist", async () => {
    await expectFailure(
      loadScenarioConfig(join(tmpRoot, "missing.ts")),
      /Config file not found/,
    );
  });

  it("errors when the default export is missing", async () => {
    const path = writeFixture("no-default.ts", `export const notDefault = 1;`);
    await expectFailure(loadScenarioConfig(path), /missing default export/);
  });

  it("errors when the default export is not from defineSandcastle()", async () => {
    const path = writeFixture(
      "hand-rolled.ts",
      `
        export default {
          backlogManager: {
            listPending: async () => [],
            getTicket: async () => ({}),
            markErrored: async () => {},
            clearErrored: async () => {},
          },
          scenarios: {
            x: { input: { type: "single-ticket" }, run: async () => {} },
          },
        };
      `,
    );
    await expectFailure(
      loadScenarioConfig(path),
      /not the result of .*defineSandcastle/,
    );
  });

  it("errors when scenarios is empty", async () => {
    const path = writeFixture(
      "empty.ts",
      `
        import { defineSandcastle } from "${DEFINE_MODULE_URL}";
        export default defineSandcastle({
          backlogManager: {
            listPending: async () => [],
            getTicket: async () => ({}),
            markErrored: async () => {},
            clearErrored: async () => {},
          },
          scenarios: {},
        });
      `,
    );
    await expectFailure(loadScenarioConfig(path), /no scenarios defined/);
  });

  it("errors when scenario.run is missing", async () => {
    const path = writeFixture(
      "no-run.ts",
      `
        import { defineSandcastle } from "${DEFINE_MODULE_URL}";
        export default defineSandcastle({
          backlogManager: {
            listPending: async () => [],
            getTicket: async () => ({}),
            markErrored: async () => {},
            clearErrored: async () => {},
          },
          // @ts-expect-error: deliberately missing run for the test
          scenarios: {
            broken: { input: { type: "single-ticket" } },
          },
        });
      `,
    );
    await expectFailure(loadScenarioConfig(path), /run.*must be a function/);
  });

  it("errors when scenario.run is not async", async () => {
    const path = writeFixture(
      "sync-run.ts",
      `
        import { defineSandcastle } from "${DEFINE_MODULE_URL}";
        export default defineSandcastle({
          backlogManager: {
            listPending: async () => [],
            getTicket: async () => ({}),
            markErrored: async () => {},
            clearErrored: async () => {},
          },
          scenarios: {
            broken: {
              input: { type: "single-ticket" },
              // @ts-expect-error: deliberately not async for the test
              run: () => {},
            },
          },
        });
      `,
    );
    await expectFailure(loadScenarioConfig(path), /must be an async function/);
  });

  it("errors when input.type is unknown", async () => {
    const path = writeFixture(
      "bad-input-type.ts",
      `
        import { defineSandcastle } from "${DEFINE_MODULE_URL}";
        export default defineSandcastle({
          backlogManager: {
            listPending: async () => [],
            getTicket: async () => ({}),
            markErrored: async () => {},
            clearErrored: async () => {},
          },
          scenarios: {
            broken: {
              // @ts-expect-error: unknown discriminator for the test
              input: { type: "errored-tickets" },
              run: async () => {},
            },
          },
        });
      `,
    );
    await expectFailure(
      loadScenarioConfig(path),
      /unknown.*input\.type.*errored-tickets/,
    );
  });

  it("errors when input is missing entirely", async () => {
    const path = writeFixture(
      "no-input.ts",
      `
        import { defineSandcastle } from "${DEFINE_MODULE_URL}";
        export default defineSandcastle({
          backlogManager: {
            listPending: async () => [],
            getTicket: async () => ({}),
            markErrored: async () => {},
            clearErrored: async () => {},
          },
          // @ts-expect-error: missing input field for the test
          scenarios: {
            broken: { run: async () => {} },
          },
        });
      `,
    );
    await expectFailure(loadScenarioConfig(path), /missing .*input.* field/);
  });

  it("errors when description is the wrong type", async () => {
    const path = writeFixture(
      "bad-description.ts",
      `
        import { defineSandcastle } from "${DEFINE_MODULE_URL}";
        export default defineSandcastle({
          backlogManager: {
            listPending: async () => [],
            getTicket: async () => ({}),
            markErrored: async () => {},
            clearErrored: async () => {},
          },
          scenarios: {
            broken: {
              // @ts-expect-error: wrong description type for the test
              description: 42,
              input: { type: "single-ticket" },
              run: async () => {},
            },
          },
        });
      `,
    );
    await expectFailure(
      loadScenarioConfig(path),
      /description.* must be a string/,
    );
  });

  it.each([
    ["string", `"oops"`],
    ["zero", `0`],
    ["negative", `-1`],
    ["non-integer", `1.5`],
  ])("errors when maxIterations is %s", async (label, literal) => {
    const path = writeFixture(
      `bad-max-iterations-${label}.ts`,
      `
        import { defineSandcastle } from "${DEFINE_MODULE_URL}";
        export default defineSandcastle({
          backlogManager: {
            listPending: async () => [],
            getTicket: async () => ({}),
            markErrored: async () => {},
            clearErrored: async () => {},
          },
          scenarios: {
            broken: {
              // @ts-expect-error: invalid maxIterations for the test
              maxIterations: ${literal},
              input: { type: "single-ticket" },
              run: async () => {},
            },
          },
        });
      `,
    );
    await expectFailure(
      loadScenarioConfig(path),
      /maxIterations.* must be a positive integer/,
    );
  });
});
