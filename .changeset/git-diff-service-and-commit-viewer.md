---
"@ai-hero/sandcastle": patch
---

`sandcastle ui` gains a per-commit changed-file list and click-to-diff file viewer.

**Backend.**
- `GitDiffService` — thin, stateless wrapper over `git show` rooted at one repo path. Returns commit metadata (subject, author, parent SHA, per-file `A/M/D/R/C` status, insertions, deletions) and per-file unified diff text. Branch-strategy-agnostic by construction — git's shared object database means commits made in any worktree of the host repo resolve from the main repo.
- `UiServer` adds `GET /api/sessions/:id/commits/:sha` and `GET /api/sessions/:id/commits/:sha/diff?path=…`. The session id gates access — only commits already recorded against the session view are surfaced.

**Frontend.**
- New commits sidebar in the live and historical session views: lists every commit made during the session, expands to show the changed-file list on click. File names link to a new `/sessions/:sessionId/commits/:sha/diff?path=…` route.
- New diff page renders the Slice 0 wireframe layout — file tree on the left (with `+`/`−` counts and status badges), main pane with toolbar and `Unified` / `Side-by-side` toggle.
- Hand-rolled unified-diff parser (no extra dependency) — projects each hunk into either a single column or aligned `before/after` rows, depending on the active layout.
