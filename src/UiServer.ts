/**
 * UiServer — local HTTP+WS server that surfaces session history and
 * (in later slices) live agent activity.
 *
 * Pure I/O adapter over {@link SessionIndex}. No Effect, no global state —
 * the CLI wires it up with a populated index and starts/stops it.
 *
 * Surface
 * - REST: `/api/sessions`, `/api/sessions/:id`, `/api/tickets/:id/sessions`
 * - WS:   `/ws` — accepts upgrades; no broadcast in this slice.
 *         Slice 8 fills in live event push.
 * - Static: every other GET serves files from `assetsDir` (the bundled
 *   frontend), falling back to `index.html` for client-side SPA routing.
 *
 * Single-instance protocol
 * - On {@link startUiServer} the caller may pass `lockfilePath`. If the
 *   chosen port is busy, {@link probeExistingServer} should be called by
 *   the caller to decide whether to hand off to the running instance.
 * - The lockfile is purely advisory — the trust check is a `GET /api/health`
 *   that returns `{ application: "sandcastle" }`.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  extname,
  join,
  normalize,
  resolve as resolvePath,
  sep,
} from "node:path";

import type {
  BacklogManagerHostInterface,
  BacklogTicket,
  ScenarioOverrides,
} from "./defineSandcastle.js";
import type { EventBroadcaster } from "./EventBroadcaster.js";
import type { GitDiffService } from "./GitDiffService.js";
import type { ScenarioRunResult } from "./ScenarioRunner.js";
import type { SessionIndex } from "./SessionIndex.js";
import { attachWebSocket } from "./WebSocket.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Argument shape for {@link RunScenarioRequestFn}. Mirrors the
 * `POST /api/run-scenario` body — the server does basic shape validation
 * and forwards the request to the host-provided handler, which closes over
 * `configPath` / `EventStore` / `signal`.
 */
export interface RunScenarioRequest {
  readonly scenario: string;
  readonly ticketId: string;
  readonly overrides?: ScenarioOverrides;
}

/**
 * Resolved shape of {@link RunScenarioRequestFn}: the allocated session id is
 * surfaced as soon as the run is admitted (so the UI can navigate to the
 * live view), while the long-running scenario continues in the background
 * via `done`.
 */
export interface RunScenarioStarted {
  readonly sessionId: string;
  /**
   * Settles when the underlying scenario run completes. The UI server does
   * not block on this — it attaches a `.catch(() => {})` so a rejection
   * does not become an unhandled promise rejection.
   */
  readonly done: Promise<ScenarioRunResult>;
}

/**
 * Adapter the UI server calls to start a manual single-ticket invocation.
 * The CLI binds this to a closure over `configPath`, the shared `EventStore`,
 * and a long-lived shutdown signal. Manual runs work whether autopilot is
 * ON or OFF — they share the EventStore but spawn an independent child.
 *
 * The adapter must allocate `sessionId` *before* returning so the UI can
 * navigate to the live view immediately.
 */
export type RunScenarioRequestFn = (
  request: RunScenarioRequest,
) => Promise<RunScenarioStarted>;

/**
 * Per-scenario metadata exposed to the UI so it can populate the override
 * sheet ("Scenario default: 12") and validate the chosen scenario name.
 */
export interface ScenarioOption {
  readonly name: string;
  readonly description?: string;
  readonly maxIterations?: number;
}

export interface UiServerOptions {
  readonly index: SessionIndex;
  /**
   * Optional live-event broadcaster. When provided, `/ws` upgrades stream a
   * snapshot of the requested session followed by every subsequent event the
   * producer publishes for that session. When omitted, `/ws` accepts the
   * upgrade and immediately closes (slice-7 behaviour).
   */
  readonly broadcaster?: EventBroadcaster;
  /**
   * Optional diff service. When provided, the server exposes
   * `GET /api/sessions/:id/commits/:sha` and
   * `GET /api/sessions/:id/commits/:sha/diff?path=...`. The session id gates
   * access (the commit must appear in `view.commits`) but the underlying
   * `git show` is rooted at one shared repo path — git's shared object DB
   * means commits from any worktree resolve from the same root.
   */
  readonly gitDiffService?: GitDiffService;
  /**
   * Optional backlog manager. When provided, `GET /api/queue` lists pending
   * tickets via {@link BacklogManagerHostInterface.listPending}. Without it,
   * the queue endpoint returns 503 — the rest of the server still works for
   * read-only history viewing.
   */
  readonly backlogManager?: BacklogManagerHostInterface;
  /**
   * Optional manual-invocation adapter. When provided,
   * `POST /api/run-scenario` triggers a single-ticket run. Without it, the
   * endpoint returns 503.
   */
  readonly runScenario?: RunScenarioRequestFn;
  /**
   * Optional scenario catalogue surfaced at `GET /api/scenarios`. Lets the
   * frontend populate the override sheet's scenario picker and look up the
   * "Scenario default" maxIterations.
   */
  readonly scenarios?: readonly ScenarioOption[];
  /**
   * Absolute path to the bundled frontend (e.g. `dist/ui`). When the
   * directory is missing, the server returns a small placeholder page —
   * useful in tests and during early development before the frontend is
   * built.
   */
  readonly assetsDir?: string;
  /** Default `127.0.0.1`. Bind only to loopback. */
  readonly host?: string;
  /** Default `4321`. Pass `0` to let the OS pick a free port. */
  readonly port?: number;
  /** Reported by `/api/health`. Defaults to `"sandcastle"`. */
  readonly application?: string;
  /** Reported by `/api/health`. */
  readonly version?: string;
}

export interface UiServer {
  readonly url: string;
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

export interface HealthPayload {
  readonly application: string;
  readonly version?: string;
  readonly pid: number;
  readonly startedAt: number;
}

export const DEFAULT_UI_PORT = 4321;
export const DEFAULT_UI_HOST = "127.0.0.1";
export const UI_LOCKFILE_NAME = "ui.lock";

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const startUiServer = async (
  opts: UiServerOptions,
): Promise<UiServer> => {
  const host = opts.host ?? DEFAULT_UI_HOST;
  const port = opts.port ?? DEFAULT_UI_PORT;
  const application = opts.application ?? "sandcastle";
  const startedAt = Date.now();
  const assetsDir = opts.assetsDir ? resolvePath(opts.assetsDir) : undefined;

  const server = createHttpServer((req, res) => {
    handleRequest(req, res, {
      index: opts.index,
      assetsDir,
      gitDiffService: opts.gitDiffService,
      backlogManager: opts.backlogManager,
      runScenario: opts.runScenario,
      scenarios: opts.scenarios,
      health: {
        application,
        version: opts.version,
        pid: process.pid,
        startedAt,
      },
    }).catch((err) => {
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    });
  });

  server.on("upgrade", (req, socket) => {
    if (!req.url) {
      socket.destroy();
      return;
    }
    // Match exactly /ws or /ws?... — startsWith("/ws") would also accept
    // /wsanything, exposing nothing today but a foot-gun if the surface grows.
    const path = req.url.split("?", 1)[0];
    if (path !== "/ws") {
      socket.destroy();
      return;
    }
    handleWebSocketUpgrade(req, socket, opts.index, opts.broadcaster);
  });

  await listen(server, port, host);
  const address = server.address();
  const boundPort =
    typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${boundPort}`;

  return {
    url,
    port: boundPort,
    host,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
};

const listen = (
  server: HttpServer,
  port: number,
  host: string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

// ---------------------------------------------------------------------------
// WebSocket: live session feed
// ---------------------------------------------------------------------------

/**
 * Handle a `/ws?session=<id>` upgrade. On accept:
 * 1. Send a single `{ type: "snapshot", view }` message reflecting current
 *    `SessionIndex` state for the session. This bootstraps the client's view.
 * 2. Subscribe to the broadcaster's `session:<id>` channel and forward each
 *    matching event as `{ type: "event", event }`.
 * If the session id is unknown, send `{ type: "error", reason: ... }` and
 * close — the client decides whether to retry or fall back to REST.
 *
 * Without a broadcaster the upgrade is rejected (404 close); only the
 * snapshot would be available, which the REST endpoint already provides.
 */
const handleWebSocketUpgrade = (
  req: IncomingMessage,
  socket: import("node:stream").Duplex,
  index: SessionIndex,
  broadcaster: EventBroadcaster | undefined,
): void => {
  const url = new URL(req.url ?? "/ws", "http://localhost");
  const sessionId = url.searchParams.get("session");

  const conn = attachWebSocket(req, socket);
  if (!conn) return;

  if (!broadcaster || !sessionId) {
    conn.send(
      JSON.stringify({
        type: "error",
        reason: !broadcaster
          ? "live broadcaster not configured"
          : "missing ?session= query parameter",
      }),
    );
    // 4400 — application-level "bad request"; 1008 (Policy Violation) is
    // semantically wrong for a missing query parameter.
    conn.close(4400, "bad request");
    return;
  }

  // Subscribe-then-snapshot-then-drain: we subscribe first and buffer any
  // events that arrive before the snapshot is sent, then replay them after.
  // This closes the snapshot/subscribe race — even if a future change adds
  // an await between subscribe and getSession, no event published in that
  // window can be silently lost. In the current synchronous code path the
  // buffer is always empty, but the pattern is the safety net.
  let snapshotSent = false;
  const buffered: import("./EventStore.js").SandcastleEvent[] = [];
  const unsubscribe = broadcaster.subscribe(
    { type: "session", id: sessionId },
    (event) => {
      if (!snapshotSent) {
        buffered.push(event);
        return;
      }
      conn.send(JSON.stringify({ type: "event", event }));
    },
  );

  const view = index.getSession(sessionId);
  if (!view) {
    unsubscribe();
    conn.send(JSON.stringify({ type: "error", reason: "unknown session" }));
    // 4404 — application-level "not found".
    conn.close(4404, "unknown session");
    return;
  }

  conn.send(JSON.stringify({ type: "snapshot", view }));
  snapshotSent = true;
  for (const event of buffered) {
    conn.send(JSON.stringify({ type: "event", event }));
  }
  buffered.length = 0;

  conn.onClose(() => {
    unsubscribe();
  });
};

// ---------------------------------------------------------------------------
// Single-instance protocol
// ---------------------------------------------------------------------------

/**
 * Ask the server at `url` whether it is a sandcastle UI server.
 *
 * Returns the health payload on success, `null` on any failure (network,
 * non-200, mismatched `application` field, parse error). The caller treats
 * `null` as "no living sandcastle UI server here" and is free to start one.
 *
 * Times out after `timeoutMs` (default 1000ms).
 */
export const probeExistingServer = async (
  url: string,
  options: { readonly timeoutMs?: number; readonly application?: string } = {},
): Promise<HealthPayload | null> => {
  const application = options.application ?? "sandcastle";
  const timeoutMs = options.timeoutMs ?? 1000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/health`, {
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<HealthPayload>;
    if (
      typeof body.application !== "string" ||
      body.application !== application
    ) {
      return null;
    }
    return {
      application: body.application,
      version: body.version,
      pid: typeof body.pid === "number" ? body.pid : -1,
      startedAt: typeof body.startedAt === "number" ? body.startedAt : 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

interface HandlerCtx {
  readonly index: SessionIndex;
  readonly assetsDir?: string;
  readonly gitDiffService?: GitDiffService;
  readonly backlogManager?: BacklogManagerHostInterface;
  readonly runScenario?: RunScenarioRequestFn;
  readonly scenarios?: readonly ScenarioOption[];
  readonly health: HealthPayload;
}

const handleRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerCtx,
): Promise<void> => {
  if (!req.url) return sendError(res, 400, "missing url");
  const method = req.method ?? "GET";

  // URL parsing — the host header isn't always trustworthy, but for query
  // string handling a placeholder origin is fine.
  const url = new URL(req.url, "http://localhost");
  const { pathname } = url;

  // POST is restricted to the manual-invocation endpoint. Everything else is
  // read-only.
  if (method === "POST") {
    if (pathname === "/api/run-scenario") {
      return handleRunScenario(req, res, ctx);
    }
    return sendError(res, 405, "method not allowed");
  }
  if (method !== "GET" && method !== "HEAD") {
    return sendError(res, 405, "method not allowed");
  }

  if (pathname === "/api/health") {
    return sendJson(res, 200, ctx.health);
  }

  if (pathname === "/api/queue") {
    return handleQueue(res, ctx, url);
  }

  if (pathname === "/api/scenarios") {
    return sendJson(res, 200, { scenarios: ctx.scenarios ?? [] });
  }

  if (pathname === "/api/sessions") {
    const limit = parseIntParam(url.searchParams.get("limit"));
    const since = parseIntParam(url.searchParams.get("since"));
    const sessions = ctx.index.listSessions({
      limit: limit ?? undefined,
      since: since ?? undefined,
    });
    return sendJson(res, 200, { sessions });
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const session = ctx.index.getSession(decodeURIComponent(sessionMatch[1]!));
    if (!session) return sendError(res, 404, "session not found");
    return sendJson(res, 200, { session });
  }

  const commitDiffMatch = pathname.match(
    /^\/api\/sessions\/([^/]+)\/commits\/([0-9a-fA-F]{4,64})\/diff$/,
  );
  if (commitDiffMatch) {
    return handleCommitDiff(res, ctx, {
      sessionId: decodeURIComponent(commitDiffMatch[1]!),
      sha: commitDiffMatch[2]!,
      path: url.searchParams.get("path"),
    });
  }

  const commitMatch = pathname.match(
    /^\/api\/sessions\/([^/]+)\/commits\/([0-9a-fA-F]{4,64})$/,
  );
  if (commitMatch) {
    return handleCommit(res, ctx, {
      sessionId: decodeURIComponent(commitMatch[1]!),
      sha: commitMatch[2]!,
    });
  }

  const ticketMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/sessions$/);
  if (ticketMatch) {
    const ticketId = decodeURIComponent(ticketMatch[1]!);
    const sessions = ctx.index.listByTicket(ticketId);
    return sendJson(res, 200, { ticketId, sessions });
  }

  if (pathname.startsWith("/api/")) {
    return sendError(res, 404, "unknown api endpoint");
  }

  // Static: serve from assetsDir, with SPA fallback to index.html.
  await serveStatic(res, pathname, ctx.assetsDir);
};

const parseIntParam = (raw: string | null): number | null => {
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------------------
// Commit + diff handlers
// ---------------------------------------------------------------------------

/**
 * The session id gates which commits a client can see — a sha must already
 * appear in the session's `view.commits`. This stops a client that knows the
 * UI server's port from enumerating arbitrary commits in the host repo.
 */
const sessionContainsCommit = (
  ctx: HandlerCtx,
  sessionId: string,
  sha: string,
): boolean => {
  const view = ctx.index.getSession(sessionId);
  if (!view) return false;
  return view.commits.some((c) => c.sha === sha);
};

const handleCommit = async (
  res: ServerResponse,
  ctx: HandlerCtx,
  args: { sessionId: string; sha: string },
): Promise<void> => {
  if (!ctx.gitDiffService) {
    return sendError(res, 503, "git diff service not configured");
  }
  if (!sessionContainsCommit(ctx, args.sessionId, args.sha)) {
    return sendError(res, 404, "commit not found in session");
  }
  try {
    const commit = await ctx.gitDiffService.getCommit(args.sha);
    return sendJson(res, 200, { commit });
  } catch (err) {
    return sendError(
      res,
      404,
      err instanceof Error ? err.message : String(err),
    );
  }
};

const handleCommitDiff = async (
  res: ServerResponse,
  ctx: HandlerCtx,
  args: { sessionId: string; sha: string; path: string | null },
): Promise<void> => {
  if (!ctx.gitDiffService) {
    return sendError(res, 503, "git diff service not configured");
  }
  if (!args.path) {
    return sendError(res, 400, "missing ?path= query parameter");
  }
  if (!sessionContainsCommit(ctx, args.sessionId, args.sha)) {
    return sendError(res, 404, "commit not found in session");
  }
  try {
    const diff = await ctx.gitDiffService.getFileDiff(args.sha, args.path);
    return sendJson(res, 200, { diff });
  } catch (err) {
    return sendError(
      res,
      400,
      err instanceof Error ? err.message : String(err),
    );
  }
};

// ---------------------------------------------------------------------------
// Queue + run-scenario handlers
// ---------------------------------------------------------------------------

const handleQueue = async (
  res: ServerResponse,
  ctx: HandlerCtx,
  url: URL,
): Promise<void> => {
  if (!ctx.backlogManager) {
    return sendError(res, 503, "backlog manager not configured");
  }
  const includeErrored = url.searchParams.get("includeErrored") === "true";
  try {
    const tickets = await ctx.backlogManager.listPending({ includeErrored });
    return sendJson(res, 200, { tickets: tickets.map(serializeTicket) });
  } catch (err) {
    return sendError(
      res,
      502,
      `listPending failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

const serializeTicket = (
  t: BacklogTicket,
): {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly url: string;
  readonly priority?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
} => ({
  id: t.id,
  title: t.title,
  body: t.body,
  labels: [...t.labels],
  url: t.url,
  ...(t.priority !== undefined ? { priority: t.priority } : {}),
  ...(t.createdAt !== undefined ? { createdAt: t.createdAt } : {}),
  ...(t.updatedAt !== undefined ? { updatedAt: t.updatedAt } : {}),
});

/**
 * Body cap for `POST /api/run-scenario`. The intent is to reject pathological
 * payloads cheaply, not to enforce a meaningful limit on `promptArgs` — 256KB
 * is far more than any realistic override.
 */
const RUN_SCENARIO_MAX_BODY_BYTES = 256 * 1024;

const handleRunScenario = async (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerCtx,
): Promise<void> => {
  if (!ctx.runScenario) {
    return sendError(res, 503, "manual run-scenario not configured");
  }

  let raw: string;
  try {
    raw = await readRequestBody(req, RUN_SCENARIO_MAX_BODY_BYTES);
  } catch (err) {
    return sendError(
      res,
      413,
      err instanceof Error ? err.message : String(err),
    );
  }

  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    return sendError(res, 400, "request body must be valid JSON");
  }

  const validation = parseRunScenarioBody(parsed, ctx.scenarios);
  if (!validation.ok) {
    return sendError(res, 400, validation.error);
  }

  let started: RunScenarioStarted;
  try {
    started = await ctx.runScenario(validation.request);
  } catch (err) {
    return sendError(
      res,
      500,
      `runScenario rejected: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Detach the long-running scenario from the HTTP request: the client
  // receives the sessionId immediately and navigates to the live view, which
  // subscribes via `/ws`. Attach a noop `.catch` so a downstream rejection
  // does not become an unhandled promise rejection.
  void started.done.catch(() => {});

  return sendJson(res, 202, { sessionId: started.sessionId });
};

interface ParsedRunScenarioBody {
  readonly ok: true;
  readonly request: RunScenarioRequest;
}
interface ParsedRunScenarioError {
  readonly ok: false;
  readonly error: string;
}

const parseRunScenarioBody = (
  body: unknown,
  scenarios: readonly ScenarioOption[] | undefined,
): ParsedRunScenarioBody | ParsedRunScenarioError => {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.scenario !== "string" || b.scenario.length === 0) {
    return { ok: false, error: "scenario must be a non-empty string" };
  }
  if (typeof b.ticketId !== "string" || b.ticketId.length === 0) {
    return { ok: false, error: "ticketId must be a non-empty string" };
  }
  if (scenarios && !scenarios.some((s) => s.name === b.scenario)) {
    const available = scenarios.map((s) => s.name).join(", ");
    return {
      ok: false,
      error: `unknown scenario "${b.scenario}". Available: ${available || "(none)"}.`,
    };
  }
  let overrides: ScenarioOverrides | undefined;
  if (b.overrides !== undefined) {
    if (typeof b.overrides !== "object" || b.overrides === null) {
      return { ok: false, error: "overrides must be an object" };
    }
    const o = b.overrides as Record<string, unknown>;
    overrides = {};
    if (o.maxIterations !== undefined) {
      if (
        typeof o.maxIterations !== "number" ||
        !Number.isInteger(o.maxIterations) ||
        o.maxIterations < 1
      ) {
        return {
          ok: false,
          error: "overrides.maxIterations must be a positive integer",
        };
      }
      overrides = { ...overrides, maxIterations: o.maxIterations };
    }
    if (o.model !== undefined) {
      if (typeof o.model !== "string" || o.model.length === 0) {
        return {
          ok: false,
          error: "overrides.model must be a non-empty string",
        };
      }
      overrides = { ...overrides, model: o.model };
    }
    if (o.promptArgs !== undefined) {
      if (
        typeof o.promptArgs !== "object" ||
        o.promptArgs === null ||
        Array.isArray(o.promptArgs)
      ) {
        return {
          ok: false,
          error: "overrides.promptArgs must be a plain JSON object",
        };
      }
      overrides = {
        ...overrides,
        promptArgs: o.promptArgs as Record<string, unknown>,
      };
    }
  }
  return {
    ok: true,
    request: {
      scenario: b.scenario,
      ticketId: b.ticketId,
      ...(overrides !== undefined ? { overrides } : {}),
    },
  };
};

const readRequestBody = (
  req: IncomingMessage,
  maxBytes: number,
): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

// ---------------------------------------------------------------------------
// Static asset serving
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

const serveStatic = async (
  res: ServerResponse,
  pathname: string,
  assetsDir: string | undefined,
): Promise<void> => {
  if (!assetsDir) {
    return sendPlaceholder(res);
  }

  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const safe = resolveSafe(assetsDir, requestedPath);
  if (!safe) return sendError(res, 400, "invalid path");

  const fileToServe = await pickFile(assetsDir, safe);
  if (!fileToServe) return sendError(res, 404, "not found");

  const ext = extname(fileToServe).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  res.statusCode = 200;
  res.setHeader("content-type", type);
  // Hashed asset names (Vite default) are immutable — long-cache them.
  if (/[-.][0-9a-zA-Z_-]{8,}\.\w+$/.test(fileToServe)) {
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("cache-control", "no-cache");
  }
  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream(fileToServe);
    stream.on("error", rejectStream);
    stream.on("end", () => resolveStream());
    stream.pipe(res);
  });
};

/** Reject path traversal — only allow paths under `root`. */
const resolveSafe = (root: string, requested: string): string | null => {
  const joined = normalize(join(root, requested));
  const rootNormalised = normalize(root + sep);
  if (joined !== normalize(root) && !joined.startsWith(rootNormalised)) {
    return null;
  }
  return joined;
};

const pickFile = async (
  assetsDir: string,
  candidate: string,
): Promise<string | null> => {
  const direct = await statOrNull(candidate);
  if (direct?.isFile()) return candidate;
  // SPA fallback — every unknown route renders index.html so the React
  // router can take over.
  const indexHtml = join(assetsDir, "index.html");
  const indexStat = await statOrNull(indexHtml);
  return indexStat?.isFile() ? indexHtml : null;
};

const statOrNull = async (
  path: string,
): Promise<Awaited<ReturnType<typeof stat>> | null> => {
  try {
    return await stat(path);
  } catch {
    return null;
  }
};

const sendPlaceholder = (res: ServerResponse): void => {
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(
    `<!doctype html><meta charset=utf-8><title>sandcastle ui</title>` +
      `<body style="font-family:system-ui;padding:2rem;color:#444">` +
      `<h1>sandcastle ui</h1>` +
      `<p>The bundled frontend is not built yet. Run <code>npm run build</code> ` +
      `inside the sandcastle repo to populate <code>dist/ui/</code>.</p>` +
      `<p>The REST API is live: ` +
      `<a href="/api/sessions">/api/sessions</a>, ` +
      `<a href="/api/health">/api/health</a>.</p></body>`,
  );
};

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
};

const sendError = (
  res: ServerResponse,
  status: number,
  message: string,
): void => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: message }));
};
