# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

## Bug Fixes

- **Managed worktree push from a remote base ref** — Fixed push and push & PR failing with `fatal: The upstream branch of your current branch does not match the name of your current branch` when a managed worktree was created from a remote-tracking base ref such as `origin/main`. New worktrees no longer inherit upstream tracking from their base ref, and push now heals a mismatched upstream by pushing the branch to its own same-named remote branch.

## Breaking Changes
