/**
 * Pure validator for the manual-override sheet.
 *
 * Translates the raw form fields into a `ScenarioOverrides` payload, or
 * surfaces a single human-readable error string for inline display. Lives in
 * its own module so the logic is unit-testable without React/jsdom.
 */

import type { ScenarioOverrides } from "../api.js";

export interface OverrideFormState {
  readonly model: string;
  readonly maxIterations: string;
  readonly promptArgsRaw: string;
}

export type BuildOverridesResult =
  | { readonly ok: true; readonly overrides: ScenarioOverrides }
  | { readonly ok: false; readonly error: string };

export const buildOverrides = (
  state: OverrideFormState,
): BuildOverridesResult => {
  const overrides: {
    -readonly [K in keyof ScenarioOverrides]: ScenarioOverrides[K];
  } = {};

  if (state.model.trim().length > 0) {
    overrides.model = state.model.trim();
  }

  const trimmedMax = state.maxIterations.trim();
  if (trimmedMax.length > 0) {
    const n = Number.parseInt(trimmedMax, 10);
    if (!Number.isInteger(n) || n < 1 || String(n) !== trimmedMax) {
      return { ok: false, error: "Max iterations must be a positive integer." };
    }
    overrides.maxIterations = n;
  }

  const trimmedJson = state.promptArgsRaw.trim();
  if (trimmedJson.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmedJson);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Prompt args is not valid JSON: ${detail}` };
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {
        ok: false,
        error: 'Prompt args must be a JSON object (e.g. { "key": "value" }).',
      };
    }
    overrides.promptArgs = parsed as Record<string, unknown>;
  }

  return { ok: true, overrides };
};
