import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import {
  fetchCommit,
  fetchFileDiff,
  type CommitMetadata,
  type FileDiff,
} from "../api.js";
import { DiffViewer, type DiffLayout } from "../diff/DiffViewer.js";

/**
 * Commit-diff route — `/sessions/:sessionId/commits/:sha/diff?path=...`.
 *
 * Layout matches the Slice 0 wireframe: a `.diff-files` sidebar listing every
 * file in the commit, plus a `.diff-main` pane with toolbar (path, +/− counts,
 * Unified/Side-by-side toggle) and the diff viewer.
 *
 * Both metadata and the unified diff text come from the UI server's REST
 * surface. They're fetched in parallel — neither blocks the other.
 */
export const CommitDiffPage = (): ReactElement => {
  const { sessionId, sha } = useParams<{
    sessionId: string;
    sha: string;
  }>();
  const [search, setSearch] = useSearchParams();
  const path = search.get("path");
  const [layout, setLayout] = useState<DiffLayout>("side-by-side");
  const [commit, setCommit] = useState<CommitMetadata | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId || !sha) return;
    let cancelled = false;
    setError(null);
    fetchCommit(sessionId, sha)
      .then((m) => {
        if (!cancelled) setCommit(m);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, sha]);

  useEffect(() => {
    if (!sessionId || !sha || !path) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiff(null);
    fetchFileDiff(sessionId, sha, path)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, sha, path]);

  const activePath = useMemo(() => path ?? "", [path]);

  if (!sessionId || !sha) {
    return (
      <main className="list-page">
        <p className="list-page__sub">Missing session id or commit sha.</p>
      </main>
    );
  }

  return (
    <div className="diff-shell">
      <aside className="diff-files" aria-label="Files in commit">
        <header className="diff-files__header">
          <Link
            to={`/sessions/${encodeURIComponent(sessionId)}`}
            style={{ fontSize: 12 }}
          >
            ← back to session
          </Link>
          <span className="diff-files__title">{sha.slice(0, 7)}</span>
          {commit && <span className="diff-files__sub">{commit.subject}</span>}
          {commit && (
            <span
              className="diff-files__sub"
              style={{ color: "var(--c-text-subtle)" }}
            >
              {commit.files.length} file
              {commit.files.length === 1 ? "" : "s"}
            </span>
          )}
        </header>
        {error && <div className="badge badge--error">Error: {error}</div>}
        {!commit ? (
          <p className="list-page__sub" style={{ padding: 12 }}>
            Loading…
          </p>
        ) : (
          <ul className="diff-files__list">
            {commit.files.map((f) => (
              <li
                key={f.path}
                className={`diff-files__item${
                  f.path === activePath ? " diff-files__item--active" : ""
                }`}
                onClick={() => {
                  setSearch({ path: f.path });
                }}
              >
                <span className="commit__file__status">{f.status}</span>
                <span className="diff-files__path">{f.path}</span>
                <span className="diff-files__counts">
                  {f.insertions !== undefined && (
                    <span className="diff-files__counts__add">
                      +{f.insertions}
                    </span>
                  )}
                  {f.deletions !== undefined && (
                    <span className="diff-files__counts__del">
                      −{f.deletions}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="diff-main" aria-label="File diff">
        <div className="diff-toolbar">
          <span className="diff-toolbar__path">{activePath || "—"}</span>
          {diff && (
            <span className="diff-files__counts">
              {diff.insertions !== undefined && (
                <span className="diff-files__counts__add">
                  +{diff.insertions}
                </span>
              )}
              {diff.deletions !== undefined && (
                <span className="diff-files__counts__del">
                  −{diff.deletions}
                </span>
              )}
            </span>
          )}
          <div className="toggle" role="group" aria-label="Diff layout">
            <button
              type="button"
              className="toggle__button"
              aria-pressed={layout === "unified"}
              onClick={() => setLayout("unified")}
            >
              Unified
            </button>
            <button
              type="button"
              className="toggle__button"
              aria-pressed={layout === "side-by-side"}
              onClick={() => setLayout("side-by-side")}
            >
              Side-by-side
            </button>
          </div>
        </div>

        {!path ? (
          <p className="list-page__sub" style={{ padding: 16 }}>
            Pick a file from the sidebar to see its diff.
          </p>
        ) : !diff ? (
          <p className="list-page__sub" style={{ padding: 16 }}>
            Loading diff…
          </p>
        ) : (
          <DiffViewer diff={diff.diff} layout={layout} sha={sha} />
        )}
      </section>
    </div>
  );
};
