import { useEffect, useState, type ReactElement } from "react";
import { Link, useParams } from "react-router-dom";

import { fetchSession, type SessionView } from "../api.js";
import { LiveSessionView } from "../live/LiveSessionView.js";

/**
 * Session detail route — `/sessions/:id`.
 *
 * The same `LiveSessionView` component renders both live (event-streamed) and
 * historical (REST-snapshot) sessions. We branch on whether the session has
 * already finished: if `outcome` is set, hand a one-shot snapshot to the
 * component; otherwise let it open a WS for live updates.
 */
export const SessionDetailPage = (): ReactElement => {
  const { id } = useParams<{ id: string }>();
  const [snapshot, setSnapshot] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetchSession(id)
      .then((s) => {
        if (!cancelled) setSnapshot(s);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!id) {
    return (
      <main className="list-page">
        <p className="list-page__sub">No session id in URL.</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="list-page">
        <p className="list-page__sub">
          <Link to="/">← History</Link>
        </p>
        <div className="badge badge--error">Failed to load: {error}</div>
      </main>
    );
  }

  if (!snapshot) {
    return (
      <main className="list-page">
        <p className="list-page__sub">Loading…</p>
      </main>
    );
  }

  // If the session has finished, render once from the REST snapshot.
  // Otherwise let LiveSessionView open a WS and stream updates.
  return (
    <LiveSessionView
      sessionId={id}
      historical={snapshot.outcome !== undefined ? snapshot : undefined}
    />
  );
};
