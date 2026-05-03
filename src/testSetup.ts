/**
 * Per-worker git config isolation.
 *
 * Vitest runs test files in parallel across forked worker processes.
 * Multiple tests call `git config --global` (e.g. to add safe.directory),
 * which writes to the file at GIT_CONFIG_GLOBAL. When all workers share a
 * single file, concurrent writes race on `.gitconfig.lock` and cause
 * intermittent "could not lock config file" failures.
 *
 * This setup file runs inside each worker process (via vitest `setupFiles`),
 * giving every worker its own gitconfig file and eliminating cross-worker
 * lock contention.
 *
 * The file is seeded with a default `user.name` / `user.email` so any test
 * that runs `git commit` inside the worker — including tests that bypass
 * `SandboxLifecycle` (e.g. `syncOut.test.ts` constructs a sandbox handle
 * directly) — has an author identity to commit with. Tests that need a
 * specific author still set repo-local `user.email` / `user.name` and that
 * takes precedence over the seeded global.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "test-gitconfig-worker-"));
const globalConfigPath = join(tmpDir, ".gitconfig");
writeFileSync(
  globalConfigPath,
  `[user]\n\tname = Sandcastle Test Worker\n\temail = test-worker@sandcastle.local\n`,
);
process.env.GIT_CONFIG_GLOBAL = globalConfigPath;

process.on("exit", () => {
  try {
    rmSync(tmpDir, { recursive: true });
  } catch {
    // best-effort cleanup
  }
});
