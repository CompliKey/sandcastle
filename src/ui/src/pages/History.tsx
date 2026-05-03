import {
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactElement,
} from "react";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Link, useNavigate } from "react-router-dom";

import { fetchSessions, retryTicket, type SessionView } from "../api.js";
import { formatDuration, formatStartedAt, formatTokens } from "../format.js";

type StatusFilter = "all" | "done" | "errored" | "halted";

const outcomeBadge = (outcome: SessionView["outcome"]): ReactElement => {
  if (outcome === "done")
    return <span className="badge badge--success">✓ done</span>;
  if (outcome === "errored")
    return <span className="badge badge--error">✕ errored</span>;
  if (outcome === "halted")
    return <span className="badge badge--warn">⏸ halted</span>;
  return <span className="badge">… running</span>;
};

const statusOf = (s: SessionView): StatusFilter | "running" =>
  s.outcome ?? "running";

const formatIterations = (s: SessionView): string =>
  // We don't yet know maxIterations from the event log alone — slice 7 just
  // shows the count run so far, in the wireframe's "5 / —" shape.
  `${s.rollup.iterationCount} / —`;

/** Pretty single-line summary of why an errored/halted session ended. */
const errorDetail = (s: SessionView): string | null => {
  if (s.outcome !== "errored" && s.outcome !== "halted") return null;
  const last = s.errors[s.errors.length - 1];
  if (last) return `${last.kind}: ${last.reason}`;
  return s.outcome === "halted"
    ? "autopilot halted"
    : "agent error — see session detail";
};

export const HistoryPage = (): ReactElement => {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);

  const onRetry = async (
    e: MouseEvent<HTMLButtonElement>,
    s: SessionView,
  ): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    if (retryingId) return;
    setRetryingId(s.ticketId);
    setRetryError(null);
    try {
      const { sessionId } = await retryTicket(s.ticketId, {
        scenario: s.scenario,
      });
      navigate(`/sessions/${encodeURIComponent(sessionId)}`);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetryingId(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetchSessions()
      .then((rows) => {
        if (!cancelled) setSessions(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const counts = useMemo(() => {
    const out = { all: 0, done: 0, errored: 0, halted: 0 };
    for (const s of sessions ?? []) {
      out.all += 1;
      const o = s.outcome;
      if (o === "done") out.done += 1;
      else if (o === "errored") out.errored += 1;
      else if (o === "halted") out.halted += 1;
    }
    return out;
  }, [sessions]);

  const visible = useMemo(() => {
    if (!sessions) return [];
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (filter !== "all" && statusOf(s) !== filter) return false;
      if (q.length > 0) {
        const haystack =
          `${s.ticketId} ${s.scenario} ${s.sessionId}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [sessions, filter, query]);

  return (
    <Tooltip.Provider delayDuration={150}>
      <main className="list-page">
        <header className="list-page__header">
          <div>
            <h1 className="list-page__title">History</h1>
            <p className="list-page__sub">
              Every ticket-bounded session ever recorded on this host.
            </p>
          </div>
        </header>

        <div className="filter-bar" role="search">
          <span aria-hidden="true">🔍</span>
          <input
            type="search"
            className="filter-bar__search"
            placeholder="Filter by ticket id, scenario, or session id…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="filter-bar__divider" />
          <ToggleGroup.Root
            type="single"
            value={filter}
            onValueChange={(v) => {
              if (v) setFilter(v as StatusFilter);
            }}
            aria-label="Filter by status"
            className="filter-bar__chips"
          >
            <ToggleGroup.Item value="all" className="filter-chip">
              All <span className="badge">{counts.all}</span>
            </ToggleGroup.Item>
            <ToggleGroup.Item value="done" className="filter-chip">
              Done <span className="badge badge--success">{counts.done}</span>
            </ToggleGroup.Item>
            <ToggleGroup.Item value="errored" className="filter-chip">
              Errored{" "}
              <span className="badge badge--error">{counts.errored}</span>
            </ToggleGroup.Item>
            <ToggleGroup.Item value="halted" className="filter-chip">
              Halted <span className="badge badge--warn">{counts.halted}</span>
            </ToggleGroup.Item>
          </ToggleGroup.Root>
        </div>

        {error && (
          <div className="badge badge--error" style={{ marginBottom: 16 }}>
            Failed to load sessions: {error}
          </div>
        )}

        {retryError && (
          <div
            className="badge badge--error"
            style={{ marginBottom: 16 }}
            data-testid="retry-error"
          >
            Retry failed: {retryError}
          </div>
        )}

        {sessions === null && !error && (
          <p className="list-page__sub">Loading…</p>
        )}

        {sessions !== null && visible.length === 0 && (
          <p className="list-page__sub">
            No sessions match the current filter.
          </p>
        )}

        {visible.length > 0 && (
          <section className="session-list" aria-label="Sessions">
            <header className="session-list__head" role="row">
              <span>Status</span>
              <span>Ticket</span>
              <span>Started</span>
              <span>Duration</span>
              <span>Iter.</span>
              <span>Commits</span>
              <span>Tokens</span>
              <span />
            </header>

            {visible.map((s) => {
              const errored = s.outcome === "errored" || s.outcome === "halted";
              const detail = errorDetail(s);
              return (
                <Link
                  to={`/sessions/${encodeURIComponent(s.sessionId)}`}
                  key={s.sessionId}
                  className={`session-row${errored ? " session-row--errored" : ""}`}
                  role="row"
                  data-testid={`session-row-${s.ticketId}`}
                >
                  <span>{outcomeBadge(s.outcome)}</span>
                  <span className="session-row__ticket-cell">
                    <span className="session-row__ticket">{s.ticketId}</span>
                    <span className="session-row__title">{s.scenario}</span>
                  </span>
                  <span className="session-row__started">
                    {formatStartedAt(s.startedAt)}
                  </span>
                  <span className="session-row__num">
                    {formatDuration(s.rollup.wallTimeMs)}
                  </span>
                  <span className="session-row__num">
                    {formatIterations(s)}
                  </span>
                  <span className="session-row__num">{s.commits.length}</span>
                  <span className="session-row__num">
                    {formatTokens(s.rollup.totalTokens)}
                  </span>
                  <span className="session-row__actions">
                    {errored && (
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={(e) => {
                          void onRetry(e, s);
                        }}
                        disabled={retryingId === s.ticketId}
                        data-testid={`retry-${s.ticketId}`}
                        aria-label={`Retry ticket ${s.ticketId}`}
                      >
                        {retryingId === s.ticketId ? "↻ …" : "↻ Retry"}
                      </button>
                    )}
                    <Tooltip.Root>
                      <Tooltip.Trigger asChild>
                        <span
                          className="btn btn--ghost"
                          aria-label="Open session"
                        >
                          ↗
                        </span>
                      </Tooltip.Trigger>
                      <Tooltip.Portal>
                        <Tooltip.Content className="tooltip">
                          Open session detail
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  </span>
                  {errored && detail && (
                    <span className="session-row__error-detail">{detail}</span>
                  )}
                </Link>
              );
            })}
          </section>
        )}
      </main>
    </Tooltip.Provider>
  );
};
