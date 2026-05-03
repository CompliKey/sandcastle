/**
 * EventStore — append-only JSONL event log under `.sandcastle/state/`.
 *
 * One JSON event per line, one file per calendar month
 * (`events-YYYY-MM.jsonl`). Single writer per directory: at runtime the
 * sandcastle parent process; in tests, one fixture per store.
 *
 * Crash safety: each `append` writes `JSON.stringify(event) + "\n"` in a
 * single `FileHandle.write` call. A SIGKILL between flush and fsync may leave
 * a torn trailing line in the most-recent file — `replay` detects and skips
 * it. JSON-parse failures mid-file are real corruption and throw.
 *
 * No I/O happens beyond this module. Higher layers (SessionIndex,
 * UI server) consume events from `replay` / `tail`.
 */

import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/** Per-iteration token usage as parsed from the agent session. */
export interface EventIterationUsage {
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
}

/** Outcome of a ticket-bounded session at `session.end`. */
export type SessionOutcome = "done" | "errored" | "halted";

/**
 * Fields shared by every event. `laneId` is "main" in v1 — present on every
 * event so future parallel autopilot is purely additive.
 */
interface EventBase {
  readonly laneId: string;
  /** Wall-clock emit time, ms since epoch. */
  readonly timestamp: number;
}

export interface SessionStartEvent extends EventBase {
  readonly type: "session.start";
  readonly sessionId: string;
  readonly ticketId: string;
  readonly scenario: string;
  readonly startedAt: number;
}

export interface SessionEndEvent extends EventBase {
  readonly type: "session.end";
  readonly sessionId: string;
  readonly outcome: SessionOutcome;
  readonly endedAt: number;
}

export interface IterationStartEvent extends EventBase {
  readonly type: "iteration.start";
  readonly sessionId: string;
  readonly iteration: number;
  readonly startedAt: number;
}

export interface IterationEndEvent extends EventBase {
  readonly type: "iteration.end";
  readonly sessionId: string;
  readonly iteration: number;
  readonly usage?: EventIterationUsage;
  readonly endedAt: number;
}

export interface AgentTextEvent extends EventBase {
  readonly type: "agent.text";
  readonly sessionId: string;
  readonly iteration: number;
  readonly text: string;
}

export interface AgentToolCallEvent extends EventBase {
  readonly type: "agent.toolCall";
  readonly sessionId: string;
  readonly iteration: number;
  /**
   * Provider-specific tool-use id, used by {@link AgentToolResultEvent} to
   * pair a result back to its call. Optional because pre-VGD-141 events on
   * disk and non-Claude providers may omit it.
   */
  readonly toolUseId?: string;
  readonly toolName: string;
  readonly formattedArgs: string;
}

export interface AgentToolResultEvent extends EventBase {
  readonly type: "agent.toolResult";
  readonly sessionId: string;
  readonly iteration: number;
  /** Matches the {@link AgentToolCallEvent.toolUseId} of the originating call. */
  readonly toolUseId: string;
  readonly result: string;
  readonly isError: boolean;
}

export interface CommitEvent extends EventBase {
  readonly type: "commit";
  readonly sessionId: string;
  readonly sha: string;
}

export interface ErrorEvent extends EventBase {
  readonly type: "error";
  readonly sessionId: string;
  readonly kind: string;
  readonly reason: string;
}

export interface UserLogEvent extends EventBase {
  readonly type: "user.log";
  readonly sessionId: string;
  readonly payload: unknown;
}

/** Discriminated union of every event the EventStore persists. */
export type SandcastleEvent =
  | SessionStartEvent
  | SessionEndEvent
  | IterationStartEvent
  | IterationEndEvent
  | AgentTextEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | CommitEvent
  | ErrorEvent
  | UserLogEvent;

// ---------------------------------------------------------------------------
// Cursor and replayed pair
// ---------------------------------------------------------------------------

/**
 * A position in the event log. `month` is `YYYY-MM`; `byteOffset` is just past
 * the trailing newline of the last yielded event in that file.
 */
export interface EventCursor {
  readonly month: string;
  readonly byteOffset: number;
}

/** Yielded by `replay` and `tail`. */
export interface ReplayedEvent {
  readonly event: SandcastleEvent;
  readonly cursor: EventCursor;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EventStoreOptions {
  /** Absolute path to the directory that holds `events-YYYY-MM.jsonl` files. */
  readonly dir: string;
  /** Injectable clock — controls which month file `append` writes to. */
  readonly clock?: () => Date;
}

export interface ReplayOptions {
  /** Resume from this cursor (exclusive). When omitted, replay from the start. */
  readonly since?: EventCursor;
}

export interface TailOptions extends ReplayOptions {
  readonly signal?: AbortSignal;
  /** Default 200ms. */
  readonly pollIntervalMs?: number;
}

export interface EventStore {
  /** Append a single event to the current month's file. */
  append(event: SandcastleEvent): Promise<void>;
  /** Replay every event from the cursor (or start) to the current end-of-log. */
  replay(options?: ReplayOptions): AsyncIterable<ReplayedEvent>;
  /** Replay then poll for new events until the AbortSignal fires. */
  tail(options?: TailOptions): AsyncIterable<ReplayedEvent>;
  /** Sorted list of month tokens (`YYYY-MM`) currently on disk. */
  listMonths(): Promise<readonly string[]>;
  /** Release the writer's file handle. Idempotent. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 200;
const FILE_PREFIX = "events-";
const FILE_SUFFIX = ".jsonl";
const MONTH_RE = /^\d{4}-\d{2}$/;

const monthOf = (date: Date): string => {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
};

const filePathFor = (dir: string, month: string): string =>
  join(dir, `${FILE_PREFIX}${month}${FILE_SUFFIX}`);

const compareMonth = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * Parse all complete events from `buffer`. Returns the parsed events plus the
 * byte offset (relative to `buffer`) just past the last consumed line. A
 * trailing line without a newline is treated as incomplete — its bytes are
 * left for the next read. A trailing line WITH a newline that fails
 * `JSON.parse` is treated as a crash-truncated artifact and skipped.
 *
 * Mid-file JSON-parse failures throw — that is real corruption.
 */
const parseChunk = (
  buffer: Buffer,
  context: { month: string; isFinalFile: boolean },
): {
  events: { event: SandcastleEvent; endByteOffset: number }[];
  consumed: number;
} => {
  const events: { event: SandcastleEvent; endByteOffset: number }[] = [];
  let cursor = 0;
  let lastNewline = -1;

  // Find last newline so we know where complete-line territory ends.
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i] === 0x0a) {
      lastNewline = i;
      break;
    }
  }
  const completeBytesEnd = lastNewline + 1; // 0 if no newline at all

  while (cursor < completeBytesEnd) {
    const nl = buffer.indexOf(0x0a, cursor);
    if (nl === -1) break; // shouldn't happen given completeBytesEnd guard
    const lineEnd = nl + 1; // exclusive, includes "\n"
    const line = buffer.subarray(cursor, nl).toString("utf8");
    cursor = lineEnd;
    if (line.length === 0) continue; // tolerate stray blank lines

    let parsed: SandcastleEvent;
    try {
      parsed = JSON.parse(line) as SandcastleEvent;
    } catch (err) {
      const isTrailing = cursor === completeBytesEnd;
      if (isTrailing && context.isFinalFile) {
        // Crash-truncated trailing line — skip and stop. Anything after this
        // (there shouldn't be anything) is suspect.
        return { events, consumed: nl }; // do not consume the bad line
      }
      throw new Error(
        `EventStore: corrupt event in ${context.month} at byte ${cursor - line.length - 1}: ${(err as Error).message}`,
      );
    }
    events.push({ event: parsed, endByteOffset: lineEnd });
  }

  return { events, consumed: completeBytesEnd };
};

const listMonthFiles = async (dir: string): Promise<string[]> => {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const months: string[] = [];
  for (const name of entries) {
    if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) continue;
    const token = name.slice(
      FILE_PREFIX.length,
      name.length - FILE_SUFFIX.length,
    );
    if (MONTH_RE.test(token)) months.push(token);
  }
  months.sort(compareMonth);
  return months;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createEventStore = (options: EventStoreOptions): EventStore => {
  const clock = options.clock ?? (() => new Date());
  const { dir } = options;

  let writeHandle: FileHandle | null = null;
  let writeMonth: string | null = null;
  let writeChain: Promise<void> = Promise.resolve();

  const acquireWriter = async (): Promise<{
    handle: FileHandle;
    month: string;
  }> => {
    const month = monthOf(clock());
    if (writeHandle && writeMonth === month) {
      return { handle: writeHandle, month };
    }
    if (writeHandle) {
      await writeHandle.close();
      writeHandle = null;
      writeMonth = null;
    }
    await mkdir(dir, { recursive: true });
    writeHandle = await open(filePathFor(dir, month), "a");
    writeMonth = month;
    return { handle: writeHandle, month };
  };

  const append = async (event: SandcastleEvent): Promise<void> => {
    // Serialize concurrent appends so the FileHandle is touched by one write
    // at a time. Append-mode writes are still appended-at-end thanks to
    // O_APPEND, but we keep ordering deterministic and avoid interleaving the
    // serialization step with handle reopens at month boundaries.
    const next = writeChain.then(async () => {
      const line = `${JSON.stringify(event)}\n`;
      const buf = Buffer.from(line, "utf8");
      const { handle } = await acquireWriter();
      await handle.write(buf);
    });
    writeChain = next.catch(() => undefined);
    return next;
  };

  const close = async (): Promise<void> => {
    await writeChain.catch(() => undefined);
    if (writeHandle) {
      await writeHandle.close();
      writeHandle = null;
      writeMonth = null;
    }
  };

  /**
   * Walk `[startMonth..endMonth]` (inclusive on the disk listing) and yield
   * every event after the optional cursor. `endMonth` snapshot is taken
   * before iteration so concurrently-rotated files don't leak into a single
   * `replay` pass — that's `tail`'s job.
   */
  async function* walk(options?: ReplayOptions): AsyncIterable<ReplayedEvent> {
    const allMonths = await listMonthFiles(dir);
    if (allMonths.length === 0) return;

    const since = options?.since;
    const startIdx = since
      ? allMonths.findIndex((m) => compareMonth(m, since.month) >= 0)
      : 0;
    if (startIdx === -1) return;

    for (let i = startIdx; i < allMonths.length; i++) {
      const month = allMonths[i]!;
      const isFinalFile = i === allMonths.length - 1;
      const path = filePathFor(dir, month);
      let buffer: Buffer;
      try {
        buffer = await readFile(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      const startOffset = since && since.month === month ? since.byteOffset : 0;
      if (startOffset >= buffer.length) continue;
      const slice = buffer.subarray(startOffset);
      const { events } = parseChunk(slice, { month, isFinalFile });
      for (const { event, endByteOffset } of events) {
        yield {
          event,
          cursor: { month, byteOffset: startOffset + endByteOffset },
        };
      }
    }
  }

  const replay = (options?: ReplayOptions): AsyncIterable<ReplayedEvent> =>
    walk(options);

  async function* tailImpl(
    options?: TailOptions,
  ): AsyncIterable<ReplayedEvent> {
    const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const signal = options?.signal;
    let cursor: EventCursor | undefined = options?.since;

    while (true) {
      if (signal?.aborted) return;
      for await (const replayed of walk(
        cursor ? { since: cursor } : undefined,
      )) {
        yield replayed;
        cursor = replayed.cursor;
        if (signal?.aborted) return;
      }
      if (signal?.aborted) return;
      await sleep(pollIntervalMs, signal);
    }
  }

  const tail = (options?: TailOptions): AsyncIterable<ReplayedEvent> =>
    tailImpl(options);

  return {
    append,
    replay,
    tail,
    listMonths: async () => listMonthFiles(dir),
    close,
  };
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
