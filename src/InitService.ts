import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";

const GITIGNORE = `.env
logs/
worktrees/
`;

export interface TemplateMetadata {
  name: string;
  description: string;
}

const TEMPLATES: TemplateMetadata[] = [
  {
    name: "blank",
    description: "Bare scaffold — write your own prompt and orchestration",
  },
  {
    name: "simple-loop",
    description: "Picks GitHub issues one by one and closes them",
  },
  {
    name: "sequential-reviewer",
    description:
      "Implements issues one by one, with a code review step after each",
  },
  {
    name: "parallel-planner",
    description:
      "Plans parallelizable issues, executes on separate branches, merges",
  },
  {
    name: "parallel-planner-with-review",
    description:
      "Plans parallelizable issues, executes with per-branch review, merges",
  },
];

export const listTemplates = (): TemplateMetadata[] => TEMPLATES;

// ---------------------------------------------------------------------------
// Agent registry (internal — not part of public API)
// ---------------------------------------------------------------------------

export interface AgentEntry {
  readonly name: string;
  readonly label: string;
  readonly defaultModel: string;
  readonly factoryImport: string;
  readonly dockerfileTemplate: string;
  /** Lines to include in the generated `.env.example` for this agent's API key. */
  readonly envExample: string;
}

const CLAUDE_CODE_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{BACKLOG_MANAGER_TOOLS}}

# Rename the base image's "node" user (UID 1000) to "agent".
# This keeps UID 1000 so that --userns=keep-id (Podman) and
# --user 1000:1000 (Docker) map to the correct home directory owner.
RUN usermod -d /home/agent -m -l agent node
USER agent

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const PI_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{BACKLOG_MANAGER_TOOLS}}

# Rename the base image's "node" user (UID 1000) to "agent".
# This keeps UID 1000 so that --userns=keep-id (Podman) and
# --user 1000:1000 (Docker) map to the correct home directory owner.
RUN usermod -d /home/agent -m -l agent node

# Install pi coding agent (run as root before USER agent)
RUN npm install -g @mariozechner/pi-coding-agent

USER agent

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const CODEX_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{BACKLOG_MANAGER_TOOLS}}

# Rename the base image's "node" user (UID 1000) to "agent".
# This keeps UID 1000 so that --userns=keep-id (Podman) and
# --user 1000:1000 (Docker) map to the correct home directory owner.
RUN usermod -d /home/agent -m -l agent node

# Install Codex CLI (run as root before USER agent)
RUN npm install -g @openai/codex

USER agent

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const OPENCODE_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{BACKLOG_MANAGER_TOOLS}}

# Rename the base image's "node" user (UID 1000) to "agent".
# This keeps UID 1000 so that --userns=keep-id (Podman) and
# --user 1000:1000 (Docker) map to the correct home directory owner.
RUN usermod -d /home/agent -m -l agent node

# Install OpenCode CLI (run as root before USER agent)
RUN npm install -g opencode-ai@latest

USER agent

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at \${SANDBOX_REPO_DIR}
# and overrides the working directory to \${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that \${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const AGENT_REGISTRY: AgentEntry[] = [
  {
    name: "claude-code",
    label: "Claude Code",
    defaultModel: "claude-opus-4-6",
    factoryImport: "claudeCode",
    dockerfileTemplate: CLAUDE_CODE_DOCKERFILE,
    envExample: `# Anthropic API key
# If you want to use your Claude subscription instead of an API key, see https://github.com/mattpocock/sandcastle/issues/191
ANTHROPIC_API_KEY=`,
  },
  {
    name: "pi",
    label: "Pi",
    defaultModel: "claude-sonnet-4-6",
    factoryImport: "pi",
    dockerfileTemplate: PI_DOCKERFILE,
    envExample: `# Anthropic API key
ANTHROPIC_API_KEY=`,
  },
  {
    name: "codex",
    label: "Codex",
    defaultModel: "gpt-5.4-mini",
    factoryImport: "codex",
    dockerfileTemplate: CODEX_DOCKERFILE,
    envExample: `# OpenAI API key
OPENAI_KEY=`,
  },
  {
    name: "opencode",
    label: "OpenCode",
    defaultModel: "opencode/big-pickle",
    factoryImport: "opencode",
    dockerfileTemplate: OPENCODE_DOCKERFILE,
    envExample: `# OpenCode API key
OPENCODE_API_KEY=`,
  },
];

export const listAgents = (): AgentEntry[] => AGENT_REGISTRY;

// ---------------------------------------------------------------------------
// Backlog manager registry (internal — not part of public API)
// ---------------------------------------------------------------------------

export interface BacklogManagerEntry {
  readonly name: string;
  readonly label: string;
  readonly templateArgs: {
    readonly LIST_TASKS_COMMAND: string;
    readonly VIEW_TASK_COMMAND: string;
    readonly CLOSE_TASK_COMMAND: string;
    readonly BACKLOG_MANAGER_TOOLS: string;
    readonly PREAMBLE: string;
    readonly PLAN_PREAMBLE: string;
    readonly IMPLEMENT_PREAMBLE: string;
    readonly MERGE_PREAMBLE: string;
  };
  /** Lines to append to `.env.example` for this backlog manager, or empty string if none needed. */
  readonly envExample: string;
}

const GITHUB_CLI_TOOLS = `# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
  && apt-get update && apt-get install -y gh \\
  && rm -rf /var/lib/apt/lists/*`;

const BEADS_TOOLS = `# Install system dependencies for Beads
RUN apt-get update && apt-get install -y \\
  dpkg-dev \\
  libicu72 \\
  && rm -rf /var/lib/apt/lists/* \\
  && ARCH_DIR=$(dpkg-architecture -qDEB_HOST_MULTIARCH) \\
  && for lib in /usr/lib/$ARCH_DIR/libicu*.so.72; do \\
       ln -s "$lib" "\${lib%.72}.74"; \\
     done

RUN curl -fsSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash

RUN corepack enable`;

// ---------------------------------------------------------------------------
// JIRA backlog manager — vendored overlay over netresearch/jira-skill v3.10.1.
// Constants are hardcoded for the VGD project per VGD-126; credentials are
// env-driven (JIRA_URL / JIRA_EMAIL / JIRA_API_TOKEN).
// ---------------------------------------------------------------------------

const JIRA_PLUGIN_TAG = "v3.10.1";
const JIRA_PLUGIN_PATH = "/opt/jira-plugin";
const JIRA_PLUGIN_SCRIPTS = `${JIRA_PLUGIN_PATH}/skills/jira-communication/scripts`;

const JIRA_TOOLS = `# Install Python 3 + uv (the plugin's scripts use uv-run shebangs)
RUN apt-get update && apt-get install -y python3 python3-pip ca-certificates \\
  && rm -rf /var/lib/apt/lists/*
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \\
  && mv /root/.local/bin/uv /usr/local/bin/uv \\
  && mv /root/.local/bin/uvx /usr/local/bin/uvx

# Clone the netresearch/jira-skill plugin at the pinned tag
RUN git clone --branch ${JIRA_PLUGIN_TAG} --depth 1 \\
  https://github.com/netresearch/jira-skill.git ${JIRA_PLUGIN_PATH}

# Overlay our patched files (atlassian-python-api v4 / enhanced_jql) plus jira-pickup.
# Build context is .sandcastle/ (see DockerLifecycle.buildImage), so paths are relative to it.
COPY _vendor/jira-plugin-3.10.1/skills/jira-communication/scripts/core/jira-search.py \\
  ${JIRA_PLUGIN_SCRIPTS}/core/jira-search.py
COPY _vendor/jira-plugin-3.10.1/skills/jira-communication/scripts/core/jira-pickup \\
  ${JIRA_PLUGIN_SCRIPTS}/core/jira-pickup
COPY _vendor/jira-plugin-3.10.1/skills/jira-communication/scripts/core/jira_pickup_lib.py \\
  ${JIRA_PLUGIN_SCRIPTS}/core/jira_pickup_lib.py
COPY _vendor/jira-plugin-3.10.1/skills/jira-communication/scripts/utility/jira-worklog-query.py \\
  ${JIRA_PLUGIN_SCRIPTS}/utility/jira-worklog-query.py
RUN chmod +x ${JIRA_PLUGIN_SCRIPTS}/core/jira-pickup \\
  ${JIRA_PLUGIN_SCRIPTS}/core/jira-search.py \\
  ${JIRA_PLUGIN_SCRIPTS}/core/jira-issue.py \\
  ${JIRA_PLUGIN_SCRIPTS}/workflow/jira-transition.py

# Put the plugin's scripts on PATH
ENV PATH="${JIRA_PLUGIN_SCRIPTS}/core:${JIRA_PLUGIN_SCRIPTS}/utility:${JIRA_PLUGIN_SCRIPTS}/workflow:$PATH"`;

// Preamble texts — see VGD-126 for the operational contract these encode.
const JIRA_SINGLE_STAGE_PREAMBLE = `## JIRA pickup discipline (single-stage loop)

Before doing anything else with this ticket:

1. Run \`jira-transition.py <ID> 2\` (Start work) to claim the ticket.
2. Self-assign with \`jira-issue.py update <ID> --assignee \\$JIRA_EMAIL\`.

If either call fails because another agent already claimed the ticket
(409/contention), retry up to three times with exponential backoff, then
drop this ticket and pick the next one. Never edit a ticket you could not
successfully claim.`;

const JIRA_PLAN_PREAMBLE = `## JIRA pickup discipline (plan stage)

You are planning, not implementing. Read tickets with
\`jira-issue.py get <ID>\` to gather context, but **do not** transition or
self-assign anything during planning.

When you decide to dispatch a ticket for implementation, claim it
*atomically right before dispatch*: \`jira-transition.py <ID> 2\` followed by
\`jira-issue.py update <ID> --assignee \\$JIRA_EMAIL\`. If either step fails,
retry up to three times, then drop the ticket from this plan.`;

const JIRA_IMPLEMENT_PREAMBLE = `## JIRA pickup discipline (implement stage)

This ticket has already been claimed and assigned to you by the planner.
Do **not** re-run \`jira-transition.py ... 2\` and do **not** re-assign —
those calls will either fail or steal the ticket from another agent.

You may add comments via \`jira-comment.py\` to record progress; transitions
to other states are reserved for the merge / review stages.`;

const JIRA_MERGE_PREAMBLE = `## JIRA pickup discipline (merge stage)

You must not write to JIRA from this stage. Transitions, comments, and
assignment changes are forbidden here. The PR-open hook is responsible for
moving tickets to Submit-for-review when their PR opens; the merge stage
only merges branches and resolves conflicts.`;

const BACKLOG_MANAGER_REGISTRY: BacklogManagerEntry[] = [
  {
    name: "github-issues",
    label: "GitHub Issues",
    templateArgs: {
      LIST_TASKS_COMMAND: `gh issue list --state open --label Sandcastle --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`,
      VIEW_TASK_COMMAND: "gh issue view <ID>",
      CLOSE_TASK_COMMAND: `gh issue close <ID> --comment "Completed by Sandcastle"`,
      BACKLOG_MANAGER_TOOLS: GITHUB_CLI_TOOLS,
      PREAMBLE: "",
      PLAN_PREAMBLE: "",
      IMPLEMENT_PREAMBLE: "",
      MERGE_PREAMBLE: "",
    },
    envExample: `# GitHub personal access token
GH_TOKEN=`,
  },
  {
    name: "beads",
    label: "Beads",
    templateArgs: {
      LIST_TASKS_COMMAND: "bd ready --json",
      VIEW_TASK_COMMAND: "bd show <ID>",
      CLOSE_TASK_COMMAND: `bd close <ID> "Completed by Sandcastle"`,
      BACKLOG_MANAGER_TOOLS: BEADS_TOOLS,
      PREAMBLE: "",
      PLAN_PREAMBLE: "",
      IMPLEMENT_PREAMBLE: "",
      MERGE_PREAMBLE: "",
    },
    envExample: "",
  },
  {
    name: "jira",
    label: "JIRA",
    templateArgs: {
      LIST_TASKS_COMMAND: "jira-pickup",
      VIEW_TASK_COMMAND: "jira-issue.py get <ID>",
      // Submit-for-review transition (id 3) — the PR-open hook handles
      // status changes once a PR exists, but this keeps backward compat
      // with stock template prompts that always close their task.
      CLOSE_TASK_COMMAND: "jira-transition.py <ID> 3",
      BACKLOG_MANAGER_TOOLS: JIRA_TOOLS,
      PREAMBLE: JIRA_SINGLE_STAGE_PREAMBLE,
      PLAN_PREAMBLE: JIRA_PLAN_PREAMBLE,
      IMPLEMENT_PREAMBLE: JIRA_IMPLEMENT_PREAMBLE,
      MERGE_PREAMBLE: JIRA_MERGE_PREAMBLE,
    },
    envExample: `# JIRA Cloud base URL (https://<your-tenant>.atlassian.net)
JIRA_URL=
# JIRA account email (used for self-assignment)
JIRA_EMAIL=
# JIRA API token (https://id.atlassian.com/manage-profile/security/api-tokens)
JIRA_API_TOKEN=`,
  },
];

export const listBacklogManagers = (): BacklogManagerEntry[] =>
  BACKLOG_MANAGER_REGISTRY;

export const getBacklogManager = (
  name: string,
): BacklogManagerEntry | undefined =>
  BACKLOG_MANAGER_REGISTRY.find((b) => b.name === name);

export const getAgent = (name: string): AgentEntry | undefined =>
  AGENT_REGISTRY.find((a) => a.name === name);

// ---------------------------------------------------------------------------
// Sandbox provider registry (internal — not part of public API)
// ---------------------------------------------------------------------------

export interface SandboxProviderEntry {
  readonly name: string;
  readonly label: string;
  /** Filename written to .sandcastle/ (e.g. "Dockerfile" or "Containerfile") */
  readonly containerfileName: string;
  /** CLI namespace for build/remove commands (e.g. "docker" or "podman") */
  readonly cliNamespace: string;
}

const SANDBOX_PROVIDER_REGISTRY: SandboxProviderEntry[] = [
  {
    name: "docker",
    label: "Docker",
    containerfileName: "Dockerfile",
    cliNamespace: "docker",
  },
  {
    name: "podman",
    label: "Podman",
    containerfileName: "Containerfile",
    cliNamespace: "podman",
  },
];

export const listSandboxProviders = (): SandboxProviderEntry[] =>
  SANDBOX_PROVIDER_REGISTRY;

export const getSandboxProvider = (
  name: string,
): SandboxProviderEntry | undefined =>
  SANDBOX_PROVIDER_REGISTRY.find((p) => p.name === name);

// ---------------------------------------------------------------------------
// Next steps
// ---------------------------------------------------------------------------

export function getNextStepsLines(
  template: string,
  mainFilename: string,
): string[] {
  if (template === "blank") {
    return [
      "Next steps:",
      `1. Set the required env vars in .sandcastle/.env (see .sandcastle/.env.example)`,
      "   If you want to use your Claude subscription instead of an API key, see https://github.com/mattpocock/sandcastle/issues/191",
      "2. Read and customize .sandcastle/prompt.md to describe what you want the agent to do",
      `3. Customize .sandcastle/${mainFilename} — it uses the JS API (\`run()\`) to control how the agent runs`,
      `4. Add "sandcastle": "npx tsx .sandcastle/${mainFilename}" to your package.json scripts`,
      "5. Run `npm run sandcastle` to start the agent",
    ];
  } else {
    const hasReviewer = template.includes("review");
    let step = 1;
    const lines: string[] = [
      "Next steps:",
      `${step++}. Set the required env vars in .sandcastle/.env (see .sandcastle/.env.example)`,
      "   If you want to use your Claude subscription instead of an API key, see https://github.com/mattpocock/sandcastle/issues/191",
      `${step++}. Add "sandcastle": "npx tsx .sandcastle/${mainFilename}" to your package.json scripts`,
      `${step++}. Templates use \`copyToWorktree: ["node_modules"]\` to copy your host node_modules into the sandbox for fast startup — the \`npm install\` in the onSandboxReady hook is a safety net for platform-specific binaries. Adjust both if you use a different package manager`,
      `${step++}. Read and customize the prompt files in .sandcastle/ — they shape what the agent does`,
    ];
    if (hasReviewer) {
      lines.push(
        `${step++}. Customize .sandcastle/CODING_STANDARDS.md with your project's standards — the reviewer agent loads it during review`,
      );
    }
    lines.push(`${step++}. Run \`npm run sandcastle\` to start the agent`);
    return lines;
  }
}

// ---------------------------------------------------------------------------
// Scaffolding helpers
// ---------------------------------------------------------------------------

function getTemplatesDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "templates");
}

const getTemplateDir = (
  templateName: string,
): Effect.Effect<string, Error, never> =>
  Effect.gen(function* () {
    const template = TEMPLATES.find((t) => t.name === templateName);
    if (!template) {
      const names = TEMPLATES.map((t) => t.name).join(", ");
      yield* Effect.fail(
        new Error(`Unknown template: "${templateName}". Available: ${names}`),
      );
    }
    return join(getTemplatesDir(), templateName);
  });

const COMPILED_FILE_EXTENSIONS = [
  ".js",
  ".js.map",
  ".d.ts",
  ".d.ts.map",
  ".mjs",
  ".mjs.map",
  ".d.mts",
  ".d.mts.map",
];

const copyTemplateFiles = (
  templateDir: string,
  destDir: string,
  mainFilename: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(templateDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    yield* Effect.all(
      files
        .filter(
          (f) =>
            f !== "template.json" &&
            f !== ".env.example" &&
            !COMPILED_FILE_EXTENSIONS.some((ext) => f.endsWith(ext)),
        )
        .map((f) => {
          const destName = f === "main.mts" ? mainFilename : f;
          return fs
            .copyFile(join(templateDir, f), join(destDir, destName))
            .pipe(Effect.mapError((e) => new Error(e.message)));
        }),
      { concurrency: "unbounded" },
    );
  });

// Dev-only artifacts that may appear in vendored Python trees; the sandcastle
// workstation runs `uv run pytest` against the vendor dir to keep `jira-pickup`
// honest, which leaves a .venv/.pytest_cache behind. Skipping them at scaffold
// time keeps users' .sandcastle/ directories small and reproducible.
const VENDOR_COPY_SKIP = new Set([
  ".venv",
  ".pytest_cache",
  "__pycache__",
  "uv.lock",
]);

const copyDirectoryRecursive = (
  src: string,
  dest: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .makeDirectory(dest, { recursive: true })
      .pipe(Effect.mapError((e) => new Error(e.message)));
    const entries = yield* fs
      .readDirectory(src)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    yield* Effect.all(
      entries
        .filter((entry) => !VENDOR_COPY_SKIP.has(entry))
        .map((entry) =>
          Effect.gen(function* () {
            const srcPath = join(src, entry);
            const destPath = join(dest, entry);
            const stat = yield* fs
              .stat(srcPath)
              .pipe(Effect.mapError((e) => new Error(e.message)));
            if (stat.type === "Directory") {
              yield* copyDirectoryRecursive(srcPath, destPath);
            } else {
              yield* fs
                .copyFile(srcPath, destPath)
                .pipe(Effect.mapError((e) => new Error(e.message)));
            }
          }),
        ),
      { concurrency: "unbounded" },
    );
  });

/**
 * Replace the agent factory import and call in a scaffolded main.ts.
 *
 * Templates use `claudeCode` as the default factory. When a different agent or
 * model is selected, this function rewrites the import and factory calls.
 */
const rewriteMainTs = (
  configDir: string,
  agent: AgentEntry,
  model: string,
  mainFilename: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const mainTsPath = join(configDir, mainFilename);

    const exists = yield* fs
      .exists(mainTsPath)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    if (!exists) return;

    let content = yield* fs
      .readFileString(mainTsPath)
      .pipe(Effect.mapError((e) => new Error(e.message)));

    // Templates use main.mts as the canonical filename in comments.
    // When the target is main.ts, rewrite those references.
    if (mainFilename === "main.ts") {
      content = content.replace(/main\.mts/g, "main.ts");
    }

    // Replace factory function name in imports (e.g. claudeCode → pi)
    // and all factory calls with the correct model.
    // Templates always use claudeCode as the placeholder factory.
    content = content.replace(/\bclaudeCode\b/g, agent.factoryImport);
    // Replace model strings in factory calls: factoryImport("any-model")
    const factoryCallRe = new RegExp(
      `${agent.factoryImport}\\(["']([^"']+)["']\\)`,
      "g",
    );
    content = content.replace(
      factoryCallRe,
      `${agent.factoryImport}("${model}")`,
    );

    yield* fs
      .writeFileString(mainTsPath, content)
      .pipe(Effect.mapError((e) => new Error(e.message)));
  });

/**
 * When the user opted out of the Sandcastle label, strip ` --label Sandcastle`
 * from all `.md` files in the scaffolded config directory so that `gh issue list`
 * commands work without a label filter.
 */
const rewritePromptFiles = (
  configDir: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(configDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    yield* Effect.all(
      mdFiles.map((f) =>
        Effect.gen(function* () {
          const filePath = join(configDir, f);
          const content = yield* fs
            .readFileString(filePath)
            .pipe(Effect.mapError((e) => new Error(e.message)));
          const updated = content.replace(/ --label Sandcastle/g, "");
          if (updated !== content) {
            yield* fs
              .writeFileString(filePath, updated)
              .pipe(Effect.mapError((e) => new Error(e.message)));
          }
        }),
      ),
      { concurrency: "unbounded" },
    );
  });

/** Text file extensions eligible for `{{KEY}}` template argument substitution. */
const TEXT_FILE_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".env",
  ".example",
  // Dockerfile / Containerfile have no extension — handled by name check below
]);

const isTextFile = (filename: string): boolean => {
  if (
    filename === "Dockerfile" ||
    filename === "Containerfile" ||
    filename === ".gitignore"
  )
    return true;
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx === -1) return false;
  return TEXT_FILE_EXTENSIONS.has(filename.slice(dotIdx));
};

/**
 * Replace `{{KEY}}` template arguments from the backlog manager's
 * `templateArgs` map in all text files in the scaffolded config directory.
 */
const substituteTemplateArgs = (
  configDir: string,
  backlogManager: BacklogManagerEntry,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(configDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    const textFiles = files.filter(isTextFile);
    yield* Effect.all(
      textFiles.map((f) =>
        Effect.gen(function* () {
          const filePath = join(configDir, f);
          let content = yield* fs
            .readFileString(filePath)
            .pipe(Effect.mapError((e) => new Error(e.message)));
          const original = content;
          for (const [key, value] of Object.entries(
            backlogManager.templateArgs,
          )) {
            content = content.replace(
              new RegExp(`\\{\\{${key}\\}\\}`, "g"),
              value,
            );
          }
          if (content !== original) {
            yield* fs
              .writeFileString(filePath, content)
              .pipe(Effect.mapError((e) => new Error(e.message)));
          }
        }),
      ),
      { concurrency: "unbounded" },
    );
  });

// ---------------------------------------------------------------------------
// Main scaffold function
// ---------------------------------------------------------------------------

export interface ScaffoldOptions {
  agent: AgentEntry;
  model: string;
  templateName?: string;
  createLabel?: boolean;
  backlogManager?: BacklogManagerEntry;
  sandboxProvider?: SandboxProviderEntry;
}

export interface ScaffoldResult {
  mainFilename: string;
}

/**
 * Detect whether the project's package.json has `"type": "module"`.
 * If so, we can use plain `.ts`; otherwise we use `.mts` to ensure ESM.
 */
const detectMainFilename = (
  repoDir: string,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pkgPath = join(repoDir, "package.json");
    const exists = yield* fs
      .exists(pkgPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) return "main.mts";
    const content = yield* fs
      .readFileString(pkgPath)
      .pipe(Effect.orElseSucceed(() => ""));
    try {
      const pkg = JSON.parse(content) as Record<string, unknown>;
      return pkg["type"] === "module" ? "main.ts" : "main.mts";
    } catch {
      return "main.mts";
    }
  });

export const scaffold = (
  repoDir: string,
  options: ScaffoldOptions,
): Effect.Effect<ScaffoldResult, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const {
      agent,
      model,
      templateName = "blank",
      createLabel = true,
      backlogManager = BACKLOG_MANAGER_REGISTRY[0]!, // default: github-issues
      sandboxProvider = SANDBOX_PROVIDER_REGISTRY[0]!, // default: docker
    } = options;
    const fs = yield* FileSystem.FileSystem;
    const configDir = join(repoDir, ".sandcastle");

    const exists = yield* fs
      .exists(configDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    if (exists) {
      yield* Effect.fail(
        new Error(
          ".sandcastle/ directory already exists. Remove it first if you want to re-initialize.",
        ),
      );
    }

    const mainFilename = yield* detectMainFilename(repoDir);

    yield* fs
      .makeDirectory(configDir, { recursive: false })
      .pipe(Effect.mapError((e) => new Error(e.message)));

    const templateDir = yield* getTemplateDir(templateName);

    // Build .env.example from agent + backlog manager env blocks
    const envExampleParts = [agent.envExample];
    if (backlogManager.envExample) {
      envExampleParts.push(backlogManager.envExample);
    }
    const envExampleContent = envExampleParts.join("\n") + "\n";

    yield* Effect.all(
      [
        fs
          .writeFileString(
            join(configDir, sandboxProvider.containerfileName),
            agent.dockerfileTemplate,
          )
          .pipe(Effect.mapError((e) => new Error(e.message))),
        fs
          .writeFileString(join(configDir, ".gitignore"), GITIGNORE)
          .pipe(Effect.mapError((e) => new Error(e.message))),
        fs
          .writeFileString(join(configDir, ".env.example"), envExampleContent)
          .pipe(Effect.mapError((e) => new Error(e.message))),
        copyTemplateFiles(templateDir, configDir, mainFilename),
      ],
      { concurrency: "unbounded" },
    );

    // Rewrite main file with the selected agent factory and model
    yield* rewriteMainTs(configDir, agent, model, mainFilename);

    // For backlog managers that ship with vendored runtime files (e.g. jira),
    // copy the tree into .sandcastle/_vendor/ so the Dockerfile's COPY paths
    // resolve at build time (build context is .sandcastle/, see DockerLifecycle).
    if (backlogManager.name === "jira") {
      const vendorSrc = join(
        getTemplatesDir(),
        "_vendor",
        "jira-plugin-3.10.1",
      );
      const vendorDest = join(configDir, "_vendor", "jira-plugin-3.10.1");
      yield* copyDirectoryRecursive(vendorSrc, vendorDest);
    }

    // Replace backlog manager template arguments in all text files (must run before label stripping)
    yield* substituteTemplateArgs(configDir, backlogManager);

    // Strip --label Sandcastle from prompt files when the user declined label creation
    if (!createLabel) {
      yield* rewritePromptFiles(configDir);
    }

    return { mainFilename };
  });
