/**
 * useAutoscrollPin — pin scroll-to-bottom while the user is near the bottom,
 * release pinning as soon as they scroll up. When pinned, calling
 * `bumpToBottom()` (typically after new content lands) snaps to the bottom.
 *
 * Returns:
 * - `pinned`: current pin state, surfaced to the UI as a "scroll up to pause"
 *   / "click to resume" affordance.
 * - `containerRef`: attach to the scrollable element.
 * - `bumpToBottom()`: idempotent; only scrolls if pinned. Call from a layout
 *   effect after content updates.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { isAtBottom } from "./computePinned.js";

export interface UseAutoscrollPinResult<
  T extends HTMLElement = HTMLDivElement,
> {
  pinned: boolean;
  containerRef: React.RefObject<T | null>;
  bumpToBottom: () => void;
}

export const useAutoscrollPin = <T extends HTMLElement = HTMLDivElement>(
  options: { thresholdPx?: number } = {},
): UseAutoscrollPinResult<T> => {
  const containerRef = useRef<T | null>(null);
  const [pinned, setPinned] = useState(true);

  // Mirror `pinned` into a ref so `bumpToBottom` keeps a stable identity even
  // as the user scrolls. Without this the callback is recreated on every
  // pin-state change, causing every layout effect that depends on it to
  // re-fire on each scroll event.
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  const bumpToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = (): void => {
      const atBottom = isAtBottom(
        {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        },
        { thresholdPx: options.thresholdPx },
      );
      setPinned(atBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [options.thresholdPx]);

  return { pinned, containerRef, bumpToBottom };
};
