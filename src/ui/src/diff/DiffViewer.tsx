import { type ReactElement } from "react";

import {
  parseUnifiedDiff,
  projectSideBySide,
  type DiffHunk,
  type DiffLine,
  type SideBySideRow,
} from "./parseUnifiedDiff.js";

export type DiffLayout = "unified" | "side-by-side";

interface DiffViewerProps {
  readonly diff: string;
  readonly layout: DiffLayout;
  readonly sha: string;
}

const lineClass = (kind: DiffLine["kind"]): string => {
  switch (kind) {
    case "hunk":
      return "diff-line diff-line--hunk";
    case "add":
      return "diff-line diff-line--add";
    case "del":
      return "diff-line diff-line--del";
    case "context":
    default:
      return "diff-line";
  }
};

const lineNumberCell = (n: number | undefined): string =>
  n === undefined ? "" : String(n);

const renderLine = (line: DiffLine, side: "old" | "new"): ReactElement => {
  const num = side === "old" ? line.oldNum : line.newNum;
  return (
    <>
      <span className="diff-line__num">{lineNumberCell(num)}</span>
      <span className="diff-line__code">{line.text || " "}</span>
    </>
  );
};

const renderEmptyLine = (): ReactElement => (
  <>
    <span className="diff-line__num"></span>
    <span className="diff-line__code">{" "}</span>
  </>
);

const Unified = ({ hunks }: { hunks: DiffHunk[] }): ReactElement => (
  <div className="diff-pane">
    <div className="diff-side">
      {hunks.map((h, hi) => (
        <div key={hi}>
          {h.lines.map((l, li) => (
            <div key={li} className={lineClass(l.kind)}>
              <span className="diff-line__num">
                {l.kind === "hunk"
                  ? ""
                  : `${lineNumberCell(l.oldNum)}${
                      l.oldNum && l.newNum ? "/" : ""
                    }${lineNumberCell(l.newNum)}`}
              </span>
              <span className="diff-line__code">{l.text || " "}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  </div>
);

const SideBySide = ({
  hunks,
  sha,
}: {
  hunks: DiffHunk[];
  sha: string;
}): ReactElement => {
  const rows: SideBySideRow[] = hunks.flatMap((h) =>
    projectSideBySide(h.lines),
  );
  return (
    <div className="diff-pane">
      <div className="diff-side">
        <header className="diff-side__header">
          {sha.slice(0, 7)}^ · before
        </header>
        {rows.map((r, i) => {
          if (r.left?.kind === "hunk") {
            return (
              <div key={i} className="diff-line diff-line--hunk">
                <span className="diff-line__num"></span>
                <span className="diff-line__code">{r.left.text}</span>
              </div>
            );
          }
          if (!r.left) {
            return (
              <div key={i} className="diff-line diff-line--empty">
                {renderEmptyLine()}
              </div>
            );
          }
          return (
            <div key={i} className={lineClass(r.left.kind)}>
              {renderLine(r.left, "old")}
            </div>
          );
        })}
      </div>
      <div className="diff-side">
        <header className="diff-side__header">{sha.slice(0, 7)} · after</header>
        {rows.map((r, i) => {
          if (r.right?.kind === "hunk") {
            return (
              <div key={i} className="diff-line diff-line--hunk">
                <span className="diff-line__num"></span>
                <span className="diff-line__code">{r.right.text}</span>
              </div>
            );
          }
          if (!r.right) {
            return (
              <div key={i} className="diff-line diff-line--empty">
                {renderEmptyLine()}
              </div>
            );
          }
          return (
            <div key={i} className={lineClass(r.right.kind)}>
              {renderLine(r.right, "new")}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const DiffViewer = ({
  diff,
  layout,
  sha,
}: DiffViewerProps): ReactElement => {
  const hunks = parseUnifiedDiff(diff);
  if (hunks.length === 0) {
    return (
      <div className="diff-pane">
        <p className="list-page__sub" style={{ padding: 16 }}>
          No textual diff (binary file or empty change).
        </p>
      </div>
    );
  }
  return layout === "unified" ? (
    <Unified hunks={hunks} />
  ) : (
    <SideBySide hunks={hunks} sha={sha} />
  );
};
