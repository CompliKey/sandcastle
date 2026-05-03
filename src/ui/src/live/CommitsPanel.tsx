import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Link } from "react-router-dom";

import {
  fetchCommit,
  type CommitFileChange,
  type CommitMetadata,
  type SessionView,
} from "../api.js";

interface CommitsPanelProps {
  readonly sessionId: string;
  readonly commits: SessionView["commits"];
}

type Status = "pending" | "loading" | "ready" | "error";
interface CommitState {
  status: Status;
  meta?: CommitMetadata;
  error?: string;
}

const formatTime = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const shortSha = (sha: string): string => sha.slice(0, 7);

/**
 * Sidebar panel listing commits made during a session, matching the Slice 0
 * wireframe. Click a commit row to expand its file list (lazy-fetches
 * metadata via /api/sessions/:id/commits/:sha). Click a file to navigate to
 * the diff route.
 */
export const CommitsPanel = ({
  sessionId,
  commits,
}: CommitsPanelProps): ReactElement => {
  // commits arrive newest-last from the event stream; show newest-first.
  const ordered = useMemo(() => [...commits].reverse(), [commits]);
  const [activeSha, setActiveSha] = useState<string | null>(null);
  const [byShas, setByShas] = useState<Record<string, CommitState>>({});

  // Fetch metadata for whichever commit is active. Cache results so re-clicks
  // are instant and so a re-render after a new commit arrives doesn't redo
  // the work for already-loaded commits.
  useEffect(() => {
    if (!activeSha) return;
    const current = byShas[activeSha];
    if (current && current.status !== "pending") return;

    let cancelled = false;
    setByShas((prev) => ({ ...prev, [activeSha]: { status: "loading" } }));
    fetchCommit(sessionId, activeSha)
      .then((meta) => {
        if (cancelled) return;
        setByShas((prev) => ({
          ...prev,
          [activeSha]: { status: "ready", meta },
        }));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setByShas((prev) => ({
          ...prev,
          [activeSha]: {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          },
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [activeSha, sessionId, byShas]);

  const onCommitClick = (sha: string): void => {
    setActiveSha((prev) => (prev === sha ? null : sha));
  };

  return (
    <aside className="commits" aria-label="Commits in this session">
      <div className="commits__header">
        <span className="commits__header__title">Commits</span>
        <span className="commits__header__count">
          {ordered.length === 0
            ? "none yet"
            : `${ordered.length} in this session`}
        </span>
      </div>
      {ordered.length === 0 ? (
        <p
          className="list-page__sub"
          style={{ padding: "12px 16px", margin: 0 }}
        >
          No commits yet — they appear as the agent makes them.
        </p>
      ) : (
        <ul className="commits__list">
          {ordered.map((c) => {
            const active = c.sha === activeSha;
            const state = byShas[c.sha];
            return (
              <li
                key={c.sha}
                className={`commit${active ? " commit--active" : ""}`}
                onClick={() => onCommitClick(c.sha)}
              >
                <span className="commit__sha">{shortSha(c.sha)}</span>
                <span className="commit__msg">
                  {state?.meta?.subject ?? "Loading…"}
                </span>
                <span className="commit__meta">
                  {state?.meta
                    ? `${state.meta.files.length} file${
                        state.meta.files.length === 1 ? "" : "s"
                      } · ${formatTime(c.timestamp)}`
                    : formatTime(c.timestamp)}
                </span>
                {active && state?.status === "loading" && (
                  <span className="commit__meta">Loading commit details…</span>
                )}
                {active && state?.status === "error" && (
                  <span className="commit__meta">Error: {state.error}</span>
                )}
                {active && state?.meta && (
                  <CommitFiles
                    sessionId={sessionId}
                    sha={c.sha}
                    files={state.meta.files}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
};

interface CommitFilesProps {
  readonly sessionId: string;
  readonly sha: string;
  readonly files: ReadonlyArray<CommitFileChange>;
}

const CommitFiles = ({
  sessionId,
  sha,
  files,
}: CommitFilesProps): ReactElement => (
  <ul
    className="commit__files"
    onClick={(e) => {
      // Don't collapse the parent commit when clicking a file link.
      e.stopPropagation();
    }}
  >
    {files.map((f) => (
      <li key={f.path} className="commit__file">
        <span className="commit__file__status">{f.status}</span>
        <Link
          to={`/sessions/${encodeURIComponent(sessionId)}/commits/${encodeURIComponent(
            sha,
          )}/diff?path=${encodeURIComponent(f.path)}`}
        >
          {f.path}
        </Link>
      </li>
    ))}
  </ul>
);
