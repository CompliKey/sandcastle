/**
 * Manual-mode override sheet — opens over the queue when the operator clicks
 * "Run with overrides…" on a ticket. Form fields mirror the wireframe at
 * `docs/design/sandcastle-ui-wireframes/manual-override.html`:
 *
 *   - Scenario picker (named scenarios from `defineSandcastle({ scenarios })`)
 *   - Model select (default: scenario default → empty override)
 *   - maxIterations (number)
 *   - promptArgs (free-form JSON)
 *
 * The form submits to `POST /api/run-scenario` and resolves with a sessionId
 * the parent uses to navigate into the live session view.
 */

import { useEffect, useId, useState, type ReactElement } from "react";

import type { QueueTicket, ScenarioOption } from "../api.js";
import { runScenarioRequest } from "../api.js";
import { buildOverrides } from "./buildOverrides.js";

interface Props {
  readonly ticket: QueueTicket;
  readonly scenarios: ReadonlyArray<ScenarioOption>;
  readonly onClose: () => void;
  readonly onStarted: (sessionId: string) => void;
}

/**
 * Models surfaced in the override picker. Hardcoded at v1 to match the
 * wireframe — a future slice can derive these from the agent provider
 * registry when manual model overrides become opt-in per scenario.
 */
const MODEL_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "scenario default" },
  { value: "claude-opus-4-7", label: "claude-opus-4-7" },
  { value: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
  { value: "claude-haiku-4-5", label: "claude-haiku-4-5" },
];

const DEFAULT_PROMPT_ARGS_PLACEHOLDER = `{
  "focusFiles": ["path/to/file.ts"],
  "extraGuidance": "..."
}`;

export const OverrideSheet = ({
  ticket,
  scenarios,
  onClose,
  onStarted,
}: Props): ReactElement => {
  const titleId = useId();
  const [scenario, setScenario] = useState<string>(scenarios[0]?.name ?? "");
  const [model, setModel] = useState<string>("");
  const [maxIterations, setMaxIterations] = useState<string>("");
  const [promptArgsRaw, setPromptArgsRaw] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const selectedScenario = scenarios.find((s) => s.name === scenario);

  // Escape closes the sheet; matches typical modal UX and the wireframe's
  // implicit "click outside or press Escape" expectation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    if (!scenario) {
      setError("Pick a scenario.");
      return;
    }
    const built = buildOverrides({ model, maxIterations, promptArgsRaw });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const { sessionId } = await runScenarioRequest({
        scenario,
        ticketId: ticket.id,
        ...(Object.keys(built.overrides).length > 0
          ? { overrides: built.overrides }
          : {}),
      });
      onStarted(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e) => {
        // Backdrop dismiss — only when the click is on the backdrop itself,
        // not bubbled from the sheet body.
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <form className="sheet" onSubmit={submit}>
        <header className="sheet__header">
          <div className="sheet__title-cell">
            <h2 id={titleId} className="sheet__title">
              Run <span className="session-header__ticket">{ticket.id}</span>{" "}
              with overrides
            </h2>
            <p className="sheet__sub">{ticket.title}</p>
          </div>
          <button
            type="button"
            className="sheet__close"
            aria-label="Close"
            disabled={submitting}
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="sheet__body">
          <div className="form-defaults-note">
            Overrides apply only to this manual invocation. Scenario defaults in{" "}
            <code>.sandcastle/main.ts</code> are not modified.
          </div>

          <div className="form-row">
            <label className="form-field">
              <span className="form-field__label">Scenario</span>
              <select
                className="form-select"
                value={scenario}
                onChange={(e) => setScenario(e.target.value)}
                disabled={submitting}
              >
                {scenarios.length === 0 && (
                  <option value="">(no scenarios configured)</option>
                )}
                {scenarios.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.description ? `${s.name} — ${s.description}` : s.name}
                  </option>
                ))}
              </select>
              <span className="form-field__hint">
                Named scenarios from your <code>defineSandcastle()</code>{" "}
                config.
              </span>
            </label>
            <label className="form-field">
              <span className="form-field__label">Model</span>
              <select
                className="form-select"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={submitting}
              >
                {MODEL_CHOICES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              <span className="form-field__hint">
                Override the model the agent provider uses for this run. Only
                effective if the scenario reads <code>ctx.overrides.model</code>
                .
              </span>
            </label>
          </div>

          <label className="form-field">
            <span className="form-field__label">Max iterations</span>
            <input
              type="number"
              className="form-input"
              min={1}
              max={200}
              placeholder={
                selectedScenario?.maxIterations !== undefined
                  ? String(selectedScenario.maxIterations)
                  : "(scenario default)"
              }
              value={maxIterations}
              onChange={(e) => setMaxIterations(e.target.value)}
              disabled={submitting}
            />
            <span className="form-field__hint">
              {selectedScenario?.maxIterations !== undefined ? (
                <>
                  Scenario default:{" "}
                  <code>{selectedScenario.maxIterations}</code>. Hitting the cap
                  counts as a ticket-level failure.
                </>
              ) : (
                <>Leave blank to use the scenario&apos;s default.</>
              )}
            </span>
          </label>

          <label className="form-field">
            <span className="form-field__label">Prompt args (JSON)</span>
            <textarea
              className="form-textarea"
              spellCheck={false}
              placeholder={DEFAULT_PROMPT_ARGS_PLACEHOLDER}
              value={promptArgsRaw}
              onChange={(e) => setPromptArgsRaw(e.target.value)}
              disabled={submitting}
            />
            <span className="form-field__hint">
              Free-form JSON merged into your scenario&apos;s{" "}
              <code>promptArgs</code>. Manual values win on conflict.
            </span>
          </label>

          {error && (
            <div className="badge badge--error" role="alert">
              {error}
            </div>
          )}
        </div>

        <footer className="sheet__footer">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={submitting || scenarios.length === 0}
          >
            {submitting ? "Starting…" : "▶ Start run"}
          </button>
        </footer>
      </form>
    </div>
  );
};
