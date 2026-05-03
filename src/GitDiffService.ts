/**
 * GitDiffService — thin, stateless wrapper over the `git` CLI rooted at a
 * single repository path. Used by the UI server to surface per-commit metadata
 * and per-file diffs for sessions produced by sandcastle.
 *
 * Branch-strategy-agnostic by construction: git's shared object database
 * (objects under the main repo's `.git/`, with `git worktree add` linking new
 * worktrees back to it) means the main repo can resolve commits made in any
 * worktree of the same repo. Callers therefore wire one service rooted at the
 * host repo, regardless of whether sessions used `head`, `merge-to-head`, or
 * `branch` strategies.
 *
 * No caching here — the consumer (the HTTP layer) owns lifetime and any
 * caching policy. The service is purely a typed projection of `git show` /
 * `git show --numstat` over `child_process.execFile` (no shell).
 */

import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FileChangeStatus =
  | "A" // added
  | "M" // modified
  | "D" // deleted
  | "R" // renamed
  | "C" // copied
  | "T" // type changed
  | "U" // unmerged
  | "X"; // unknown

export interface CommitFileChange {
  readonly path: string;
  /** For renames/copies, the source path; otherwise undefined. */
  readonly oldPath?: string;
  readonly status: FileChangeStatus;
  /** `undefined` for binary files (numstat reports `-`). */
  readonly insertions?: number;
  readonly deletions?: number;
}

export interface CommitMetadata {
  readonly sha: string;
  readonly parentSha?: string;
  readonly subject: string;
  readonly authorName: string;
  readonly authorEmail: string;
  /** Author time in ms since epoch. */
  readonly authorTime: number;
  readonly files: readonly CommitFileChange[];
}

export interface FileDiff {
  readonly path: string;
  /** Unified-diff text from `git show <sha> -- <path>` (header included). */
  readonly diff: string;
  readonly insertions?: number;
  readonly deletions?: number;
  readonly status: FileChangeStatus;
}

export interface GitDiffService {
  /** Throws when `sha` does not resolve in the repo. */
  getCommit(sha: string): Promise<CommitMetadata>;
  /** Throws when `sha` does not resolve or `path` is not in the commit. */
  getFileDiff(sha: string, path: string): Promise<FileDiff>;
  /** True when `sha` resolves in the repo's object database. */
  hasCommit(sha: string): Promise<boolean>;
}

export type GitRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<string>;

export interface GitDiffServiceOptions {
  readonly repoDir: string;
  /** Override the git invoker — used by tests. */
  readonly _runGit?: GitRunner;
}

// ---------------------------------------------------------------------------
// Default git invoker — execFile (no shell) with stdout buffer cap.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

const defaultRunGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args as string[],
      { cwd, maxBuffer: DEFAULT_MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          const msg = stderr?.toString().trim() || error.message;
          reject(new Error(msg));
        } else {
          resolve(stdout);
        }
      },
    );
  });

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const SHA_RE = /^[0-9a-f]{4,64}$/;

/**
 * Reject anything that isn't a hex object id before passing to git, so a
 * URL-controlled value can't smuggle option-style args. `execFile` already
 * avoids shell parsing — this is defence in depth.
 */
const assertSha = (sha: string): void => {
  if (!SHA_RE.test(sha)) {
    throw new Error(`invalid sha: ${sha}`);
  }
};

const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";

/**
 * Format string for `git show -s --format=...`. We use ASCII record/field
 * separators rather than newlines so subjects containing newlines don't
 * confuse parsing.
 */
const COMMIT_FORMAT = [
  "%H", // full sha
  "%P", // parent sha(s), space-separated
  "%s", // subject
  "%an", // author name
  "%ae", // author email
  "%at", // author time, unix seconds
].join(FIELD_SEP);

export const createGitDiffService = (
  opts: GitDiffServiceOptions,
): GitDiffService => {
  const runGit = opts._runGit ?? defaultRunGit;
  const cwd = opts.repoDir;

  const run = (args: readonly string[]): Promise<string> => runGit(args, cwd);

  return {
    async hasCommit(sha) {
      if (!SHA_RE.test(sha)) return false;
      try {
        await run(["cat-file", "-e", `${sha}^{commit}`]);
        return true;
      } catch {
        return false;
      }
    },

    async getCommit(sha) {
      assertSha(sha);
      const headerRaw = await run([
        "show",
        "--no-color",
        "-s",
        `--format=${COMMIT_FORMAT}${RECORD_SEP}`,
        sha,
      ]);
      const header = parseCommitHeader(headerRaw);

      const filesRaw = await run([
        "show",
        "--no-color",
        "--numstat",
        "--format=",
        "-z",
        sha,
      ]);
      const files = parseNumstatZ(filesRaw);

      // `--numstat` gives counts but not status letters; merge in
      // `--name-status` so the UI can show A/M/D/R badges.
      const statusRaw = await run([
        "show",
        "--no-color",
        "--name-status",
        "--format=",
        "-z",
        sha,
      ]);
      const statusByPath = parseNameStatusZ(statusRaw);

      const merged: CommitFileChange[] = files.map((f) => {
        const s = statusByPath.get(f.path);
        return {
          ...f,
          status: s?.status ?? "X",
          oldPath: s?.oldPath,
        };
      });

      return { ...header, files: merged };
    },

    async getFileDiff(sha, path) {
      assertSha(sha);
      if (!path || path.startsWith("-")) {
        throw new Error(`invalid path: ${path}`);
      }

      const diff = await run([
        "show",
        "--no-color",
        "--format=",
        sha,
        "--",
        path,
      ]);

      const numstatRaw = await run([
        "show",
        "--no-color",
        "--numstat",
        "--format=",
        "-z",
        sha,
        "--",
        path,
      ]);
      const numstat = parseNumstatZ(numstatRaw)[0];

      const statusRaw = await run([
        "show",
        "--no-color",
        "--name-status",
        "--format=",
        "-z",
        sha,
        "--",
        path,
      ]);
      const status = parseNameStatusZ(statusRaw).get(path);

      return {
        path,
        diff,
        insertions: numstat?.insertions,
        deletions: numstat?.deletions,
        status: status?.status ?? "X",
      };
    },
  };
};

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

const parseCommitHeader = (stdout: string): Omit<CommitMetadata, "files"> => {
  const headerEnd = stdout.indexOf(RECORD_SEP);
  const header = headerEnd >= 0 ? stdout.slice(0, headerEnd) : stdout;
  const parts = header.split(FIELD_SEP);
  if (parts.length < 6) {
    throw new Error(`unexpected git show header: ${header}`);
  }
  const [sha, parents, subject, authorName, authorEmail, authorTimeRaw] =
    parts as [string, string, string, string, string, string];
  const parentSha = parents.split(" ").filter(Boolean)[0];
  const authorTimeSecs = Number.parseInt(authorTimeRaw, 10);
  return {
    sha,
    parentSha,
    subject,
    authorName,
    authorEmail,
    authorTime: Number.isFinite(authorTimeSecs) ? authorTimeSecs * 1000 : 0,
  };
};

/**
 * Parse `git show --numstat -z` output. Each entry is one of:
 *   - `<ins>\t<dels>\t<path>\0`            — normal file
 *   - `<ins>\t<dels>\t\0<old>\0<new>\0`    — rename/copy (empty path field
 *                                            triggers two trailing tokens)
 * Binary files report `-` for both counts.
 */
const parseNumstatZ = (
  raw: string,
): { path: string; insertions?: number; deletions?: number }[] => {
  const out: { path: string; insertions?: number; deletions?: number }[] = [];
  const tokens = raw.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t) {
      i++;
      continue;
    }
    const tabIdx = t.lastIndexOf("\t");
    if (tabIdx === -1) {
      i++;
      continue;
    }
    const counts = t.slice(0, tabIdx);
    const trailing = t.slice(tabIdx + 1);
    const [insRaw, delRaw] = counts.split("\t") as [string, string];
    const insertions = insRaw === "-" ? undefined : Number.parseInt(insRaw, 10);
    const deletions = delRaw === "-" ? undefined : Number.parseInt(delRaw, 10);

    if (trailing === "") {
      const newPath = tokens[i + 2];
      if (newPath) {
        out.push({ path: newPath, insertions, deletions });
      }
      i += 3;
      continue;
    }

    out.push({ path: trailing, insertions, deletions });
    i++;
  }
  return out;
};

/**
 * Parse `git show --name-status -z` output. Each entry is either:
 *   - `<status>\0<path>\0`                  — A / M / D / T / U
 *   - `<status><score>\0<old>\0<new>\0`     — R<score> / C<score>
 */
const parseNameStatusZ = (
  raw: string,
): Map<string, { status: FileChangeStatus; oldPath?: string }> => {
  const out = new Map<string, { status: FileChangeStatus; oldPath?: string }>();
  const tokens = raw.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t) {
      i++;
      continue;
    }
    const code = (t[0] ?? "X").toUpperCase();
    const status: FileChangeStatus = isStatus(code) ? code : "X";
    if (code === "R" || code === "C") {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (newPath) out.set(newPath, { status, oldPath });
      i += 3;
      continue;
    }
    const path = tokens[i + 1];
    if (path) out.set(path, { status });
    i += 2;
  }
  return out;
};

const isStatus = (s: string): s is FileChangeStatus =>
  s === "A" ||
  s === "M" ||
  s === "D" ||
  s === "R" ||
  s === "C" ||
  s === "T" ||
  s === "U" ||
  s === "X";
