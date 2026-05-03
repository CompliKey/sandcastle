import { useState, type ReactElement } from "react";

import type { SessionIterationView } from "../api.js";

const PRETTY_THRESHOLD = 200; // chars — pretty-print only if formatted args fits.
const LONG_OUTPUT_LINE_THRESHOLD = 30;

const prettifyJson = (raw: string): string => {
  if (raw.length > PRETTY_THRESHOLD) return raw;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};

const summary = (raw: string): string => {
  const compact = raw.replace(/\s+/g, " ").trim();
  if (compact.length <= 80) return compact;
  return `${compact.slice(0, 77)}…`;
};

interface ToolCallCardProps {
  readonly toolCall: SessionIterationView["toolCalls"][number];
}

export const ToolCallCard = ({ toolCall }: ToolCallCardProps): ReactElement => {
  const [collapsed, setCollapsed] = useState(true);
  const lineCount = toolCall.formattedArgs.split("\n").length;
  const isLong = lineCount > LONG_OUTPUT_LINE_THRESHOLD;

  return (
    <article className={`tool-card${collapsed ? " tool-card--collapsed" : ""}`}>
      <header
        className="tool-card__header"
        onClick={() => setCollapsed((c) => !c)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setCollapsed((c) => !c);
          }
        }}
      >
        <span className="tool-card__chevron">{collapsed ? "▸" : "▾"}</span>
        <span className="tool-card__name">{toolCall.toolName}</span>
        <span className="tool-card__summary">
          {summary(toolCall.formattedArgs)}
        </span>
      </header>
      <div className="tool-card__body">
        <div>
          <div className="tool-card__section-label">Arguments</div>
          {isLong && collapsed ? (
            <button
              type="button"
              className="disclosure"
              onClick={(e) => {
                e.stopPropagation();
                setCollapsed(false);
              }}
            >
              {lineCount} lines — click to expand
            </button>
          ) : (
            <pre className="tool-card__pre">
              {prettifyJson(toolCall.formattedArgs)}
            </pre>
          )}
        </div>
      </div>
    </article>
  );
};
