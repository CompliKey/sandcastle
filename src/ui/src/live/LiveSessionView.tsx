import { useEffect, useLayoutEffect, type ReactElement } from "react";
import { Link } from "react-router-dom";

import type { SessionView } from "../api.js";
import { formatStartedAt } from "../format.js";
import { useLiveSession } from "../useLiveSession.js";
import { IterationSection } from "./IterationSection.js";
import { MetricsHeader } from "./MetricsHeader.js";
import { useAutoscrollPin } from "./useAutoscrollPin.js";

interface LiveSessionViewProps {
  readonly sessionId: string;
  /** When `historical` is supplied, render that view and skip the WS feed. */
  readonly historical?: SessionView;
  /**
   * Optional REST-fetched starting view for live sessions. Lets the UI render
   * immediately while the WS handshake completes instead of showing a
   * "Connecting…" spinner during a second round-trip.
   */
  readonly initialView?: SessionView;
}

const isErrored = (view: SessionView, iterationNum: number): boolean =>
  view.errors.some((e) => e.kind.startsWith(`iter-${iterationNum}`)) ||
  (view.outcome === "errored" &&
    iterationNum === view.iterations.length &&
    view.endedAt !== undefined);

export const LiveSessionView = ({
  sessionId,
  historical,
  initialView,
}: LiveSessionViewProps): ReactElement => {
  const live = useLiveSession(historical ? undefined : sessionId, initialView);
  const view = historical ?? live.view;
  const isLive = !historical;
  const { pinned, containerRef, bumpToBottom } =
    useAutoscrollPin<HTMLDivElement>();

  // Snap to bottom whenever the iterations array length changes — that is
  // the cheapest "new content arrived" signal we have without diffing.
  const iterationCount = view?.iterations.length ?? 0;
  const lastToolCallTs =
    view?.iterations[view.iterations.length - 1]?.toolCalls.slice(-1)[0]
      ?.timestamp ?? 0;
  useLayoutEffect(() => {
    bumpToBottom();
  }, [iterationCount, lastToolCallTs, bumpToBottom]);

  // After connect, if pinned, jump to the bottom of any pre-existing content.
  useEffect(() => {
    if (view) bumpToBottom();
  }, [view?.sessionId, bumpToBottom, view]);

  if (live.error && !view) {
    return (
      <main className="list-page">
        <header className="list-page__header">
          <p className="list-page__sub">
            <Link to="/">← History</Link>
          </p>
        </header>
        <div className="badge badge--error">Live feed error: {live.error}</div>
      </main>
    );
  }

  if (!view) {
    return (
      <main className="list-page">
        <p className="list-page__sub">Connecting…</p>
      </main>
    );
  }

  const running = view.outcome === undefined;
  const statusBadge = running
    ? { label: "running", cls: "badge--accent" }
    : view.outcome === "done"
      ? { label: "done", cls: "badge--success" }
      : view.outcome === "errored"
        ? { label: "errored", cls: "badge--error" }
        : { label: "halted", cls: "badge--warn" };

  return (
    <>
      <div className="session-header">
        <span className="session-header__ticket">{view.ticketId}</span>
        <span className="session-header__title">
          Session {view.sessionId.slice(0, 14)}
          {view.sessionId.length > 14 ? "…" : ""}
        </span>
        <span className={`badge ${statusBadge.cls}`}>{statusBadge.label}</span>
        <span className="session-header__meta">
          started {formatStartedAt(view.startedAt)} · scenario {view.scenario}
        </span>
        <div className="session-header__actions">
          <Link to="/" className="btn btn--ghost">
            ← History
          </Link>
        </div>
      </div>

      <MetricsHeader view={view} live={isLive} />

      <div className="session-body">
        <main className="timeline" ref={containerRef}>
          {!pinned && isLive && (
            <div className="timeline__autoscroll-hint">
              <span className="badge">
                📌 autoscroll paused — scroll to bottom to resume
              </span>
            </div>
          )}
          {view.iterations.length === 0 ? (
            <p className="list-page__sub">
              No iterations yet — waiting for the agent to start.
            </p>
          ) : (
            view.iterations.map((it, idx) => {
              const isLast = idx === view.iterations.length - 1;
              const active =
                isLive && running && isLast && it.endedAt === undefined;
              return (
                <IterationSection
                  key={it.iteration}
                  iteration={it}
                  active={active}
                  errored={isErrored(view, it.iteration)}
                  defaultOpen={isLast}
                  commitCount={
                    idx === view.iterations.length - 1 ? view.commits.length : 0
                  }
                />
              );
            })
          )}
        </main>
      </div>
    </>
  );
};
