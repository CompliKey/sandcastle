/**
 * Tiny unified-diff parser sized for the diff viewer's needs.
 *
 * Input: the patch body produced by `git show <sha> -- <path>` (the full
 * output, including the "diff --git" header). Output: a list of hunks where
 * each line is classified as context / addition / deletion / hunk-header.
 *
 * Designed for rendering, not round-tripping — line numbers track each side
 * (old/new) so the side-by-side viewer can place additions next to "empty"
 * filler rows without re-deriving positions.
 */

export type DiffLineKind = "context" | "add" | "del" | "hunk";

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** Visible content (without the leading marker). */
  readonly text: string;
  /** Old-side line number, or undefined for additions/hunk headers. */
  readonly oldNum?: number;
  /** New-side line number, or undefined for deletions/hunk headers. */
  readonly newNum?: number;
}

export interface DiffHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: ReadonlyArray<DiffLine>;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export const parseUnifiedDiff = (raw: string): DiffHunk[] => {
  const out: DiffHunk[] = [];
  if (!raw) return out;

  const lines = raw.split("\n");
  let i = 0;

  // Skip the file header until the first hunk.
  while (i < lines.length && !lines[i]!.startsWith("@@")) i++;

  while (i < lines.length) {
    const header = lines[i]!;
    const m = HUNK_RE.exec(header);
    if (!m) {
      i++;
      continue;
    }
    const oldStart = Number.parseInt(m[1]!, 10);
    const oldCount = m[2] ? Number.parseInt(m[2], 10) : 1;
    const newStart = Number.parseInt(m[3]!, 10);
    const newCount = m[4] ? Number.parseInt(m[4], 10) : 1;
    const hunkLines: DiffLine[] = [{ kind: "hunk", text: header }];
    let oldCursor = oldStart;
    let newCursor = newStart;
    i++;
    while (i < lines.length && !lines[i]!.startsWith("@@")) {
      const line = lines[i]!;
      // Trailing empty element from String.split — drop it.
      if (line === "" && i === lines.length - 1) {
        i++;
        break;
      }
      // `\ No newline at end of file` markers — skip.
      if (line.startsWith("\\")) {
        i++;
        continue;
      }
      const marker = line[0];
      const body = line.slice(1);
      if (marker === "+") {
        hunkLines.push({ kind: "add", text: body, newNum: newCursor++ });
      } else if (marker === "-") {
        hunkLines.push({ kind: "del", text: body, oldNum: oldCursor++ });
      } else {
        hunkLines.push({
          kind: "context",
          text: marker === " " ? body : line,
          oldNum: oldCursor++,
          newNum: newCursor++,
        });
      }
      i++;
    }
    out.push({
      header,
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines: hunkLines,
    });
  }

  return out;
};

// ---------------------------------------------------------------------------
// Side-by-side projection
// ---------------------------------------------------------------------------

export interface SideBySideRow {
  readonly left?: DiffLine;
  readonly right?: DiffLine;
}

/**
 * Project a hunk into aligned left/right rows. Deletions land on the left
 * with an empty filler on the right (and vice versa for additions); a
 * paired delete-then-add run renders as left/right of the same row.
 */
export const projectSideBySide = (
  lines: ReadonlyArray<DiffLine>,
): SideBySideRow[] => {
  const rows: SideBySideRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind === "hunk") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === "del") {
      dels.push(lines[i]!);
      i++;
    }
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === "add") {
      adds.push(lines[i]!);
      i++;
    }
    const max = Math.max(dels.length, adds.length);
    for (let j = 0; j < max; j++) {
      rows.push({ left: dels[j], right: adds[j] });
    }
  }
  return rows;
};
