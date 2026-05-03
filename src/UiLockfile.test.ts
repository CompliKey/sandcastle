import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  lockfilePathFor,
  readLockfile,
  removeLockfile,
  writeLockfile,
} from "./UiLockfile.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sandcastle-uilock-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("UiLockfile", () => {
  it("round-trips a contents object", async () => {
    const c = {
      pid: 1234,
      host: "127.0.0.1",
      port: 4321,
      url: "http://127.0.0.1:4321",
      startedAt: 100,
    };
    await writeLockfile(dir, c);
    expect(await readLockfile(dir)).toEqual(c);
  });

  it("returns null when the file is missing", async () => {
    expect(await readLockfile(dir)).toBeNull();
  });

  it("returns null when the file is malformed", async () => {
    await writeFile(lockfilePathFor(dir), "not json", "utf8");
    expect(await readLockfile(dir)).toBeNull();
  });

  it("returns null when required fields are missing", async () => {
    await writeFile(
      lockfilePathFor(dir),
      JSON.stringify({ pid: 1, port: 80 }),
      "utf8",
    );
    expect(await readLockfile(dir)).toBeNull();
  });

  it("removeLockfile is idempotent", async () => {
    await removeLockfile(dir);
    await removeLockfile(dir);
  });

  it("creates the parent directory on write", async () => {
    const nested = join(dir, "deep", "state");
    await writeLockfile(nested, {
      pid: 1,
      host: "h",
      port: 1,
      url: "http://h:1",
      startedAt: 1,
    });
    expect(await readLockfile(nested)).not.toBeNull();
  });
});
