import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Link, useParams } from "react-router-dom";

import { fetchTicket, type SessionView, type TicketDetail } from "../api.js";
import {
  formatDuration,
  formatLongDuration,
  formatStartedAt,
  formatTokens,
} from "../format.js";

const outcomeBadge = (outcome: SessionView["outcome"]): ReactElement => {
  if (outcome === "done")
    return <span className="badge badge--success">✓ done</span>;
  if (outcome === "errored")
    return <span className="badge badge--error">✕ errored</span>;
  if (outcome === "halted")
    return <span className="badge badge--warn">⏸ halted</span>;
  return <span className="badge">… running</span>;
};

const formatIterations = (s: SessionView): string => {
  const max = s.rollup.maxIterations;
  return `${s.rollup.iterationCount} / ${max ?? "—"}`;
};

const errorDetail = (s: SessionView): string | null => {
  if (s.outcome !== "errored" && s.outcome !== "halted") return null;
  const last = s.errors[s.errors.length - 1];
  if (last) return `${last.kind}: ${last.reason}`;
  return s.outcome === "halted"
    ? "autopilot halted"
    : "agent error — see session detail";
};

const sumCommits = (sessions: ReadonlyArray<SessionView>): number =>
  sessions.reduce((n, s) => n + s.commits.length, 0);

const outcomeBreakdown = (
  sessions: ReadonlyArray<SessionView>,
): {
  done: number;
  errored: number;
  halted: number;
  running: number;
} => {
  const out = { done: 0, errored: 0, halted: 0, running: 0 };
  for (const s of sessions) {
    if (s.outcome === "done") out.done += 1;
    else if (s.outcome === "errored") out.errored += 1;
    else if (s.outcome === "halted") out.halted += 1;
    else out.running += 1;
  }
  return out;
};

const formatBreakdown = (
  parts: ReadonlyArray<readonly [number, string]>,
): string =>
  parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(" · ");

export const TicketDetailPage = (): ReactElement => {
  const { ticketId } = useParams<{ ticketId: string }>();
  const [data, setData] = useState<TicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ticketId) return;
    let cancelled = false;
    fetchTicket(ticketId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  // Order sessions newest-first for display, while retaining chronological
  // numbering (Session #1 = first ever for this ticket).
  const orderedSessions = useMemo(() => {
    if (!data) return [];
    const indexed = data.sessions.map((s, i) => ({
      session: s,
      number: i + 1,
    }));
    return indexed.slice().reverse();
  }, [data]);

  if (!ticketId) {
    return (
      <main className="list-page">
        <p className="list-page__sub">No ticket id in URL.</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="list-page">
        <p className="list-page__sub">
          <Link to="/">← History</Link>
        </p>
        <div className="badge badge--error" data-testid="ticket-detail-error">
          Failed to load ticket: {error}
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="list-page">
        <p className="list-page__sub">Loading…</p>
      </main>
    );
  }

  const { rollup, sessions } = data;
  const breakdown = outcomeBreakdown(sessions);
  const lastSession = sessions[sessions.length - 1];
  const firstSession = sessions[0];
  const closedAt = (() => {
    let latest: number | undefined;
    for (const s of sessions) {
      if (s.outcome === "done" && s.endedAt !== undefined) {
        if (latest === undefined || s.endedAt > latest) latest = s.endedAt;
      }
    }
    return latest;
  })();
  const totalCommits = sumCommits(sessions);

  return (
    <main className="list-page">
      <header className="list-page__header">
        <div>
          <p className="list-page__sub" style={{ marginBottom: 4 }}>
            <Link to="/">← History</Link>
          </p>
          <h1 className="list-page__title">Ticket detail</h1>
        </div>
      </header>

      <section
        className="ticket-card"
        aria-label="Ticket summary"
        data-testid="ticket-card"
      >
        <div className="ticket-card__top">
          <div className="ticket-card__row">
            <span className="ticket-card__id">{ticketId}</span>
            <span className="ticket-card__title" />
            {lastSession && outcomeBadge(lastSession.outcome)}
          </div>
          <div className="ticket-card__meta">
            {firstSession && (
              <>First session: {formatStartedAt(firstSession.startedAt)}</>
            )}
            {closedAt !== undefined && (
              <>
                {" "}
                · Closed: {formatStartedAt(closedAt)} · Time-to-close:{" "}
                <strong data-testid="time-to-close">
                  {formatLongDuration(rollup.timeToCloseMs)}
                </strong>
              </>
            )}
          </div>
        </div>

        <div
          className="ticket-aggregates"
          role="group"
          aria-label="Ticket aggregates"
        >
          <div className="metric" data-testid="metric-sessions">
            <span className="metric__label">Sessions</span>
            <span className="metric__value">{rollup.sessionCount}</span>
            <span className="metric__sub">
              {formatBreakdown([
                [breakdown.done, "done"],
                [breakdown.errored, "errored"],
                [breakdown.halted, "halted"],
                [breakdown.running, "running"],
              ]) || "—"}
            </span>
          </div>
          <div className="metric" data-testid="metric-wall-time">
            <span className="metric__label">Total wall time</span>
            <span className="metric__value">
              {formatLongDuration(rollup.totalWallTimeMs)}
            </span>
            <span className="metric__sub">across all sessions</span>
          </div>
          <div className="metric" data-testid="metric-avg-iterations">
            <span className="metric__label">Avg iterations</span>
            <span className="metric__value">
              {rollup.averageIterationsPerSession.toFixed(1)}
            </span>
            <span className="metric__sub">per session</span>
          </div>
          <div className="metric" data-testid="metric-commits">
            <span className="metric__label">Total commits</span>
            <span className="metric__value">{totalCommits}</span>
            <span className="metric__sub">across all sessions</span>
          </div>
          <div className="metric" data-testid="metric-tokens">
            <span className="metric__label">Total tokens</span>
            <span className="metric__value">
              {formatTokens(rollup.totalTokens)}
            </span>
            <span className="metric__sub">
              in {rollup.totalTokens.input.toLocaleString()} · out{" "}
              {rollup.totalTokens.output.toLocaleString()}
            </span>
          </div>
        </div>
      </section>

      <section
        className="session-list"
        aria-label="Sessions for this ticket"
        data-testid="ticket-sessions"
      >
        <header className="session-list__head" role="row">
          <span>Status</span>
          <span>Session</span>
          <span>Started</span>
          <span>Duration</span>
          <span>Iter.</span>
          <span>Commits</span>
          <span>Tokens</span>
          <span />
        </header>

        {orderedSessions.map(({ session: s, number }) => {
          const errored = s.outcome === "errored" || s.outcome === "halted";
          const detail = errorDetail(s);
          return (
            <Link
              to={`/sessions/${encodeURIComponent(s.sessionId)}`}
              key={s.sessionId}
              className={`session-row${errored ? " session-row--errored" : ""}`}
              role="row"
              data-testid={`ticket-session-row-${s.sessionId}`}
            >
              <span>{outcomeBadge(s.outcome)}</span>
              <span className="session-row__ticket-cell">
                <span className="session-row__ticket">Session #{number}</span>
                <span className="session-row__title">
                  <code>{s.sessionId}</code> — {s.scenario}
                </span>
              </span>
              <span className="session-row__started">
                {formatStartedAt(s.startedAt)}
              </span>
              <span className="session-row__num">
                {formatDuration(s.rollup.wallTimeMs)}
              </span>
              <span className="session-row__num">{formatIterations(s)}</span>
              <span className="session-row__num">{s.commits.length}</span>
              <span className="session-row__num">
                {formatTokens(s.rollup.totalTokens)}
              </span>
              <span className="session-row__actions">
                <span
                  className="btn btn--ghost"
                  aria-label="Open session"
                  title="Open session"
                >
                  ↗
                </span>
              </span>
              {errored && detail && (
                <span className="session-row__error-detail">{detail}</span>
              )}
            </Link>
          );
        })}
      </section>
    </main>
  );
};
