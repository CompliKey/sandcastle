import type { PropsWithChildren, ReactElement } from "react";
import { NavLink } from "react-router-dom";

/**
 * App shell — sticky top nav, autopilot pill on the right. The Queue tab
 * (slice 10) is the entry point for manual-mode invocations; the autopilot
 * pill stays disabled until slice 11.
 */
export const AppShell = ({ children }: PropsWithChildren): ReactElement => (
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
        className="app-nav__autopilot"
        title="Autopilot status surfaced in slice 11"
        disabled
      >
        <span className="app-nav__autopilot__dot" />
        Autopilot —
      </button>
    </header>
    {children}
  </div>
);
