/**
 * UiLockfile — advisory single-instance hint for `sandcastle ui`.
 *
 * The file lives at `<stateDir>/ui.lock` and stores `{ pid, port, host, url,
 * startedAt }`. It is *not* an OS lock — concurrency is decided by the
 * actual `bind()` call. The lockfile only tells a starting process where
 * the *previous* server claimed to be, so it can probe `/api/health` to
 * confirm and hand off without needing to scan ports.
 *
 * The lock is best-effort: it is written after a successful bind and removed
 * on graceful shutdown. Stale lockfiles are tolerated — the probe step in
 * {@link ../UiServer.probeExistingServer} is the trust boundary.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { UI_LOCKFILE_NAME } from "./UiServer.js";

export interface UiLockfileContents {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly startedAt: number;
}

export const lockfilePathFor = (stateDir: string): string =>
  join(stateDir, UI_LOCKFILE_NAME);

export const writeLockfile = async (
  stateDir: string,
  contents: UiLockfileContents,
): Promise<void> => {
  const path = lockfilePathFor(stateDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
};

export const readLockfile = async (
  stateDir: string,
): Promise<UiLockfileContents | null> => {
  const path = lockfilePathFor(stateDir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).pid !== "number" ||
    typeof (parsed as Record<string, unknown>).port !== "number" ||
    typeof (parsed as Record<string, unknown>).host !== "string" ||
    typeof (parsed as Record<string, unknown>).url !== "string" ||
    typeof (parsed as Record<string, unknown>).startedAt !== "number"
  ) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  return {
    pid: record.pid as number,
    port: record.port as number,
    host: record.host as string,
    url: record.url as string,
    startedAt: record.startedAt as number,
  };
};

export const removeLockfile = async (stateDir: string): Promise<void> => {
  await rm(lockfilePathFor(stateDir), { force: true });
};
