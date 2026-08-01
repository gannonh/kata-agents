# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **Git & GitHub worktrees (preview, flag-gated)** — When `KATA_FEATURE_GIT_WORKSPACE_V1` is enabled, a session in a Git repository can run in an isolated managed worktree created from a chosen base ref, review its changes, and commit / pull / push / open a GitHub pull request from the app. Git, worktree, and `gh` commands always execute on the workspace-owning server (local or remote). V1 never force-pushes, resets, rebases, merges, or auto-resolves conflicts; conflicted or merge-in-progress states, externally switched managed branches, and missing worktrees surface as visible recoverable states rather than silent directory switches. Deleting a session offers managed-worktree removal as a separate, explicitly-confirmed choice that names uncommitted and unpushed work, and the server performs both steps in one ordered operation so a running agent is stopped first and a rejected removal leaves the session and its checkout untouched; archiving never removes a worktree. Once a session is bound to a checkout, the checkout owns its working directory and the composer's directory selector gives way to the checkout identity. Disabled by default.
- **Hosted docs source** — Added a Mintlify documentation site under `apps/online-docs`, seeded with Kata-branded getting-started and core-concept pages so the app's help links have a repository-backed docs source.
- **MCP OAuth for remote HTTP sources** — OAuth-protected MCP sources can complete browser authentication through the hosted callback relay at `https://agents.kata.sh/auth/callback`. Desktop flows continue to use the local Electron callback server.

## Improvements

- **Pi SDK 0.83** — Updated the embedded Pi runtime to the Pi CLI-aligned 0.83 package family, including native GPT-5.6 model catalogs and provider-reported reasoning levels.
- **GPT-5.6 OpenAI models** — Added GPT-5.6 Sol, Terra, and Luna to the OpenAI API-key and ChatGPT/Codex model catalogs, including runtime resolution and updated defaults.
- **Provider-aware reasoning levels** — Restored model-specific reasoning controls for OpenAI API, ChatGPT/Codex, Copilot, and Pi-managed models. The selectors now change with the selected model, expose supported levels such as `minimal` and native Pi `max`, omit unsupported levels, and use persisted app defaults for new sessions.
- **Default theme brand color** — The distributed Default theme now uses the Kata brand highlight color instead of the previous purple accent across bundled theme files and renderer defaults.
- **CLI rename** — The terminal client package is now `@kata-sh/agents-cli` with binary `kata-agents-cli`. Bundled docs and reference guides were updated to match.

## Bug Fixes

- **ChatGPT/Codex authentication** — Fixed OpenAI model sessions failing with `No API key found for openai-codex` after OAuth authentication by preserving Pi's native OAuth credential format across startup and token refresh.
- **Managed worktree deletion confirmation** — Preparing a worktree now updates renderer session state immediately, so deleting that session opens the worktree-aware confirmation instead of the generic session prompt. The worktree icon and supporting text stay aligned with the wrapped label.
- **Documentation help links** — The app Help dropdown now opens the hosted Mintlify docs site at `https://agents.kata.sh/docs`, and the linked Sources, Skills, Statuses, Permissions, Automations, Messaging, and All Documentation pages exist in the docs site.

## Breaking Changes

- **Terminal client binary renamed to `kata-agents-cli`** — Update scripts, PATH links, and CI invocations to use the new binary name.
- **Phantom workspace-commands CLI references removed** — Documentation and guardrails no longer reference a separate `kata-agent` commands binary. Config-domain access is via `kata-agents-cli invoke <channel>` or the desktop UI. A first-class commands CLI remains deferred ([#4](https://github.com/gannonh/kata-agents/issues/4)).
