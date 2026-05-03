import { describe, expect, it } from "vitest";

import { buildOverrides } from "./buildOverrides.js";

const empty = { model: "", maxIterations: "", promptArgsRaw: "" };

describe("buildOverrides", () => {
  it("returns an empty overrides object when every field is blank", () => {
    const result = buildOverrides(empty);
    expect(result).toEqual({ ok: true, overrides: {} });
  });

  it("trims whitespace from a non-blank model", () => {
    const result = buildOverrides({ ...empty, model: "  claude-opus-4-7  " });
    expect(result).toEqual({
      ok: true,
      overrides: { model: "claude-opus-4-7" },
    });
  });

  it("parses maxIterations as a positive integer", () => {
    const result = buildOverrides({ ...empty, maxIterations: "5" });
    expect(result).toEqual({ ok: true, overrides: { maxIterations: 5 } });
  });

  it("rejects zero / negative / non-integer maxIterations", () => {
    expect(buildOverrides({ ...empty, maxIterations: "0" }).ok).toBe(false);
    expect(buildOverrides({ ...empty, maxIterations: "-3" }).ok).toBe(false);
    expect(buildOverrides({ ...empty, maxIterations: "1.5" }).ok).toBe(false);
    expect(buildOverrides({ ...empty, maxIterations: "abc" }).ok).toBe(false);
  });

  it("parses promptArgsRaw as a JSON object", () => {
    const result = buildOverrides({
      ...empty,
      promptArgsRaw: '{"focusFiles": ["a.ts"]}',
    });
    expect(result).toEqual({
      ok: true,
      overrides: { promptArgs: { focusFiles: ["a.ts"] } },
    });
  });

  it("rejects malformed promptArgsRaw with a clear error", () => {
    const result = buildOverrides({
      ...empty,
      promptArgsRaw: "{ not: json }",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not valid JSON/i);
    }
  });

  it("rejects JSON that parses to an array (not a plain object)", () => {
    const result = buildOverrides({
      ...empty,
      promptArgsRaw: '["a","b"]',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/JSON object/i);
    }
  });

  it("rejects JSON that parses to null", () => {
    const result = buildOverrides({ ...empty, promptArgsRaw: "null" });
    expect(result.ok).toBe(false);
  });

  it("includes all three fields when all are populated", () => {
    const result = buildOverrides({
      model: "claude-sonnet-4-6",
      maxIterations: "8",
      promptArgsRaw: '{"k":"v"}',
    });
    expect(result).toEqual({
      ok: true,
      overrides: {
        model: "claude-sonnet-4-6",
        maxIterations: 8,
        promptArgs: { k: "v" },
      },
    });
  });
});
