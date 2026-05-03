/**
 * ConfigWatcher — passive notice that a watched file has changed since
 * the watcher was created.
 *
 * The orchestration loop is intentionally _not_ told. Sandcastle does not
 * hot-reload, does not restart the running session, does not invalidate any
 * in-flight work. The watcher exists so the UI can surface a "config changed
 * since this run started" badge and let the operator decide whether to
 * retry. Pure passive notice — no side-effects on the running session.
 *
 * Mechanics
 * - At construction we record an initial mtime and a SHA-256 content hash
 *   for each file. Files that don't exist yet record a "missing" sentinel.
 * - chokidar watches each path. On `add` / `change` we re-read the file,
 *   compare against the recorded baseline, and fire `onChange` only if the
 *   content actually differs. This suppresses spurious events from editors
 *   that touch mtime without changing bytes.
 * - Once a file has been reported as changed it stays in the changed set
 *   for the lifetime of the watcher — reverting the file does NOT clear the
 *   badge. The semantic claim is "the running session was started under
 *   different config than is on disk now", and a revert can't unmake that.
 *
 * No EventStore involvement: config-changed is a transient host-level
 * signal with no `sessionId` / `laneId`, so it would not fit
 * `SandcastleEvent`. Subscribers (the UI server WS handler, tests) drive
 * delivery via the broadcaster-style {@link ConfigWatcher.subscribe} API.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import chokidar, { type FSWatcher } from "chokidar";

export interface ConfigChange {
  /** Absolute path to the changed file. */
  readonly path: string;
  /** Wall-clock change time (ms since epoch). Comes from the injected clock. */
  readonly changedAt: number;
}

export type ConfigChangeSink = (change: ConfigChange) => void;

export interface ConfigWatcher {
  /**
   * Register a subscriber. Returns an unsubscribe function. New subscribers
   * do _not_ receive backfill — call {@link getChangedFiles} for the
   * accumulated state-of-the-world.
   */
  subscribe(sink: ConfigChangeSink): () => void;
  /** Snapshot of files that have changed since the watcher started. */
  getChangedFiles(): readonly ConfigChange[];
  /** Stop watching, release fs handles. Idempotent. */
  close(): Promise<void>;
}

export interface ConfigWatcherOptions {
  /** Absolute paths to watch. Files that don't exist yet are tolerated. */
  readonly files: readonly string[];
  /**
   * Receives every distinct change event. Equivalent to a default subscriber
   * registered before the watcher returns; the option is mandatory because
   * a watcher with no listener is almost always a bug.
   */
  readonly onChange: ConfigChangeSink;
  /** Surfaces errors thrown by individual subscribers. */
  readonly onSubscriberError?: (err: unknown) => void;
  /** Surfaces fs/chokidar errors (e.g. EPERM, ENOSPC for inotify). */
  readonly onWatchError?: (err: unknown) => void;
  /** Injectable clock for `changedAt`. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** "missing" sentinel hash — distinct from any real SHA-256 output. */
const MISSING_HASH = "<missing>";

const hashFile = async (path: string): Promise<string> => {
  try {
    const buf = await readFile(path);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return MISSING_HASH;
  }
};

export const createConfigWatcher = async (
  opts: ConfigWatcherOptions,
): Promise<ConfigWatcher> => {
  const now = opts.now ?? (() => Date.now());

  const baseline = new Map<string, string>();
  for (const f of opts.files) {
    baseline.set(f, await hashFile(f));
  }

  const changed = new Map<string, ConfigChange>();
  const sinks = new Set<ConfigChangeSink>();
  sinks.add(opts.onChange);

  const fanOut = (change: ConfigChange): void => {
    for (const sink of sinks) {
      try {
        sink(change);
      } catch (err) {
        opts.onSubscriberError?.(err);
      }
    }
  };

  // `usePolling: false` (default) — rely on inotify/FSEvents. The wireframes
  // ship with `.sandcastle/main.ts` on the host filesystem, so native watch
  // is sufficient. Polling is a per-environment escape hatch we can add as
  // an option later if the headless docker-on-mac case forces us to.
  const watcher: FSWatcher = chokidar.watch([...opts.files], {
    ignoreInitial: true,
    awaitWriteFinish: {
      // Vim's :w writes via a temp file + rename; without this, the rename
      // fires before the file's content has settled and we'd read stale
      // bytes. 50/100 ms is the chokidar-recommended floor.
      stabilityThreshold: 50,
      pollInterval: 25,
    },
  });

  const onFsEvent = async (path: string): Promise<void> => {
    if (!baseline.has(path)) return;
    const next = await hashFile(path);
    if (next === baseline.get(path)) return; // touched but unchanged
    if (changed.has(path) && changed.get(path)!.path === path) {
      // Already-changed file changed again; we still notify (the operator
      // may want to know the file moved through multiple states), but we
      // overwrite the entry in `changed` so getChangedFiles reflects the
      // most recent change time per file.
    }
    const change: ConfigChange = { path, changedAt: now() };
    changed.set(path, change);
    fanOut(change);
  };

  watcher.on("add", (p) => {
    void onFsEvent(p);
  });
  watcher.on("change", (p) => {
    void onFsEvent(p);
  });
  watcher.on("unlink", (p) => {
    // Treat deletion as a change vs the recorded baseline as long as the
    // baseline wasn't already "missing".
    if (baseline.get(p) === MISSING_HASH) return;
    const change: ConfigChange = { path: p, changedAt: now() };
    changed.set(p, change);
    fanOut(change);
  });
  watcher.on("error", (err) => {
    opts.onWatchError?.(err);
  });

  let closed = false;
  return {
    subscribe(sink) {
      sinks.add(sink);
      return () => {
        sinks.delete(sink);
      };
    },
    getChangedFiles() {
      return [...changed.values()];
    },
    async close() {
      if (closed) return;
      closed = true;
      sinks.clear();
      await watcher.close();
    },
  };
};
