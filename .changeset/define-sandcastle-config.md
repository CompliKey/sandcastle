---
"@ai-hero/sandcastle": patch
---

Add `defineSandcastle({...})` factory and `sandcastle scenarios list` CLI subcommand — the user-authored config entry point for the upcoming `sandcastle ui` orchestration loop.

A host repo's `.sandcastle/main.ts` can now `export default defineSandcastle({ backlogManager, scenarios })` where each scenario has a discriminated `input` field (only `{ type: "single-ticket" }` is valid in v1) and an async `run`. The new `ScenarioConfigLoader` reads, validates, and returns scenario metadata via tsx's loader pathway — pure parse-and-validate, no scenario invocation. `sandcastle scenarios list` prints the configured scenarios. Validation errors clearly identify missing default exports, hand-rolled configs, non-async `run`, unknown `input.type`, and missing fields.
