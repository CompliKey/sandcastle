import { useState, type PropsWithChildren, type ReactElement } from "react";
import { NavLink } from "react-router-dom";

import { useAutopilotContext } from "./autopilot/AutopilotProvider.js";

/**
 * App shell — sticky top nav, autopilot pill on the right, and the halt
 * banner that appears whenever the controller reports `status: "halted"`.
 *
 * The toggle is a tri-state read on autopilot status:
 *   off    → label "Autopilot OFF",  click → start
 *   on     → label "Autopilot ON",   click → stop
 *   halted → label "Autopilot OFF",  click is a no-op; the user must use the
 *            banner's Resume button (which preserves the halt's scenario).
 */
export const AppShell = ({ children }: PropsWithChildren): ReactElement => {
  const ap = useAutopilotContext();
  const [busy, setBusy] = useState(false);

  const status = ap.state?.status ?? (ap.unavailable ? "off" : "off");
  const isOn = status === "on";
  const isHalted = status === "halted";

  const onToggle = async (): Promise<void> => {
    if (busy || ap.unavailable) return;
    setBusy(true);
    try {
      if (isOn) {
        await ap.stop();
      } else if (status === "off") {
        await ap.start();
      }
      // halted → toggle is inert, user must Resume from the banner.
    } catch {
      // The hook captures the error; the banner / aria-live region will
      // surface it. We don't need to log here.
    } finally {
      setBusy(false);
    }
  };

  const onResume = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await ap.resume();
    } catch {
      /* surfaced via context error */
    } finally {
      setBusy(false);
    }
  };

  const toggleClassName = `app-nav__autopilot${isOn ? " app-nav__autopilot--on" : ""}`;
  const toggleLabel = ap.unavailable
    ? "Autopilot —"
    : isOn
      ? "Autopilot ON"
      : isHalted
        ? "Autopilot OFF"
        : "Autopilot OFF";

  return (
    <div className="app-shell">
      <header className="app-nav">
        <NavLink to="/" className="app-nav__brand">
          sandcastle
        </NavLink>
        <nav className="app-nav__links" aria-label="Primary">
          <NavLink to="/" end className="app-nav__link">
            History
          </NavLink>
          <NavLink to="/queue" className="app-nav__link">
            Queue
          </NavLink>
        </nav>
        <div className="app-nav__spacer" />
        <button
          type="button"
          className={toggleClassName}
          onClick={onToggle}
          disabled={busy || ap.unavailable || isHalted}
          aria-pressed={isOn}
          aria-label={toggleLabel}
          title={
            ap.unavailable
              ? "Autopilot controller not configured"
              : isHalted
                ? "Halted — use Resume in the banner"
                : isOn
                  ? "Click to stop autopilot"
                  : "Click to start autopilot"
          }
          data-testid="autopilot-toggle"
        >
          <span className="app-nav__autopilot__dot" />
          {toggleLabel}
        </button>
      </header>
      {isHalted && ap.state && (
        <div className="halt-banner" role="alert" data-testid="halt-banner">
          <span className="halt-banner__title">Autopilot halted</span>
          <span className="halt-banner__detail">
            {ap.state.haltReason ?? "unknown reason"}
            {ap.state.haltKind === "ticket-level"
              ? " — circuit breaker tripped"
              : ap.state.haltKind === "infra-level"
                ? " — infra-level failure"
                : ""}
          </span>
          <button
            type="button"
            className="halt-banner__resume"
            onClick={onResume}
            disabled={busy}
            data-testid="halt-banner-resume"
          >
            Resume autopilot
          </button>
        </div>
      )}
      {children}
    </div>
  );
};
