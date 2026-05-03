/**
 * useLiveSession — opens `/ws?session=<id>`, keeps a SessionView in sync with
 * the snapshot/event stream, and tears the connection down on unmount.
 *
 * Exit conditions
 * - `error` is set if the server replies `{type:"error"}` (e.g. unknown
 *   session) or the WebSocket closes before any snapshot arrives.
 * - `connected` flips false on close — useful for the metrics header to
 *   render a "disconnected" badge.
 */

import { useEffect, useRef, useState } from "react";

import { applyEventToView } from "./applyEventToView.js";
import type { LiveMessage, SessionView } from "./api.js";

/**
 * Snapshot of one config-file change reported over `/ws`. The hook
 * accumulates these (one entry per path; a re-change overwrites the
 * timestamp) and surfaces them via {@link UseLiveSessionResult.configChanges}.
 */
export interface ConfigChangeNotice {
  readonly path: string;
  readonly changedAt: number;
}

export interface UseLiveSessionResult {
  view: SessionView | null;
  error: string | null;
  connected: boolean;
  /**
   * Files that have changed on disk since the UI server started. Empty until
   * the first `config.changed` arrives. Sticky for the lifetime of the
   * connection — reverting a file does not clear an entry, because the
   * running session was already started under the old config.
   */
  configChanges: readonly ConfigChangeNotice[];
}

const buildWsUrl = (sessionId: string): string => {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws?session=${encodeURIComponent(sessionId)}`;
};

export const useLiveSession = (
  sessionId: string | undefined,
  initialView?: SessionView,
): UseLiveSessionResult => {
  const [view, setView] = useState<SessionView | null>(initialView ?? null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [configChanges, setConfigChanges] = useState<
    readonly ConfigChangeNotice[]
  >([]);

  // Hold a ref to the latest view so the message handler closure can read it
  // without re-binding on every state change.
  const viewRef = useRef<SessionView | null>(initialView ?? null);
  viewRef.current = view;

  // Capture the initialView for the effect without taking a dep on it: the
  // caller may pass a fresh object each render, but we only want to seed
  // once per sessionId.
  const initialViewRef = useRef(initialView);
  initialViewRef.current = initialView;

  useEffect(() => {
    if (!sessionId) return;
    setView(initialViewRef.current ?? null);
    viewRef.current = initialViewRef.current ?? null;
    setError(null);
    setConnected(false);
    // Reset on session change — a different live view starts with a clean
    // slate, even if the same UI-server process has seen earlier changes.
    setConfigChanges([]);
    let snapshotReceived = false;

    const ws = new WebSocket(buildWsUrl(sessionId));

    ws.addEventListener("open", () => setConnected(true));

    // Buffer events that arrive before the snapshot. The server contract is
    // snapshot-first, so this should normally stay empty; if it doesn't (e.g.
    // a server change reorders the protocol), buffering keeps the view
    // consistent instead of silently dropping events.
    const preSnapshot: LiveMessage[] = [];

    ws.addEventListener("message", (ev) => {
      let msg: LiveMessage;
      try {
        msg = JSON.parse(
          typeof ev.data === "string" ? ev.data : "",
        ) as LiveMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case "snapshot": {
          snapshotReceived = true;
          let next = msg.view;
          if (preSnapshot.length > 0) {
            // eslint-disable-next-line no-console
            console.warn(
              `[useLiveSession] ${preSnapshot.length} event(s) arrived before snapshot — replaying.`,
            );
            for (const buffered of preSnapshot) {
              if (buffered.type === "event") {
                next = applyEventToView(next, buffered.event);
              }
            }
            preSnapshot.length = 0;
          }
          setView(next);
          viewRef.current = next;
          return;
        }
        case "event": {
          // Until the WS snapshot arrives, buffer rather than apply on top
          // of an initialView (REST-snapshot) — the WS snapshot is the
          // authoritative starting point and may already include any event
          // that landed in the gap.
          if (!snapshotReceived) {
            preSnapshot.push(msg);
            return;
          }
          const current = viewRef.current;
          if (!current) {
            preSnapshot.push(msg);
            return;
          }
          const next = applyEventToView(current, msg.event);
          viewRef.current = next;
          setView(next);
          return;
        }
        case "config.changed":
          setConfigChanges((prev) => {
            const filtered = prev.filter((c) => c.path !== msg.path);
            return [...filtered, { path: msg.path, changedAt: msg.changedAt }];
          });
          return;
        case "error":
          setError(msg.reason);
          return;
      }
    });

    ws.addEventListener("close", () => setConnected(false));
    ws.addEventListener("error", () => {
      // The browser doesn't expose error details to JS for security reasons.
      setError((prev) => prev ?? "WebSocket connection error");
    });

    return () => {
      ws.close();
    };
  }, [sessionId]);

  return { view, error, connected, configChanges };
};
