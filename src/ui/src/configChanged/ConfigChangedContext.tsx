import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
  type ReactElement,
} from "react";

import type { ConfigChangeNotice } from "../useLiveSession.js";

/**
 * Cross-page state for the "config changed since this run started" badge in
 * the app nav. Only the live session view writes to it (via
 * {@link useConfigChangedPublisher}); historical session views and other
 * pages leave the state untouched, so the badge naturally hides itself the
 * moment the user navigates away from a live in-flight session.
 *
 * The state is intentionally not URL-bound: a config change observed during
 * the current live view persists in memory for the lifetime of the page,
 * surviving brief WS disconnects but resetting on full reload (which would
 * also restart the UI server's watcher baseline).
 */
interface ConfigChangedContextValue {
  readonly notices: readonly ConfigChangeNotice[];
  readonly setNotices: (next: readonly ConfigChangeNotice[]) => void;
  readonly clear: () => void;
}

const Ctx = createContext<ConfigChangedContextValue | null>(null);

export const ConfigChangedProvider = ({
  children,
}: PropsWithChildren): ReactElement => {
  const [notices, setNotices] = useState<readonly ConfigChangeNotice[]>([]);
  const clear = useCallback(() => setNotices([]), []);
  const value = useMemo<ConfigChangedContextValue>(
    () => ({ notices, setNotices, clear }),
    [notices, clear],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useConfigChangedNotices = (): readonly ConfigChangeNotice[] => {
  const v = useContext(Ctx);
  return v?.notices ?? [];
};

/**
 * Internal: lets a consumer (only LiveSessionView in v1) overwrite the
 * notice list. We expose a setter rather than an "add" so the consumer
 * decides the dedup policy — currently `useLiveSession` already dedups by
 * path, so we simply mirror its array.
 */
export const useConfigChangedWriter = (): {
  setNotices: (next: readonly ConfigChangeNotice[]) => void;
  clear: () => void;
} => {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error(
      "useConfigChangedWriter must be used inside <ConfigChangedProvider>",
    );
  }
  return { setNotices: v.setNotices, clear: v.clear };
};
