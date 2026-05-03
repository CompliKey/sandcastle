/**
 * AutopilotProvider — single polling context shared by the shell + history
 * pages. Without it each consumer would fire its own 2s poll, duplicating
 * round-trips for no benefit.
 */

import {
  createContext,
  useContext,
  type PropsWithChildren,
  type ReactElement,
} from "react";

import { useAutopilot, type UseAutopilotResult } from "./useAutopilot.js";

const AutopilotContext = createContext<UseAutopilotResult | null>(null);

export const AutopilotProvider = ({
  children,
}: PropsWithChildren): ReactElement => {
  const value = useAutopilot();
  return (
    <AutopilotContext.Provider value={value}>
      {children}
    </AutopilotContext.Provider>
  );
};

export const useAutopilotContext = (): UseAutopilotResult => {
  const ctx = useContext(AutopilotContext);
  if (!ctx) {
    throw new Error(
      "useAutopilotContext must be used within an AutopilotProvider",
    );
  }
  return ctx;
};
