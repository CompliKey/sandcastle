import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createConfigWatcher,
  type ConfigChange,
  type ConfigWatcher,
} from "./ConfigWatcher.js";

const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Poll for a condition with a generous-but-bounded timeout. fs.watch
 * notifications are inherently async; CI can be slow. */
const eventually = async (
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Condition not met within ${timeoutMs}ms`);
    }
    await wait(20);
  }
};

describe("ConfigWatcher", () => {
  let dir: string;
  let watcher: ConfigWatcher | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "config-watcher-"));
  });

  afterEach(async () => {
    await watcher?.close();
    watcher = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("does not fire for files unchanged after start", async () => {
    const file = join(dir, "main.ts");
    await writeFile(file, "// initial");

    const changes: ConfigChange[] = [];
    watcher = await createConfigWatcher({
      files: [file],
      onChange: (c) => changes.push(c),
    });

    await wait(150); // give chokidar a beat
    expect(changes).toEqual([]);
  });

  it("fires onChange when a watched file is modified after start", async () => {
    const file = join(dir, "main.ts");
    await writeFile(file, "// v1");

    const changes: ConfigChange[] = [];
    watcher = await createConfigWatcher({
      files: [file],
      onChange: (c) => changes.push(c),
    });

    await wait(50);
    await writeFile(file, "// v2");

    await eventually(() => changes.length >= 1);
    expect(changes[0]?.path).toBe(file);
    expect(typeof changes[0]?.changedAt).toBe("number");
  });

  it("does not fire when a file is rewritten with identical content", async () => {
    const file = join(dir, "main.ts");
    await writeFile(file, "// stable");

    const changes: ConfigChange[] = [];
    watcher = await createConfigWatcher({
      files: [file],
      onChange: (c) => changes.push(c),
    });

    await wait(50);
    // Touch with the same content — chokidar will see an fs event, but
    // the content hash is unchanged so we suppress.
    await writeFile(file, "// stable");

    await wait(200);
    expect(changes).toEqual([]);
  });

  it("tracks changed-files state and exposes it via getChangedFiles", async () => {
    const a = join(dir, "main.ts");
    const b = join(dir, "prompt.md");
    await writeFile(a, "// a");
    await writeFile(b, "p1");

    watcher = await createConfigWatcher({
      files: [a, b],
      onChange: () => {},
    });
    expect(watcher.getChangedFiles()).toEqual([]);

    await wait(50);
    await writeFile(b, "p2");
    await eventually(() => watcher!.getChangedFiles().length === 1);

    const changed = watcher.getChangedFiles();
    expect(changed.map((c) => c.path)).toEqual([b]);
  });

  it("supports multiple subscribers", async () => {
    const file = join(dir, "main.ts");
    await writeFile(file, "// v1");

    watcher = await createConfigWatcher({ files: [file], onChange: () => {} });

    const a: ConfigChange[] = [];
    const b: ConfigChange[] = [];
    const unsubA = watcher.subscribe((c) => a.push(c));
    watcher.subscribe((c) => b.push(c));

    await wait(50);
    await writeFile(file, "// v2");
    await eventually(() => a.length >= 1 && b.length >= 1);

    unsubA();
    await writeFile(file, "// v3");
    await eventually(() => b.length >= 2);
    expect(a.length).toBe(1);
    expect(b.length).toBe(2);
  });

  it("isolates a misbehaving subscriber from others via onError", async () => {
    const file = join(dir, "main.ts");
    await writeFile(file, "// v1");

    const errors: unknown[] = [];
    watcher = await createConfigWatcher({
      files: [file],
      onChange: () => {},
      onSubscriberError: (e) => errors.push(e),
    });

    const good: ConfigChange[] = [];
    watcher.subscribe(() => {
      throw new Error("boom");
    });
    watcher.subscribe((c) => good.push(c));

    await wait(50);
    await writeFile(file, "// v2");
    await eventually(() => good.length >= 1);
    expect(errors.length).toBe(1);
  });

  it("survives missing initial files (e.g. .mts variant absent) without throwing", async () => {
    const main = join(dir, "main.ts");
    const mts = join(dir, "main.mts");
    await writeFile(main, "// real");
    // mts is intentionally missing.

    watcher = await createConfigWatcher({
      files: [main, mts],
      onChange: () => {},
    });
    expect(watcher.getChangedFiles()).toEqual([]);
  });

  it("fires onChange when a previously-missing file is created", async () => {
    const main = join(dir, "main.ts");
    const mts = join(dir, "main.mts");
    await writeFile(main, "// real");

    const changes: ConfigChange[] = [];
    watcher = await createConfigWatcher({
      files: [main, mts],
      onChange: (c) => changes.push(c),
    });

    await wait(50);
    await writeFile(mts, "// added later");
    await eventually(() => changes.length >= 1);
    expect(changes[0]?.path).toBe(mts);
  });

  it("close() stops further notifications", async () => {
    const file = join(dir, "main.ts");
    await writeFile(file, "// v1");

    const changes: ConfigChange[] = [];
    watcher = await createConfigWatcher({
      files: [file],
      onChange: (c) => changes.push(c),
    });

    await wait(50);
    await watcher.close();
    watcher = undefined;

    await writeFile(file, "// v2");
    await wait(150);
    expect(changes).toEqual([]);
  });

  it("uses an injectable clock for changedAt timestamps", async () => {
    const file = join(dir, "main.ts");
    await writeFile(file, "// v1");

    const now = vi.fn(() => 42);
    const changes: ConfigChange[] = [];
    watcher = await createConfigWatcher({
      files: [file],
      onChange: (c) => changes.push(c),
      now,
    });

    await wait(50);
    await writeFile(file, "// v2");
    await eventually(() => changes.length >= 1);
    expect(changes[0]?.changedAt).toBe(42);
  });
});
