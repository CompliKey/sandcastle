import { describe, expect, it } from "vitest";

import { formatDuration, formatLongDuration } from "./format.js";

describe("formatDuration", () => {
  it("renders mm:ss with zero padding", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(45_000)).toBe("00:45");
    expect(formatDuration(65_000)).toBe("01:05");
  });

  it("returns em-dash for undefined", () => {
    expect(formatDuration(undefined)).toBe("—");
  });
});

describe("formatLongDuration", () => {
  it("matches mm:ss under one hour", () => {
    expect(formatLongDuration(0)).toBe("00:00");
    expect(formatLongDuration(45_000)).toBe("00:45");
    expect(formatLongDuration(59 * 60_000)).toBe("59:00");
  });

  it("rolls over to hh:mm:ss at and beyond one hour", () => {
    expect(formatLongDuration(60 * 60_000)).toBe("01:00:00");
    // 02:43:00 — matches the wireframe time-to-close exemplar.
    expect(formatLongDuration((2 * 3600 + 43 * 60) * 1000)).toBe("02:43:00");
    expect(formatLongDuration((25 * 3600 + 1) * 1000)).toBe("25:00:01");
  });

  it("returns em-dash for undefined", () => {
    expect(formatLongDuration(undefined)).toBe("—");
  });
});
