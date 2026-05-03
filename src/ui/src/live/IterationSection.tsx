import { useState, type ReactElement } from "react";

import type { SessionIterationView } from "../api.js";
import { formatDuration } from "../format.js";
import { ToolCallCard } from "./ToolCallCard.js";

const tokenSum = (it: SessionIterationView): number =>
  it.usage
    ? it.usage.inputTokens +
      it.usage.outputTokens +
      it.usage.cacheCreationInputTokens +
      it.usage.cacheReadInputTokens
    : 0;

const formatTokenCount = (n: number): string => {
  if (n === 0) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
};

interface IterationSectionProps {
  readonly iteration: SessionIterationView;
  readonly active: boolean;
  readonly errored: boolean;
  readonly defaultOpen: boolean;
  readonly commitCount: number;
}

export const IterationSection = ({
  iteration,
  active,
  errored,
  defaultOpen,
  commitCount,
}: IterationSectionProps): ReactElement => {
  const [collapsed, setCollapsed] = useState(!defaultOpen);

  const status: { label: string; cls: string } = errored
    ? { label: "errored", cls: "badge--error" }
    : active
      ? { label: "in-flight", cls: "badge--accent" }
      : { label: "completed", cls: "badge--success" };

  const wallTime =
    iteration.startedAt !== undefined && iteration.endedAt !== undefined
      ? iteration.endedAt - iteration.startedAt
      : undefined;

  return (
    <section className={`iteration${collapsed ? " iteration--collapsed" : ""}`}>
      <header
        className="iteration__header"
        onClick={() => setCollapsed((c) => !c)}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setCollapsed((c) => !c);
          }
        }}
      >
        <span className="iteration__chevron">{collapsed ? "▸" : "▾"}</span>
        <span className="iteration__num">Iteration {iteration.iteration}</span>
        <span className={`badge ${status.cls}`}>{status.label}</span>
        <span className="iteration__meta">
          <span>
            {iteration.toolCalls.length} tool call
            {iteration.toolCalls.length === 1 ? "" : "s"}
          </span>
          <span>
            {commitCount} commit{commitCount === 1 ? "" : "s"}
          </span>
          <span>{formatDuration(wallTime)}</span>
          <span>{formatTokenCount(tokenSum(iteration))} tokens</span>
        </span>
      </header>
      <div className="iteration__body">
        {iteration.toolCalls.length === 0 && iteration.texts.length === 0 ? (
          <p className="list-page__sub">No agent activity captured yet.</p>
        ) : (
          <>
            {iteration.toolCalls.map((tc, idx) => (
              <ToolCallCard key={`${tc.timestamp}-${idx}`} toolCall={tc} />
            ))}
          </>
        )}
      </div>
    </section>
  );
};
