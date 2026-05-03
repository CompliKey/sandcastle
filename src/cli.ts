import { Args, Command, Options } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import * as clack from "@clack/prompts";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve as resolvePath } from "node:path";
import { styleText } from "node:util";

import { createEventStore } from "./EventStore.js";
import { createFailureCoordinator } from "./FailureCoordinator.js";
import { runOrchestrationLoop } from "./OrchestrationLoop.js";
import { runScenario } from "./ScenarioRunner.js";
import { createSessionIndex } from "./SessionIndex.js";
import {
  DEFAULT_UI_HOST,
  DEFAULT_UI_PORT,
  probeExistingServer,
  startUiServer,
} from "./UiServer.js";
import { readLockfile, removeLockfile, writeLockfile } from "./UiLockfile.js";
import { openBrowser } from "./openBrowser.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Display } from "./Display.js";
import { buildImage, removeImage } from "./DockerLifecycle.js";
import {
  buildImage as podmanBuildImage,
  removeImage as podmanRemoveImage,
} from "./PodmanLifecycle.js";
import {
  scaffold,
  listTemplates,
  listAgents,
  getAgent,
  listBacklogManagers,
  getBacklogManager,
  listSandboxProviders,
  getSandboxProvider,
  getNextStepsLines,
} from "./InitService.js";
import { defaultImageName } from "./sandboxes/docker.js";
import type {
  AgentEntry,
  BacklogManagerEntry,
  SandboxProviderEntry,
} from "./InitService.js";
import { ConfigDirError, InitError } from "./errors.js";
import {
  loadSandcastleConfig,
  loadScenarioConfig,
} from "./ScenarioConfigLoader.js";

const require = createRequire(import.meta.url);
const VERSION = (require("../package.json") as { version: string }).version;

// --- Shared options ---

const imageNameOption = Options.text("image-name").pipe(
  Options.withDescription("Docker image name"),
  Options.optional,
);

const resolveImageName = (
  cliFlag: import("effect").Option.Option<string>,
  cwd: string,
): string => (cliFlag._tag === "Some" ? cliFlag.value : defaultImageName(cwd));

// --- Config directory check ---

const CONFIG_DIR = ".sandcastle";

const requireConfigDir = (
  cwd: string,
): Effect.Effect<void, ConfigDirError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs
      .exists(join(cwd, CONFIG_DIR))
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) {
      yield* Effect.fail(
        new ConfigDirError({
          message: "No .sandcastle/ found. Run `sandcastle init` first.",
        }),
      );
    }
  });

// --- Init command ---

const templateOption = Options.text("template").pipe(
  Options.withDescription(
    "Template to scaffold (e.g. blank, simple-loop, parallel-planner)",
  ),
  Options.optional,
);

const agentOption = Options.text("agent").pipe(
  Options.withDescription("Agent to use (e.g. claude-code)"),
  Options.optional,
);

const initModelOption = Options.text("model").pipe(
  Options.withDescription(
    "Model to use for the agent (e.g. claude-sonnet-4-6). Defaults to the agent's default model",
  ),
  Options.optional,
);

const initCommand = Command.make(
  "init",
  {
    imageName: imageNameOption,
    template: templateOption,
    agent: agentOption,
    model: initModelOption,
  },
  ({
    imageName: imageNameFlag,
    template,
    agent: agentFlag,
    model: modelFlag,
  }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const imageName = resolveImageName(imageNameFlag, cwd);

      // Early validation of CLI flags before interactive prompts
      const templates = listTemplates();
      if (template._tag === "Some") {
        const valid = templates.find((tmpl) => tmpl.name === template.value);
        if (!valid) {
          const names = templates.map((tmpl) => tmpl.name).join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown template "${template.value}". Available: ${names}`,
            }),
          );
        }
      }

      // Resolve agent: CLI flag > interactive select
      const agents = listAgents();
      let selectedAgent: AgentEntry;
      if (agentFlag._tag === "Some") {
        const entry = getAgent(agentFlag.value);
        if (!entry) {
          const names = agents.map((a) => a.name).join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown agent "${agentFlag.value}". Available: ${names}`,
            }),
          );
        }
        selectedAgent = entry!;
      } else {
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select an agent:",
            initialValue: "claude-code",
            options: agents.map((a) => ({
              value: a.name,
              label: a.label,
              hint: `Default model: ${a.defaultModel}`,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({ message: "Agent selection cancelled." }),
          );
        }
        selectedAgent = getAgent(selected as string)!;
      }

      // Resolve model: CLI flag > agent default
      const selectedModel =
        modelFlag._tag === "Some"
          ? modelFlag.value
          : selectedAgent.defaultModel;

      // Resolve sandbox provider: interactive select (no default — user must choose)
      const sandboxProviders = listSandboxProviders();
      let selectedSandboxProvider: SandboxProviderEntry;
      {
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a sandbox provider:",
            options: sandboxProviders.map((p) => ({
              value: p.name,
              label: p.label,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({
              message: "Sandbox provider selection cancelled.",
            }),
          );
        }
        selectedSandboxProvider = getSandboxProvider(selected as string)!;
      }

      // Resolve backlog manager: interactive select
      const backlogManagers = listBacklogManagers();
      let selectedBacklogManager: BacklogManagerEntry;
      {
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a backlog manager:",
            initialValue: "github-issues",
            options: backlogManagers.map((b) => ({
              value: b.name,
              label: b.label,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({
              message: "Backlog manager selection cancelled.",
            }),
          );
        }
        selectedBacklogManager = getBacklogManager(selected as string)!;
      }

      // Resolve template: CLI flag > interactive select (already validated above)
      let selectedTemplate: string;
      if (template._tag === "Some") {
        selectedTemplate = template.value;
      } else {
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a template:",
            initialValue: "blank",
            options: templates.map((tmpl) => ({
              value: tmpl.name,
              label: tmpl.name,
              hint: tmpl.description,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({ message: "Template selection cancelled." }),
          );
        }
        selectedTemplate = selected as string;
      }

      // Offer to create the "Sandcastle" label on the repo (skip for non-GitHub backlog managers)
      let shouldCreateLabel: boolean | symbol = false;
      if (selectedBacklogManager.name === "github-issues") {
        shouldCreateLabel = yield* Effect.promise(() =>
          clack.confirm({
            message:
              'Create a "Sandcastle" GitHub label? (Templates filter issues by this label)',
            initialValue: true,
          }),
        );

        if (shouldCreateLabel === true) {
          yield* Effect.try({
            try: () =>
              execSync(
                'gh label create "Sandcastle" --description "Issues for Sandcastle to work on" --color "F9A825" 2>/dev/null',
                { cwd, stdio: "ignore" },
              ),
            catch: () => undefined,
          }).pipe(Effect.ignore);
        }
      }

      const scaffoldResult = yield* d.spinner(
        "Scaffolding .sandcastle/ config directory...",
        scaffold(cwd, {
          agent: selectedAgent,
          model: selectedModel,
          templateName: selectedTemplate,
          createLabel: shouldCreateLabel === true,
          backlogManager: selectedBacklogManager,
          sandboxProvider: selectedSandboxProvider,
        }).pipe(
          Effect.mapError(
            (e) =>
              new InitError({
                message: `${e instanceof Error ? e.message : e}`,
              }),
          ),
        ),
      );

      // Prompt user before building image
      const providerLabel = selectedSandboxProvider.label;
      const shouldBuild = yield* Effect.promise(() =>
        clack.confirm({
          message: `Build the default ${providerLabel} image now?`,
          initialValue: true,
        }),
      );

      if (shouldBuild === true) {
        const containerfileDir = join(cwd, CONFIG_DIR);
        if (selectedSandboxProvider.name === "podman") {
          yield* d.spinner(
            `Building ${providerLabel} image '${imageName}'...`,
            podmanBuildImage(imageName, containerfileDir),
          );
        } else {
          yield* d.spinner(
            `Building ${providerLabel} image '${imageName}'...`,
            buildImage(imageName, containerfileDir),
          );
        }
        yield* d.status("Init complete! Image built successfully.", "success");
      } else {
        yield* d.status(
          `Init complete! Run \`sandcastle ${selectedSandboxProvider.cliNamespace} build-image\` to build the ${providerLabel} image later.`,
          "success",
        );
      }

      // Show template-specific next steps
      const nextSteps = getNextStepsLines(
        selectedTemplate,
        scaffoldResult.mainFilename,
      );
      for (const [i, line] of nextSteps.entries()) {
        yield* d.text(i === 0 ? line : styleText("dim", line));
      }
    }),
);

// --- Build-image command ---

const dockerfileOption = Options.file("dockerfile").pipe(
  Options.withDescription(
    "Path to a custom Dockerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

const buildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    dockerfile: dockerfileOption,
  },
  ({ imageName: imageNameFlag, dockerfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      const imageName = resolveImageName(imageNameFlag, cwd);

      const dockerfileDir = join(cwd, CONFIG_DIR);
      const dockerfilePath =
        dockerfile._tag === "Some" ? dockerfile.value : undefined;
      yield* d.spinner(
        `Building Docker image '${imageName}'...`,
        buildImage(imageName, dockerfileDir, {
          dockerfile: dockerfilePath,
        }),
      );

      yield* d.status("Build complete!", "success");
    }),
);

// --- Remove-image command ---

const removeImageCommand = Command.make(
  "remove-image",
  {
    imageName: imageNameOption,
  },
  ({ imageName: imageNameFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();

      const imageName = resolveImageName(imageNameFlag, cwd);

      yield* d.spinner(
        `Removing Docker image '${imageName}'...`,
        removeImage(imageName),
      );
      yield* d.status("Image removed.", "success");
    }),
);

// --- Docker namespace command ---

const dockerCommand = Command.make("docker", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Docker sandbox commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(Command.withSubcommands([buildImageCommand, removeImageCommand]));

// --- Podman build-image command ---

const containerfileOption = Options.file("containerfile").pipe(
  Options.withDescription(
    "Path to a custom Containerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

const podmanBuildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    containerfile: containerfileOption,
  },
  ({ imageName: imageNameFlag, containerfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      const imageName = resolveImageName(imageNameFlag, cwd);

      const containerfileDir = join(cwd, CONFIG_DIR);
      const containerfilePath =
        containerfile._tag === "Some" ? containerfile.value : undefined;
      yield* d.spinner(
        `Building Podman image '${imageName}'...`,
        podmanBuildImage(imageName, containerfileDir, {
          containerfile: containerfilePath,
        }),
      );

      yield* d.status("Build complete!", "success");
    }),
);

// --- Podman remove-image command ---

const podmanRemoveImageCommand = Command.make(
  "remove-image",
  {
    imageName: imageNameOption,
  },
  ({ imageName: imageNameFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();

      const imageName = resolveImageName(imageNameFlag, cwd);

      yield* d.spinner(
        `Removing Podman image '${imageName}'...`,
        podmanRemoveImage(imageName),
      );
      yield* d.status("Image removed.", "success");
    }),
);

// --- Podman namespace command ---

const podmanCommand = Command.make("podman", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Podman sandbox commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(
  Command.withSubcommands([podmanBuildImageCommand, podmanRemoveImageCommand]),
);

// --- Scenarios commands ---

const DEFAULT_CONFIG_PATH = ".sandcastle/main.ts";

const scenariosConfigOption = Options.file("config").pipe(
  Options.withDescription(
    `Path to the sandcastle config (default: ${DEFAULT_CONFIG_PATH})`,
  ),
  Options.optional,
);

const scenariosListCommand = Command.make(
  "list",
  { config: scenariosConfigOption },
  ({ config }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const configPath =
        config._tag === "Some" ? config.value : join(cwd, DEFAULT_CONFIG_PATH);

      const metadata = yield* loadScenarioConfig(configPath);

      if (metadata.scenarios.length === 0) {
        // Loader rejects empty `scenarios` already; this is belt-and-braces.
        yield* d.status("No scenarios defined.", "info");
        return;
      }

      yield* d.text(
        styleText("bold", `Scenarios (${metadata.scenarios.length}):`),
      );
      for (const scenario of metadata.scenarios) {
        yield* d.text(
          `  ${styleText("cyan", scenario.name)}  ${styleText(
            "dim",
            `input: ${scenario.input.type}`,
          )}`,
        );
        if (scenario.description !== undefined) {
          yield* d.text(`    ${styleText("dim", scenario.description)}`);
        }
      }
    }),
);

const scenariosCommand = Command.make("scenarios", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Scenario commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(Command.withSubcommands([scenariosListCommand]));

// --- Queue commands ---

const queueConfigOption = Options.file("config").pipe(
  Options.withDescription(
    `Path to the sandcastle config (default: ${DEFAULT_CONFIG_PATH})`,
  ),
  Options.optional,
);

const queueIncludeErroredOption = Options.boolean("include-errored").pipe(
  Options.withDescription(
    "Include tickets labelled `agent-error` (default: excluded).",
  ),
);

const queueListCommand = Command.make(
  "list",
  {
    config: queueConfigOption,
    includeErrored: queueIncludeErroredOption,
  },
  ({ config, includeErrored }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const configPath =
        config._tag === "Some" ? config.value : join(cwd, DEFAULT_CONFIG_PATH);

      const loaded = yield* loadSandcastleConfig(configPath);
      const tickets = yield* Effect.tryPromise({
        try: () => loaded.backlogManager.listPending({ includeErrored }),
        catch: (err) =>
          new InitError({
            message: `Failed to list pending tickets: ${
              err instanceof Error ? err.message : String(err)
            }`,
          }),
      });

      if (tickets.length === 0) {
        yield* d.status("No pending tickets.", "info");
        return;
      }

      const headerSuffix = includeErrored ? " (including errored)" : "";
      yield* d.text(
        styleText(
          "bold",
          `Pending tickets (${tickets.length})${headerSuffix}:`,
        ),
      );
      for (const ticket of tickets) {
        const labelText =
          ticket.labels.length === 0
            ? ""
            : `  ${styleText("dim", `[${ticket.labels.join(", ")}]`)}`;
        yield* d.text(
          `  ${styleText("cyan", ticket.id)}  ${ticket.title}${labelText}`,
        );
        yield* d.text(`    ${styleText("dim", ticket.url)}`);
      }
    }),
);

const queueCommand = Command.make("queue", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Queue commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(Command.withSubcommands([queueListCommand]));

// --- run-scenario command ---

/**
 * Run a single scenario invocation against the next pending ticket.
 *
 * v1 demoable surface: no autopilot loop, no UI, no JIRA labelling. Pulls
 * `listPending({ includeErrored: false })` from the user's backlog manager,
 * picks the head of the list, and invokes the named scenario in a child
 * process. Events stream back over IPC and persist under
 * `.sandcastle/state/events.jsonl`.
 */

const runScenarioConfigOption = Options.file("config").pipe(
  Options.withDescription(
    `Path to the sandcastle config (default: ${DEFAULT_CONFIG_PATH})`,
  ),
  Options.optional,
);

const runScenarioNameArg = Args.text({ name: "scenario" }).pipe(
  Args.withDescription(
    "Name of the scenario to invoke (must exist in the config's `scenarios`).",
  ),
);

const runScenarioCommand = Command.make(
  "run-scenario",
  { scenario: runScenarioNameArg, config: runScenarioConfigOption },
  ({ scenario, config }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const configPath =
        config._tag === "Some" ? config.value : join(cwd, DEFAULT_CONFIG_PATH);

      yield* requireConfigDir(cwd);

      const loaded = yield* loadSandcastleConfig(configPath);
      const scenarioMeta = loaded.metadata.scenarios.find(
        (s) => s.name === scenario,
      );
      if (!scenarioMeta) {
        const names = loaded.metadata.scenarios.map((s) => s.name).join(", ");
        yield* Effect.fail(
          new InitError({
            message: `Unknown scenario "${scenario}". Available: ${names || "(none)"}.`,
          }),
        );
      }

      const tickets = yield* Effect.tryPromise({
        try: () => loaded.backlogManager.listPending({ includeErrored: false }),
        catch: (err) =>
          new InitError({
            message: `Failed to list pending tickets: ${
              err instanceof Error ? err.message : String(err)
            }`,
          }),
      });

      if (tickets.length === 0) {
        yield* d.status(
          "No pending tickets — nothing to run. Add a ticket and try again.",
          "info",
        );
        return;
      }

      const ticket = tickets[0]!;
      yield* d.text(
        `${styleText("bold", "Scenario:")} ${styleText("cyan", scenario)}`,
      );
      yield* d.text(
        `${styleText("bold", "Ticket:")}  ${styleText("cyan", ticket.id)}  ${ticket.title}`,
      );

      const eventsDir = resolvePath(cwd, ".sandcastle", "state");
      const store = createEventStore({ dir: eventsDir });

      // Forward host SIGTERM/SIGINT into the runner's AbortController so the
      // child gets a clean halt and a `session.end { halted }` lands.
      const ac = new AbortController();
      const onSignal = (): void => ac.abort();
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);

      const result = yield* Effect.tryPromise({
        try: () =>
          runScenario({
            scenario,
            ticketId: ticket.id,
            configPath: resolvePath(configPath),
            store,
            signal: ac.signal,
          }),
        catch: (err) =>
          new InitError({
            message: `runScenario failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          }),
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            process.removeListener("SIGTERM", onSignal);
            process.removeListener("SIGINT", onSignal);
          }),
        ),
        Effect.tap(() => Effect.promise(() => store.close())),
      );

      const severity =
        result.outcome === "done"
          ? "success"
          : result.outcome === "halted"
            ? "warn"
            : "error";
      yield* d.status(
        `Scenario "${scenario}" finished: ${result.outcome} (session ${result.sessionId})`,
        severity,
      );
    }),
);

// --- autopilot command ---

/**
 * Autopilot drain loop: pulls pending tickets and dispatches the named scenario
 * for each one, in a child process. On ticket-level failures it labels the
 * ticket `agent-error` (via the user's backlog manager) and continues; on
 * infra-level failures or circuit-breaker trips it halts. On empty queue it
 * idles instead of exiting, so the (future) UI sees a live process during gaps.
 *
 * `--scenario` is optional when the config defines exactly one scenario;
 * otherwise it is required.
 */

const autopilotConfigOption = Options.file("config").pipe(
  Options.withDescription(
    `Path to the sandcastle config (default: ${DEFAULT_CONFIG_PATH})`,
  ),
  Options.optional,
);

const autopilotScenarioOption = Options.text("scenario").pipe(
  Options.withDescription(
    "Scenario to invoke for each ticket. Optional when the config defines exactly one scenario.",
  ),
  Options.optional,
);

const autopilotIdlePollOption = Options.integer("idle-poll-ms").pipe(
  Options.withDescription(
    "Poll interval (ms) when the queue is empty (default: 5000).",
  ),
  Options.optional,
);

const autopilotCommand = Command.make(
  "autopilot",
  {
    config: autopilotConfigOption,
    scenario: autopilotScenarioOption,
    idlePoll: autopilotIdlePollOption,
  },
  ({ config, scenario, idlePoll }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const configPath =
        config._tag === "Some" ? config.value : join(cwd, DEFAULT_CONFIG_PATH);

      yield* requireConfigDir(cwd);

      const loaded = yield* loadSandcastleConfig(configPath);
      const scenarioNames = loaded.metadata.scenarios.map((s) => s.name);

      let scenarioName: string;
      if (scenario._tag === "Some") {
        if (!scenarioNames.includes(scenario.value)) {
          yield* Effect.fail(
            new InitError({
              message: `Unknown scenario "${scenario.value}". Available: ${scenarioNames.join(", ") || "(none)"}.`,
            }),
          );
        }
        scenarioName = scenario.value;
      } else if (scenarioNames.length === 1) {
        scenarioName = scenarioNames[0]!;
      } else {
        yield* Effect.fail(
          new InitError({
            message:
              scenarioNames.length === 0
                ? "Config defines no scenarios. Add one to `defineSandcastle({ scenarios })`."
                : `Config defines multiple scenarios — pass --scenario=<name>. Available: ${scenarioNames.join(", ")}.`,
          }),
        );
        return; // unreachable; satisfies the type narrowing for `scenarioName`
      }

      yield* d.text(
        `${styleText("bold", "Autopilot:")} scenario=${styleText("cyan", scenarioName)}  config=${styleText("dim", configPath)}`,
      );

      const eventsDir = resolvePath(cwd, ".sandcastle", "state");
      const store = createEventStore({ dir: eventsDir });

      const ac = new AbortController();
      const onSignal = (): void => ac.abort();
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);

      const coordinator = createFailureCoordinator({
        backlogManager: loaded.backlogManager,
      });

      const result = yield* Effect.tryPromise({
        try: () =>
          runOrchestrationLoop({
            scenario: scenarioName,
            backlogManager: loaded.backlogManager,
            failureCoordinator: coordinator,
            signal: ac.signal,
            idlePollIntervalMs:
              idlePoll._tag === "Some" ? idlePoll.value : undefined,
            runScenario: (args) =>
              runScenario({
                scenario: args.scenario,
                ticketId: args.ticketId,
                configPath: resolvePath(configPath),
                store,
                signal: ac.signal,
              }),
          }),
        catch: (err) =>
          new InitError({
            message: `Autopilot loop crashed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          }),
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            process.removeListener("SIGTERM", onSignal);
            process.removeListener("SIGINT", onSignal);
          }),
        ),
        Effect.tap(() => Effect.promise(() => store.close())),
      );

      const summary = `attempted=${result.ticketsAttempted}  done=${result.ticketsCompleted}  errored=${result.ticketsErrored}`;
      if (result.status === "halted") {
        yield* d.status(
          `Autopilot halted: ${result.reason}. ${summary}`,
          "error",
        );
      } else {
        yield* d.status(
          `Autopilot stopped: ${result.reason}. ${summary}`,
          "warn",
        );
      }
    }),
);

// --- ui command ---

/**
 * `sandcastle ui` — boots the local UI server, replays the event log into a
 * SessionIndex, opens the user's browser, and stays in the foreground until
 * SIGINT/SIGTERM (closing the launching terminal kills it).
 *
 * Single-instance protocol: a second invocation reads the lockfile, probes
 * `/api/health`, and — if the prior server is alive — opens a new tab against
 * it instead of erroring on `EADDRINUSE`.
 */

const uiPortOption = Options.integer("port").pipe(
  Options.withDescription(
    `Port to bind the UI server to (default: ${DEFAULT_UI_PORT}).`,
  ),
  Options.optional,
);

const uiHostOption = Options.text("host").pipe(
  Options.withDescription(
    `Host interface to bind to (default: ${DEFAULT_UI_HOST}). Leave as loopback unless you know what you're doing.`,
  ),
  Options.optional,
);

const uiNoOpenOption = Options.boolean("no-open").pipe(
  Options.withDescription(
    "Do not auto-open the browser. Useful for headless / SSH workflows.",
  ),
);

const uiAssetsDirOption = Options.directory("assets-dir").pipe(
  Options.withDescription(
    "Override the bundled frontend directory (defaults to dist/ui/ next to the CLI).",
  ),
  Options.optional,
);

const defaultAssetsDir = (): string => {
  // dist/cli.js → dist/ui
  const cliDir = dirname(fileURLToPath(import.meta.url));
  return join(cliDir, "ui");
};

const uiCommand = Command.make(
  "ui",
  {
    port: uiPortOption,
    host: uiHostOption,
    noOpen: uiNoOpenOption,
    assetsDir: uiAssetsDirOption,
  },
  ({ port, host, noOpen, assetsDir }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      const stateDir = resolvePath(cwd, ".sandcastle", "state");
      const resolvedHost = host._tag === "Some" ? host.value : DEFAULT_UI_HOST;
      const resolvedPort = port._tag === "Some" ? port.value : DEFAULT_UI_PORT;

      // 1. Single-instance hand-off via the lockfile + health probe.
      const existing = yield* Effect.promise(() => readLockfile(stateDir));
      if (existing) {
        const probed = yield* Effect.promise(() =>
          probeExistingServer(existing.url),
        );
        if (probed) {
          yield* d.status(
            `sandcastle ui already running at ${existing.url} (pid ${probed.pid}).`,
            "info",
          );
          if (!noOpen) {
            openBrowser(existing.url);
            yield* d.text(`Opened a new browser tab.`);
          } else {
            yield* d.text(`URL: ${existing.url}`);
          }
          return;
        }
        // Lockfile points at a corpse — clean it up before we try to bind.
        yield* Effect.promise(() => removeLockfile(stateDir));
      }

      // 2. Replay the event log into a fresh SessionIndex.
      const store = createEventStore({ dir: stateDir });
      const index = createSessionIndex();
      yield* Effect.promise(async () => {
        for await (const { event } of store.replay()) {
          index.add(event);
        }
      });

      const resolvedAssetsDir =
        assetsDir._tag === "Some" ? assetsDir.value : defaultAssetsDir();

      // 3. Start the server.
      const server = yield* Effect.tryPromise({
        try: () =>
          startUiServer({
            index,
            host: resolvedHost,
            port: resolvedPort,
            assetsDir: resolvedAssetsDir,
            version: VERSION,
          }),
        catch: (err) => {
          const isAddrInUse =
            typeof err === "object" &&
            err !== null &&
            (err as NodeJS.ErrnoException).code === "EADDRINUSE";
          return new InitError({
            message: isAddrInUse
              ? `Port ${resolvedPort} is already in use, but no sandcastle UI server responded on it. Stop the other process or pass --port=<n>.`
              : `Failed to start UI server: ${
                  err instanceof Error ? err.message : String(err)
                }`,
          });
        },
      });

      // 4. Persist the lockfile so a second invocation can find us.
      yield* Effect.promise(() =>
        writeLockfile(stateDir, {
          pid: process.pid,
          host: server.host,
          port: server.port,
          url: server.url,
          startedAt: Date.now(),
        }),
      );

      // 5. Wire signal handlers + foreground await.
      const shutdownSignal = new AbortController();
      const onSignal = (): void => shutdownSignal.abort();
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);
      // SIGHUP fires when the controlling terminal closes — making the
      // foreground-binding contract explicit ("close the terminal, kill the
      // server") cross-platform.
      process.once("SIGHUP", onSignal);

      yield* d.status(`sandcastle ui listening on ${server.url}`, "success");
      yield* d.text(`State directory: ${stateDir}`);
      yield* d.text(`Press Ctrl+C to stop.`);

      if (!noOpen) {
        openBrowser(server.url);
      }

      yield* Effect.async<void>((resume) => {
        if (shutdownSignal.signal.aborted) {
          resume(Effect.void);
          return;
        }
        shutdownSignal.signal.addEventListener(
          "abort",
          () => resume(Effect.void),
          { once: true },
        );
      }).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            process.removeListener("SIGTERM", onSignal);
            process.removeListener("SIGINT", onSignal);
            process.removeListener("SIGHUP", onSignal);
            await server.close();
            await store.close();
            await removeLockfile(stateDir);
          }),
        ),
      );

      yield* d.status("sandcastle ui stopped.", "info");
    }),
);

// --- Root command ---

const rootCommand = Command.make("sandcastle", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(`Sandcastle v${VERSION}`, "info");
    yield* d.status("Use --help to see available commands.", "info");
  }),
);

export const sandcastle = rootCommand.pipe(
  Command.withSubcommands([
    initCommand,
    dockerCommand,
    podmanCommand,
    scenariosCommand,
    queueCommand,
    runScenarioCommand,
    autopilotCommand,
    uiCommand,
  ]),
);

export const cli = Command.run(sandcastle, {
  name: "sandcastle",
  version: VERSION,
});
