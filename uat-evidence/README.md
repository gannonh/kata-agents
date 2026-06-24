# UAT evidence — CLI rename and phantom removal (AC 11)

Captured 2026-06-24 against branch `cursor/cli-rename-phantom-removal-7c26`.

## Files

| File | Description |
|------|-------------|
| [cli-transcript.txt](./cli-transcript.txt) | Full `kata-agents-cli` command transcript (steps 3–7) |
| [headless-server.log](./headless-server.log) | `KATA_HEADLESS=1 bun run electron:dev` boot log with `KATA_SERVER_URL` / `KATA_SERVER_TOKEN` |
| [window-boot.log](./window-boot.log) | Non-headless `bun run electron:dev` boot log showing window creation |

## Results

| Step | Result |
|------|--------|
| 1. Non-headless `electron:dev` | Pass — `Created window for first workspace: uat-demo` in `window-boot.log` (lines 65–66) |
| 2. Headless credentials | Pass — printed in `headless-server.log` |
| 3. `ping` | Pass — 7ms latency |
| 4. `workspaces` | Pass (after `invoke workspaces:create` on fresh server) |
| 5. `session create` → `sessions` → `session messages` | Pass |
| 6. `invoke labels:list` | Pass (workspace id passed as JSON arg) |
| 7. `invoke system:homeDir` | Pass — `/home/ubuntu` |

## Notes

- Fresh headless servers have no workspaces; UAT bootstraps one via `invoke workspaces:create` before session/labels steps.
- `labels:list` requires the workspace id argument: `kata-agents-cli invoke labels:list "<workspace-id>"`.
- Screenshot capture was attempted under `DISPLAY=:1` but failed (no `scrot`/PIL visual support in this Xvfb setup). Window creation is evidenced by log lines and a live Electron process during the non-headless run.
