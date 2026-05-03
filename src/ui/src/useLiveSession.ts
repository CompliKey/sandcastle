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

export interface UseLiveSessionResult {
  view: SessionView | null;
  error: string | null;
  connected: boolean;
}

const buildWsUrl = (sessionId: string): string => {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws?session=${encodeURIComponent(sessionId)}`;
};

export const useLiveSession = (
  sessionId: string | undefined,
): UseLiveSessionResult => {
  const [view, setView] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  // Hold a ref to the latest view so the message handler closure can read it
  // without re-binding on every state change.
  const viewRef = useRef<SessionView | null>(null);
  viewRef.current = view;

  useEffect(() => {
    if (!sessionId) return;
    setView(null);
    setError(null);
    setConnected(false);

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

  return { view, error, connected };
};
