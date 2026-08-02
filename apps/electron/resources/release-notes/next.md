# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

- **Claude model catalog** — Direct Anthropic models now appear as Fable 5, Opus 5, Opus 4.8, Opus 4.7, Sonnet 5, Sonnet 4.6, and Haiku 4.5. Retired Opus 4.1 is removed, existing connections retain active provider entries, and the Claude Agent SDK is updated to 0.3.220 with 1M-token metadata and Sonnet 5 adaptive-thinking support.

## Bug Fixes

- **OpenAI model picker order** — ChatGPT/Codex models now appear as GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna, GPT-5.5, GPT-5.4, GPT-5.4 mini, and GPT-5.3 Codex Spark.
- **Improve OpenAI icon contrast** — ChatGPT/Codex provider icons now use a white mark in dark themes and a black mark in light themes.

## Breaking Changes
