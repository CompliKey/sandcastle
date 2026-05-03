/**
 * LiveEventBridge — pumps new events from the on-disk {@link EventStore}
 * into both the in-memory {@link SessionIndex} (so REST snapshots stay
 * current) and the {@link EventBroadcaster} (so live WS subscribers get
 * notified). Polls `EventStore.tail()` until its `signal` aborts.
 *
 * Decoupling rationale: the producer (`sandcastle autopilot`,
 * `run-scenario`, etc.) lives in a separate process from the UI server,
 * so an in-process pub/sub between producer and broadcaster isn't
 * available. The disk is the bus.
 */

import type { EventBroadcaster } from "./EventBroadcaster.js";
import type { EventCursor, EventStore } from "./EventStore.js";
import type { SessionIndex } from "./SessionIndex.js";

export interface LiveEventBridgeOptions {
  readonly store: EventStore;
  readonly index: SessionIndex;
  readonly broadcaster: EventBroadcaster;
  readonly signal: AbortSignal;
  /** Forwarded to {@link EventStore.tail}. Defaults to its own default. */
  readonly pollIntervalMs?: number;
  /** Resume from a specific cursor; defaults to start-of-log. */
  readonly since?: EventCursor;
  /** Per-event error sink — bridge keeps running on subscriber failures. */
  readonly onError?: (err: unknown) => void;
}

/**
 * Start the bridge. Returns a Promise that resolves when the signal aborts
 * and the underlying tail loop unwinds.
 */
export const startLiveEventBridge = async (
  options: LiveEventBridgeOptions,
): Promise<void> => {
  try {
    for await (const { event } of options.store.tail({
      signal: options.signal,
      since: options.since,
      pollIntervalMs: options.pollIntervalMs,
    })) {
      try {
        options.index.add(event);
      } catch (err) {
        options.onError?.(err);
      }
      try {
        options.broadcaster.publish(event);
      } catch (err) {
        options.onError?.(err);
      }
    }
  } catch (err) {
    if (!options.signal.aborted) options.onError?.(err);
  }
};
