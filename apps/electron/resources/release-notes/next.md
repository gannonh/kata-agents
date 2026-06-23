# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

## Bug Fixes

- **Nightly agent sessions** — package the Pi agent subprocess in desktop release artifacts so new chats can start successfully.

## Breaking Changes

- **Complete brand identity cutover** — package scope is now `@kata-sh/*`, config directory is `~/.kata-agents`, environment variables use the `KATA_*` prefix, CLI binaries are `kata-cli` / `kata-server`, deep links use `kataagents://`, and app ID is `sh.kata.agents`. No migration from Craft-era names is provided.
