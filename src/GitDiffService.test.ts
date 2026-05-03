import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createGitDiffService } from "./GitDiffService.js";

const run = (cmd: string, args: string[], cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString() || err.message));
      else resolve(stdout.toString());
    });
  });

const initRepo = async (dir: string): Promise<void> => {
  await run("git", ["init", "-b", "main", "--quiet"], dir);
  await run("git", ["config", "user.email", "ci@example.com"], dir);
  await run("git", ["config", "user.name", "ci"], dir);
  await run("git", ["config", "commit.gpgsign", "false"], dir);
};

const commitFile = async (
  dir: string,
  path: string,
  contents: string,
  msg: string,
): Promise<string> => {
  const full = join(dir, path);
  // Create parent dirs if needed.
  const parent = full.slice(0, full.lastIndexOf("/"));
  if (parent && parent !== dir) {
    await mkdir(parent, { recursive: true });
  }
  await writeFile(full, contents);
  await run("git", ["add", "--", path], dir);
  await run("git", ["commit", "-m", msg, "--quiet"], dir);
  const head = (await run("git", ["rev-parse", "HEAD"], dir)).trim();
  return head;
};

const removeFile = async (
  dir: string,
  path: string,
  msg: string,
): Promise<string> => {
  await run("git", ["rm", "--", path], dir);
  await run("git", ["commit", "-m", msg, "--quiet"], dir);
  return (await run("git", ["rev-parse", "HEAD"], dir)).trim();
};

describe("GitDiffService", () => {
  let repoDir: string;
  let workDir: string;
  let initialSha: string;
  let secondSha: string;
  let renameSha: string;
  let deleteSha: string;
  let worktreeSha: string;

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "gds-"));
    await initRepo(repoDir);

    initialSha = await commitFile(
      repoDir,
      "hello.ts",
      "export const hello = 'world';\n",
      "feat: add hello",
    );

    secondSha = await commitFile(
      repoDir,
      "hello.ts",
      "export const hello = 'world';\nexport const goodbye = 'moon';\n",
      "feat: add goodbye",
    );

    // Rename: move hello.ts → src/hello.ts
    await run("git", ["mv", "hello.ts", "renamed.ts"], repoDir);
    await run(
      "git",
      ["commit", "-m", "refactor: rename hello", "--quiet"],
      repoDir,
    );
    renameSha = (await run("git", ["rev-parse", "HEAD"], repoDir)).trim();

    // Delete the renamed file in another commit.
    deleteSha = await removeFile(repoDir, "renamed.ts", "chore: drop renamed");

    // Spin up a worktree on a new branch and commit there to prove the
    // service can resolve commits from any worktree of the same repo.
    workDir = join(await mkdtemp(join(tmpdir(), "gds-wt-")), "wt");
    await run(
      "git",
      ["worktree", "add", "-b", "feature/x", workDir, "main"],
      repoDir,
    );
    worktreeSha = await commitFile(
      workDir,
      "from-worktree.txt",
      "made in worktree\n",
      "feat: from worktree",
    );
  });

  afterAll(async () => {
    if (workDir) {
      await run(
        "git",
        ["worktree", "remove", "--force", workDir],
        repoDir,
      ).catch(() => undefined);
    }
    if (repoDir) await rm(repoDir, { recursive: true, force: true });
  });

  it("hasCommit returns true for known commits and false otherwise", async () => {
    const svc = createGitDiffService({ repoDir });
    expect(await svc.hasCommit(initialSha)).toBe(true);
    expect(await svc.hasCommit("0".repeat(40))).toBe(false);
    expect(await svc.hasCommit("not-a-sha")).toBe(false);
  });

  it("getCommit returns header + numstat + name-status for a normal commit", async () => {
    const svc = createGitDiffService({ repoDir });
    const meta = await svc.getCommit(secondSha);
    expect(meta.sha).toBe(secondSha);
    expect(meta.subject).toBe("feat: add goodbye");
    expect(meta.parentSha).toBe(initialSha);
    expect(meta.authorTime).toBeGreaterThan(0);
    expect(meta.files).toHaveLength(1);
    const [f] = meta.files;
    expect(f).toBeDefined();
    expect(f!.path).toBe("hello.ts");
    expect(f!.status).toBe("M");
    expect(f!.insertions).toBe(1);
    expect(f!.deletions).toBe(0);
  });

  it("getCommit detects renames (status R, oldPath populated)", async () => {
    const svc = createGitDiffService({ repoDir });
    const meta = await svc.getCommit(renameSha);
    const renamed = meta.files.find((f) => f.path === "renamed.ts");
    expect(renamed).toBeDefined();
    expect(renamed!.status).toBe("R");
    expect(renamed!.oldPath).toBe("hello.ts");
  });

  it("getCommit reports deletions (status D)", async () => {
    const svc = createGitDiffService({ repoDir });
    const meta = await svc.getCommit(deleteSha);
    expect(meta.files).toHaveLength(1);
    expect(meta.files[0]!.path).toBe("renamed.ts");
    expect(meta.files[0]!.status).toBe("D");
  });

  it("resolves commits made in a sibling worktree (shared object DB)", async () => {
    const svc = createGitDiffService({ repoDir });
    const meta = await svc.getCommit(worktreeSha);
    expect(meta.subject).toBe("feat: from worktree");
    expect(meta.files).toHaveLength(1);
    expect(meta.files[0]!.path).toBe("from-worktree.txt");
    expect(meta.files[0]!.status).toBe("A");
  });

  it("getFileDiff returns unified diff text + counts + status", async () => {
    const svc = createGitDiffService({ repoDir });
    const diff = await svc.getFileDiff(secondSha, "hello.ts");
    expect(diff.path).toBe("hello.ts");
    expect(diff.status).toBe("M");
    expect(diff.insertions).toBe(1);
    expect(diff.deletions).toBe(0);
    expect(diff.diff).toContain("--- a/hello.ts");
    expect(diff.diff).toContain("+++ b/hello.ts");
    expect(diff.diff).toContain("+export const goodbye");
  });

  it("getFileDiff rejects invalid sha and option-style paths", async () => {
    const svc = createGitDiffService({ repoDir });
    await expect(svc.getFileDiff("not-a-sha", "hello.ts")).rejects.toThrow(
      /invalid sha/,
    );
    await expect(svc.getFileDiff(secondSha, "--upload-pack")).rejects.toThrow(
      /invalid path/,
    );
  });

  it("getCommit throws for unknown sha", async () => {
    const svc = createGitDiffService({ repoDir });
    await expect(svc.getCommit("0".repeat(40))).rejects.toThrow();
  });
});
