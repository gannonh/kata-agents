# Phase 5: Real-Time Updates — UAT

**Date:** 2026-02-03
**Tester:** User
**Status:** Issues Found

## Tests

| # | Test | Expected | Result | Notes |
|---|------|----------|--------|-------|
| 1 | Git branch updates on checkout | Branch badge changes within ~1s of `git checkout` | FAIL | Badge did not update automatically after branch switch (LIVE-01) |
| 2 | PR badge appears for branch with open PR | PR title and status icon show in toolbar | FAIL | PR #13 created but no badge appeared (LIVE-02) |
| 3 | PR badge clears on branch without PR | Switching to branch with no PR removes badge | SKIP | Blocked by Test 2 failure |
| 4 | Git badge updates on focus return | Badge updates when returning to app after external git change | FAIL | PR badge disappeared but branch name did not update (LIVE-03) |
| 5 | No git badge in non-git workspace | No git indicator when workspace is not a git repo | PASS | |
| 6 | App quits cleanly | No hanging processes or watcher errors on quit | PASS | |

## Issues

| # | Severity | Description | Requirement |
|---|----------|-------------|-------------|
| 1 | Critical | Git branch badge does not update automatically when branch changes via git checkout | LIVE-01 |
| 2 | Critical | PR badge does not appear when current branch has an open PR | LIVE-02 |
| 3 | Critical | Branch badge does not update on window focus after external git change | LIVE-03 |

## Summary

Tests completed: 5/6 (1 skipped)
Tests passed: 2/5
Issues found: 3 (all critical)
