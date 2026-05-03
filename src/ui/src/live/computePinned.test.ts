/**
 * Pure helper that decides whether autoscroll should be pinned based on the
 * scroll container's geometry.
 *
 * Pinned = "user is at (or near) the bottom and wants new content to keep
 * pulling them along". As soon as they scroll up, pinning releases.
 */

import { describe, expect, it } from "vitest";

import { isAtBottom } from "./computePinned.js";

describe("isAtBottom", () => {
  it("is true when scrolled exactly to the bottom", () => {
    expect(
      isAtBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 }),
    ).toBe(true);
  });

  it("is true within the threshold (default 32px)", () => {
    expect(
      isAtBottom({ scrollTop: 770, scrollHeight: 1000, clientHeight: 200 }),
    ).toBe(true);
  });

  it("is false when scrolled away beyond the threshold", () => {
    expect(
      isAtBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 200 }),
    ).toBe(false);
  });

  it("respects a custom threshold", () => {
    expect(
      isAtBottom(
        { scrollTop: 700, scrollHeight: 1000, clientHeight: 200 },
        { thresholdPx: 100 },
      ),
    ).toBe(true);
  });

  it("is true when the content fits in the viewport", () => {
    // No scrollable area → user is implicitly at the bottom.
    expect(
      isAtBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 400 }),
    ).toBe(true);
  });
});
