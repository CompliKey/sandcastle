/**
 * Pure geometry helpers for autoscroll pinning. Extracted from
 * `useAutoscrollPin` so the tricky branch logic is unit-testable without
 * jsdom or RTL.
 */

export interface ScrollGeometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export interface IsAtBottomOptions {
  /**
   * How close to the absolute bottom (in pixels) still counts as "at bottom".
   * Default 32 — about one line of content. Tunable for dense / sparse views.
   */
  readonly thresholdPx?: number;
}

export const isAtBottom = (
  geometry: ScrollGeometry,
  options: IsAtBottomOptions = {},
): boolean => {
  const threshold = options.thresholdPx ?? 32;
  const distanceFromBottom =
    geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight;
  return distanceFromBottom <= threshold;
};
