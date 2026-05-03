---
"@ai-hero/sandcastle": patch
---

Add `BacklogManagerHostInterface` (concrete types for `listPending`, `getTicket`, `markErrored`, `clearErrored`), a JIRA implementation (`createJiraBacklogManager`) that calls JIRA Cloud REST v3 from the host process, and a `sandcastle queue list` CLI subcommand.

Slice 1's loose `BacklogManager` placeholder is now an alias for the new tightened interface. Tickets returned by `listPending`/`getTicket` carry `{id, title, body, labels, url, priority?, createdAt?, updatedAt?}`. `listPending` excludes `agent-error`-labelled tickets by default; pass `--include-errored` (CLI) or `{ includeErrored: true }` (programmatic) to include them. `markErrored` applies the label and posts a comment without transitioning status; `clearErrored` strips the label and posts a retry comment. The JIRA implementation uses `update.labels` operations so existing labels are preserved, posts comments in ADF v1, and accepts an injected `fetch` for testing. A reusable contract test (`runBacklogManagerHostInterfaceContract`) is included so future implementations (GitHub Issues, Linear, etc.) can self-verify.
