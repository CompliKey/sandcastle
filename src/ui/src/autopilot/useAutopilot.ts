/**
 * useAutopilot — polls `GET /api/autopilot` and exposes start / stop / resume
 * mutators. Polling is the simplest live channel for a localhost UI; the loop
 * mutates state at human timescales (a few seconds between transitions), and
 * the handful of transition events would not benefit from a dedicated WS.
 *
 * Returns `state: null` when the controller is not configured (the server
 * responded 503). Callers render the toggle as a no-op placeholder in that
 * case.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchAutopilotState,
  resumeAutopilot,
  startAutopilot,
  stopAutopilot,
  type AutopilotState,
} from "../api.js";

export const AUTOPILOT_POLL_INTERVAL_MS = 2000;

export interface UseAutopilotResult {
  /** `null` while the first poll is in flight or when the server returns 503. */
  state: AutopilotState | null;
  /** `true` once the first response has been received (success OR 503). */
  ready: boolean;
  /** Last error from a poll or mutation; `null` when clean. */
  error: string | null;
  /** `true` when `unavailable` — the server reported no controller wired. */
  unavailable: boolean;
  start: (scenario?: string) => Promise<void>;
  stop: () => Promise<void>;
  resume: () => Promise<void>;
}

export const useAutopilot = (
  pollIntervalMs: number = AUTOPILOT_POLL_INTERVAL_MS,
): UseAutopilotResult => {
  const [state, setState] = useState<AutopilotState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const cancelled = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchAutopilotState();
      if (cancelled.current) return;
      setState(next);
      setUnavailable(false);
      setError(null);
    } catch (err) {
      if (cancelled.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      // 503 is the "no controller wired" signal — stop noisily logging it.
      if (/503/.test(msg)) {
        setState(null);
        setUnavailable(true);
        setError(null);
      } else {
        setError(msg);
      }
    } finally {
      if (!cancelled.current) setReady(true);
    }
  }, []);

  useEffect(() => {
    cancelled.current = false;
    void refresh();
    const id = window.setInterval(() => {
      void refresh();
    }, pollIntervalMs);
    return () => {
      cancelled.current = true;
      window.clearInterval(id);
    };
  }, [refresh, pollIntervalMs]);

  const start = useCallback(async (scenario?: string): Promise<void> => {
    try {
      const next = await startAutopilot(scenario);
      setState(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, []);

  const stop = useCallback(async (): Promise<void> => {
    try {
      const next = await stopAutopilot();
      setState(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, []);

  const resume = useCallback(async (): Promise<void> => {
    try {
      const next = await resumeAutopilot();
      setState(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, []);

  return { state, ready, error, unavailable, start, stop, resume };
};
