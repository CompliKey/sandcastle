# sandcastle ui — wireframes

Flat HTML/CSS wireframes for the v1 `sandcastle ui` surface. These are review
artefacts, not production code. Downstream implementation slices (VGD-140
through VGD-146) consume them as a fixed visual + UX target.

## Locked-in decisions (normative for downstream slices)

| Decision         | Choice              | Notes                                                                                      |
| ---------------- | ------------------- | ------------------------------------------------------------------------------------------ |
| Component lib    | Radix UI primitives | Headless. Wireframes mimic the shapes Radix renders; production slices use the real thing. |
| Build tool       | Vite                | Bundled frontend ships under `dist/ui/` per VGD-132.                                       |
| Layout / spacing | Established here    | Any spacing/typography conventions these wireframes establish are normative for v1.        |

## Screens

- [x] `live-session.html` — iteration timeline, tool-call cards (4 states inline), metrics header, commit sidebar
- [x] `live-session-diff.html` — per-commit file tree + side-by-side diff with unified toggle
- [x] `live-session-halted.html` — halt banner, autopilot-OFF, errored final session, retry CTA
- [x] `queue.html` — TODO ticket list with manual-mode trigger
- [x] `manual-override.html` — manual-mode invocation sheet
- [x] `history.html` — ticket-bounded sessions list with outcome badges + retry on errored rows
- [x] `ticket-detail.html` — per-ticket aggregates + sessions for that ticket

Interaction states covered across the screens:

- Autopilot ON / OFF
- Halt banner present + Resume button
- Errored-ticket retry affordance (history rows + ticket detail + halted live session)
- Config-changed pill in nav
- Tool-call cards: collapsed, expanded with truncated output + show-more disclosure, expanded with structured args, in-flight ("running…")
- Iterations: collapsed (showing meta strip) + expanded (current)
- Autoscroll-following (default, no hint visible) and autoscroll-paused (sticky badge at top of timeline)
- Diff layout toggle (unified / side-by-side)

Each file is standalone. Shared baseline lives in `styles.css`.

## Previewing

```sh
cd docs/design/sandcastle-ui-wireframes
npx live-server --host=0.0.0.0 --port=4567 --no-browser
```

`live-server` injects a small reload script — every save triggers a browser
refresh. Open `http://<host>:4567/` from your workstation; hard-refresh once
on first load so the injected script is picked up.
