import { useEffect, useState, type ReactElement } from "react";

import type { SessionView } from "../api.js";
import { formatDuration, formatTokens } from "../format.js";

const TICK_MS = 1000;

const lastEventTimestamp = (view: SessionView): number => {
  let max = view.startedAt;
  for (const it of view.iterations) {
    if (it.startedAt && it.startedAt > max) max = it.startedAt;
    if (it.endedAt && it.endedAt > max) max = it.endedAt;
    for (const tc of it.toolCalls) if (tc.timestamp > max) max = tc.timestamp;
    for (const t of it.texts) if (t.timestamp > max) max = t.timestamp;
    for (const u of it.userLogs) if (u.timestamp > max) max = u.timestamp;
  }
  for (const c of view.commits) if (c.timestamp > max) max = c.timestamp;
  for (const e of view.errors) if (e.timestamp > max) max = e.timestamp;
  return max;
};

const formatRelative = (msAgo: number): string => {
  if (msAgo < 1000) return "just now";
  if (msAgo < 60_000) return `${Math.floor(msAgo / 1000)}s ago`;
  return `${Math.floor(msAgo / 60_000)}m ago`;
};

interface MetricsHeaderProps {
  readonly view: SessionView;
  readonly live: boolean;
}

export const MetricsHeader = ({
  view,
  live,
}: MetricsHeaderProps): ReactElement => {
  // Tick once per second so wall time + "last output" stay current while live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live || view.endedAt !== undefined) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [live, view.endedAt]);

  const wallTimeMs = view.endedAt
    ? (view.rollup.wallTimeMs ?? view.endedAt - view.startedAt)
    : Math.max(0, now - view.startedAt);

  const lastTs = lastEventTimestamp(view);
  const sinceLast = view.endedAt ? view.endedAt - lastTs : now - lastTs;

  const t = view.rollup.totalTokens;
  return (
    <div className="metrics-row" role="group" aria-label="Session metrics">
      <div className="metric">
        <span className="metric__label">Iteration</span>
        <span className="metric__value">{view.iterations.length}</span>
        <span className="metric__sub">elapsed</span>
      </div>
      <div className="metric">
        <span className="metric__label">Wall time</span>
        <span className="metric__value">{formatDuration(wallTimeMs)}</span>
        <span className="metric__sub">
          {view.endedAt ? "final" : "since start"}
        </span>
      </div>
      <div className="metric">
        <span className="metric__label">Last output</span>
        <span className="metric__value">{formatRelative(sinceLast)}</span>
        <span className="metric__sub">{view.endedAt ? "—" : "streaming"}</span>
      </div>
      <div className="metric">
        <span className="metric__label">Tokens in / out</span>
        <span className="metric__value">
          {formatTokens({
            input: t.input,
            output: 0,
            cacheCreation: 0,
            cacheRead: 0,
          })}
          {" / "}
          {formatTokens({
            input: 0,
            output: t.output,
            cacheCreation: 0,
            cacheRead: 0,
          })}
        </span>
        <span className="metric__sub">total this session</span>
      </div>
      <div className="metric">
        <span className="metric__label">Cache create / read</span>
        <span className="metric__value">
          {formatTokens({
            input: 0,
            output: 0,
            cacheCreation: t.cacheCreation,
            cacheRead: 0,
          })}
          {" / "}
          {formatTokens({
            input: 0,
            output: 0,
            cacheCreation: 0,
            cacheRead: t.cacheRead,
          })}
        </span>
        <span className="metric__sub">total this session</span>
      </div>
      <div className="metric">
        <span className="metric__label">Commits</span>
        <span className="metric__value">{view.commits.length}</span>
        <span className="metric__sub">this session</span>
      </div>
    </div>
  );
};
