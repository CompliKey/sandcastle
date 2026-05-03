import { useEffect, useState, type ReactElement } from "react";
import { Link, useParams } from "react-router-dom";

import { fetchSession, type SessionView } from "../api.js";

/**
 * Slice 7 placeholder. Slice 8 fills this in with the live iteration
 * timeline + tool-call cards. We render enough of the session header to
 * confirm the route works end-to-end and to give clickthrough something
 * meaningful.
 */
export const SessionDetailPage = (): ReactElement => {
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetchSession(id)
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <main className="list-page">
      <header className="list-page__header">
        <div>
          <p className="list-page__sub">
            <Link to="/">← History</Link>
          </p>
          <h1 className="list-page__title">Session {id}</h1>
          {session && (
            <p className="list-page__sub">
              Ticket <strong>{session.ticketId}</strong> · scenario{" "}
              <code>{session.scenario}</code> · outcome{" "}
              <strong>{session.outcome ?? "running"}</strong>
            </p>
          )}
        </div>
      </header>

      {error && (
        <div className="badge badge--error">Failed to load: {error}</div>
      )}

      {!session && !error && <p className="list-page__sub">Loading…</p>}

      {session && (
        <section className="list-page__sub">
          <p>
            The live iteration timeline and tool-call cards land in slice 8
            (VGD-141). This route exists today so the history list has somewhere
            to navigate to.
          </p>
          <ul>
            <li>
              <strong>Iterations:</strong> {session.iterations.length}
            </li>
            <li>
              <strong>Commits:</strong> {session.commits.length}
            </li>
            <li>
              <strong>Errors:</strong> {session.errors.length}
            </li>
          </ul>
        </section>
      )}
    </main>
  );
};
