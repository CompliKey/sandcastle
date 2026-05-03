/**
 * EventBroadcaster — in-process pub/sub for {@link SandcastleEvent}s.
 *
 * The producer (orchestration loop) calls {@link EventBroadcaster.publish}
 * after each call to {@link EventStore.append}. Subscribers (UI server WS
 * connections) receive matching events synchronously.
 *
 * Channels
 * - `session:<id>` — events scoped to one session.
 * - `lane:<id>`    — events scoped to one autopilot lane.
 * - `all`          — firehose; receives every event.
 *
 * No I/O. No persistence. {@link EventStore} is the source of truth — this
 * is the live notification layer alongside it.
 */

import type { SandcastleEvent } from "./EventStore.js";

export type ChannelKey =
  | { readonly type: "session"; readonly id: string }
  | { readonly type: "lane"; readonly id: string }
  | { readonly type: "all" };

export type EventSink = (event: SandcastleEvent) => void;

export interface EventBroadcaster {
  publish(event: SandcastleEvent): void;
  subscribe(channel: ChannelKey, sink: EventSink): () => void;
}

export const createEventBroadcaster = (
  options: { readonly onSubscriberError?: (err: unknown) => void } = {},
): EventBroadcaster => {
  const sessionSinks = new Map<string, Set<EventSink>>();
  const laneSinks = new Map<string, Set<EventSink>>();
  const allSinks = new Set<EventSink>();
  const onSubscriberError = options.onSubscriberError;

  const fanOut = (sinks: Iterable<EventSink>, event: SandcastleEvent): void => {
    for (const sink of sinks) {
      try {
        sink(event);
      } catch (err) {
        // A bad subscriber must not poison delivery to the others.
        onSubscriberError?.(err);
      }
    }
  };

  const publish = (event: SandcastleEvent): void => {
    fanOut(allSinks, event);
    const ls = laneSinks.get(event.laneId);
    if (ls) fanOut(ls, event);
    if ("sessionId" in event) {
      const ss = sessionSinks.get(event.sessionId);
      if (ss) fanOut(ss, event);
    }
  };

  const addToBucket = (
    map: Map<string, Set<EventSink>>,
    key: string,
    sink: EventSink,
  ): (() => void) => {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = new Set();
      map.set(key, bucket);
    }
    bucket.add(sink);
    // Look up the bucket by key at unsubscribe time rather than closing over
    // it: if the original bucket was deleted (last subscriber left) and a
    // new subscriber re-created it, a stale unsubscribe must not delete the
    // new one out from under them.
    return () => {
      const current = map.get(key);
      if (!current) return;
      current.delete(sink);
      if (current.size === 0) map.delete(key);
    };
  };

  const subscribe = (channel: ChannelKey, sink: EventSink): (() => void) => {
    switch (channel.type) {
      case "session":
        return addToBucket(sessionSinks, channel.id, sink);
      case "lane":
        return addToBucket(laneSinks, channel.id, sink);
      case "all":
        allSinks.add(sink);
        return () => {
          allSinks.delete(sink);
        };
    }
  };

  return { publish, subscribe };
};
