---
"@ai-hero/sandcastle": patch
---

Add `jira` as a third backlog manager (alongside `github-issues` and `beads`), hardcoded for Complikey's VGD project. `BacklogManagerEntry.templateArgs` gains four optional preamble fields (`PREAMBLE`, `PLAN_PREAMBLE`, `IMPLEMENT_PREAMBLE`, `MERGE_PREAMBLE`) that get substituted into stage-appropriate prompts of `simple-loop`, `sequential-reviewer`, and `parallel-planner(*)`. Existing `github-issues` and `beads` users see no change — the new fields default to empty string and the placeholders are stripped at scaffold time.

Selecting the `jira` backlog manager copies a vendored overlay of `netresearch/jira-skill@v3.10.1` (with the `enhanced_jql` patch and a new `jira-pickup` script) into `.sandcastle/_vendor/`. The agent Dockerfile clones the upstream plugin and overlays the patched files at build time. `jira-pickup` runs the canonical sprint-scoped JQL and post-filters tickets with unresolved is-blocked-by links.
