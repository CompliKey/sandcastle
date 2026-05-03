---
"@ai-hero/sandcastle": patch
---

`sandcastle ui` now ships the live session view — `/sessions/:id` streams events in real time over a hand-rolled RFC 6455 WebSocket.

**Backend.**
- `EventBroadcaster` — pure in-process pub/sub keyed by `session:<id>`, `lane:<id>`, and a firehose `all` channel. Subscribers run synchronously on `publish`; a thrown sink doesn't poison delivery to siblings.
- `WebSocket.ts` — minimal RFC 6455 server: handshake (`Sec-WebSocket-Accept`), text-frame encoder with extended-length support, masked client-frame parser (rejects unmasked client frames per §5.1), auto-pong, close handling. Hand-rolled rather than pulling in a runtime dep — local-only traffic doesn't justify it.
- `UiServer` accepts a new `broadcaster` option. `/ws?session=<id>` upgrades, sends a one-shot `{type:"snapshot", view}` from `SessionIndex.getSession`, and then forwards every subsequent event for that session as `{type:"event", event}`. Unknown sessions get `{type:"error"}` and a 1008 close.
- `LiveEventBridge` — pumps new events from the on-disk `EventStore.tail()` into both the `SessionIndex` (so REST snapshots stay current) and the broadcaster. The producer (`sandcastle autopilot`, `run-scenario`, ...) lives in a separate process from the UI server, so the disk is the bus.
- `sandcastle ui` wires all of the above; `bridgeDone` is awaited on shutdown to drain the tail loop.

**Frontend.**
- `useLiveSession(id)` opens the WS, applies the snapshot, and reduces incoming events through a pure `applyEventToView` reducer that mirrors `SessionIndex.add`. The same component renders live and historical sessions — historical mode just hands the REST snapshot in directly and skips the WS.
- New components under `src/ui/src/live/`: `LiveSessionView`, `IterationSection` (collapsible per-iteration sections with status badges + meta), `ToolCallCard` (collapsed JSON args, expand on click, long-output disclosure), `MetricsHeader` (live-ticking wall time, last-output-relative, tokens in/out, cache create/read, commits, iteration count).
- `useAutoscrollPin` — pinned by default; releases when the user scrolls up; "📌 autoscroll paused" hint surfaces while unpinned. The geometry helper (`isAtBottom`) is a pure function with its own unit tests.

**Claude Code tool-result enrichment.** The Claude `parseStreamLine` now parses `tool_result` blocks from `user`-role messages (string or array-of-blocks `content`, with `is_error`). Tool-use ids ride a 6-layer pipeline (parser → `AgentStreamEvent` → `agent.toolResult` IPC → `SandcastleEvent` → `SessionIndex` → frontend) so a result can be paired back to its originating call by `toolUseId`. `SessionIterationView.toolCalls[]` gains optional `result` / `isError` fields; `ToolCallCard` renders a "Result" / "Result (error)" section when present, with the same long-output disclosure affordance. Non-Claude providers don't emit tool_result events and render args-only as before.

**Tests.** 37 new unit + integration tests covering broadcaster fan-out (including throw-isolation), RFC 6455 framing against the spec's worked example, full WS round-trips against a real Node `WebSocket` client, `/ws` snapshot+event protocol, the disk-tail bridge, the SessionView reducer's parity with `SessionIndex.add`, the tool_result parser (string content, array-of-blocks content, is_error), tool-result pairing in `SessionIndex` and `applyEventToView` (including orphan-drop), and the autoscroll geometry helper.
