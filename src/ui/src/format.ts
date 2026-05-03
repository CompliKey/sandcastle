/** Pretty-print helpers shared across pages. */

export const formatDuration = (ms: number | undefined): string => {
  if (ms === undefined) return "—";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

/**
 * Long-duration variant for ticket-level rollups (time-to-close, total wall
 * time across many sessions). Renders hh:mm:ss when the duration crosses an
 * hour, otherwise mm:ss to match {@link formatDuration}.
 */
export const formatLongDuration = (ms: number | undefined): string => {
  if (ms === undefined) return "—";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  if (hours === 0) return `${pad(minutes)}:${pad(seconds)}`;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

export const formatStartedAt = (ms: number): string => {
  const d = new Date(ms);
  // YYYY-MM-DD HH:MM in local time, matches the wireframes.
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
};

export const formatTokens = (totals: {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}): string => {
  const sum =
    totals.input + totals.output + totals.cacheCreation + totals.cacheRead;
  if (sum === 0) return "0";
  if (sum < 1000) return String(sum);
  if (sum < 1_000_000) return `${(sum / 1000).toFixed(0)}k`;
  return `${(sum / 1_000_000).toFixed(1)}m`;
};
