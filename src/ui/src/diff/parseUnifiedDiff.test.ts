import { describe, expect, it } from "vitest";

import { parseUnifiedDiff, projectSideBySide } from "./parseUnifiedDiff.js";

const sample = `diff --git a/hello.ts b/hello.ts
index 1111111..2222222 100644
--- a/hello.ts
+++ b/hello.ts
@@ -1,3 +1,4 @@
 export const hello = 'world';
-export const greeting = 'hi';
+export const greeting = 'hello';
+export const goodbye = 'moon';
 export const farewell = 'bye';
`;

describe("parseUnifiedDiff", () => {
  it("parses a single-hunk diff with mixed adds/dels/context", () => {
    const hunks = parseUnifiedDiff(sample);
    expect(hunks).toHaveLength(1);
    const [h] = hunks;
    expect(h!.oldStart).toBe(1);
    expect(h!.oldCount).toBe(3);
    expect(h!.newStart).toBe(1);
    expect(h!.newCount).toBe(4);
    const kinds = h!.lines.map((l) => l.kind);
    expect(kinds).toEqual(["hunk", "context", "del", "add", "add", "context"]);
  });

  it("assigns line numbers per side", () => {
    const hunks = parseUnifiedDiff(sample);
    const lines = hunks[0]!.lines;
    // First context line: old=1, new=1
    expect(lines[1]).toMatchObject({ kind: "context", oldNum: 1, newNum: 1 });
    // Deletion: old=2, new=undefined
    expect(lines[2]).toMatchObject({ kind: "del", oldNum: 2 });
    expect(lines[2]!.newNum).toBeUndefined();
    // First add: new=2
    expect(lines[3]).toMatchObject({ kind: "add", newNum: 2 });
    // Trailing context: old=3, new=4
    expect(lines[5]).toMatchObject({ kind: "context", oldNum: 3, newNum: 4 });
  });

  it("returns [] for an empty patch", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("skips '\\ No newline at end of file' markers", () => {
    const patch = `@@ -1 +1 @@
-foo
+bar
\\ No newline at end of file
`;
    const [h] = parseUnifiedDiff(patch);
    expect(h!.lines.map((l) => l.kind)).toEqual(["hunk", "del", "add"]);
  });
});

describe("projectSideBySide", () => {
  it("pairs consecutive del/add runs into aligned rows", () => {
    const hunks = parseUnifiedDiff(sample);
    const rows = projectSideBySide(hunks[0]!.lines);
    // Row 0: hunk header (both sides)
    // Row 1: context (both sides)
    // Row 2: del paired with first add
    // Row 3: empty-left filler with second add
    // Row 4: trailing context
    expect(rows[2]!.left?.kind).toBe("del");
    expect(rows[2]!.right?.kind).toBe("add");
    expect(rows[3]!.left).toBeUndefined();
    expect(rows[3]!.right?.kind).toBe("add");
  });

  it("places a lone deletion on the left only", () => {
    const patch = `@@ -1,2 +1 @@
 keep
-drop
`;
    const [h] = parseUnifiedDiff(patch);
    const rows = projectSideBySide(h!.lines);
    const lastRow = rows[rows.length - 1]!;
    expect(lastRow.left?.kind).toBe("del");
    expect(lastRow.right).toBeUndefined();
  });
});
