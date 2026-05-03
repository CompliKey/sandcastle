---
"@ai-hero/sandcastle": patch
---

`sandcastle ui` now flags when the orchestration config or a prompt template changes mid-run via a passive "config changed since this run started" badge on the live session view.

**Backend.**
- New `ConfigWatcher` (`src/ConfigWatcher.ts`) watches `.sandcastle/main.ts`, `.mts`, `.config.ts`, plus any `*.md` prompt templates living directly under `.sandcastle/`. Initial mtime + SHA-256 hash are recorded at startup; subsequent fs events compare against the baseline so a same-content rewrite (e.g. a `vim :w` with no edits) does not fire. Subscribers receive `{ path, changedAt }`; a per-watcher snapshot of changed paths is exposed via `getChangedFiles()` so a late-connecting WS client still sees the badge.
- `UiServer` accepts an optional `configWatcher`. Each `/ws` connection back-fills the watcher's current changed-files set immediately after the snapshot, then receives every subsequent change as `{ type: "config.changed", path, changedAt }`. Backed by chokidar with `awaitWriteFinish` (50/25 ms) to handle atomic-write-via-rename editors.
- `ui` CLI command starts the watcher alongside the server and tears it down on shutdown. Watcher failures (e.g. inotify exhaustion) are logged and the server continues to run without the badge.

**Frontend.**
- `useLiveSession` accumulates `config.changed` notifications as `configChanges: ReadonlyArray<{ path, changedAt }>`. The state resets when the hook is pointed at a different `sessionId`; reverting a file does not clear an entry (the running session was already started under the old config).
- `LiveSessionView` renders the existing `.config-changed` badge from the Slice 0 wireframes when `isLive && running && configChanges.length > 0`. Tooltip lists the last two path segments of each changed file. Historical session views never render the badge — `historical` short-circuits the WS so `configChanges` stays empty, and even if a session ends mid-view, `running` flips false and the badge disappears.

Pure passive notice: there is no hot-reload, no auto-restart, no invalidation of the running session.
