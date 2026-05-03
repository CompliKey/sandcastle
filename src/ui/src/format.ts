/** Pretty-print helpers shared across pages. */

export const formatDuration = (ms: number | undefined): string => {
  if (ms === undefined) return "—";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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
