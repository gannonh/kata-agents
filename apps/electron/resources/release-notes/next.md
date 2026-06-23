# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

## Bug Fixes

- **Update restart on macOS** — fix the app not restarting after confirming "Restart to update". The `before-quit` handler was calling `event.preventDefault()` during update installs, which cancelled Squirrel.Mac's native termination (the mechanism that performs the bundle swap and relaunch). Session flushing and resource cleanup now run in the pre-update hook before `quitAndInstall`, so `before-quit` can skip `preventDefault` and let Squirrel.Mac's install proceed uninterrupted.

- **Nightly agent sessions** — package the Pi agent subprocess in desktop release artifacts so new chats can start successfully.
- **Standalone server dist** — fix workspace package scope directory (`@kata-sh` instead of `@kata-agent`) so `@kata-sh/*` imports resolve correctly in the assembled server distribution.
- **CLI tool-icon matching** — correct the CLI binary name in tool icon metadata from `kata-agents` (plural) to `kata-agent` (singular) so tool icons match against the actual binary.
- **OAuth client identity** — fix the default OAuth `client_id` from `kata-agents` to `kata-agent`, matching the canonical CLI binary name.
- **Bundled CLI reference** — rename the bundled docs file from `craft-cli.md` to `kata-cli.md` so the system prompt's Kata CLI guidance points at a file that exists in `~/.kata-agents/docs/`.
- **Kata Agent tool icon** — ship `kata-agent.svg` (the `tool-icons.json` reference was broken because only the legacy `craft-agent.svg` existed) so the Kata Agent tool icon renders correctly.
- **Brand asset cleanup** — rename `kata-logos` brand PNGs to `kata_*`, remove dead `CraftAppIcon` code, and make `copy-assets.ts` clean stale files so renamed assets no longer leave legacy Craft-named files in the bundle.

## Breaking Changes

- **Complete brand identity cutover** — package scope is now `@kata-sh/*`, config directory is `~/.kata-agents`, environment variables use the `KATA_*` prefix, CLI binaries are `kata-cli` / `kata-server`, deep links use `kataagents://`, and app ID is `sh.kata.agents`. No migration from Craft-era names is provided.
