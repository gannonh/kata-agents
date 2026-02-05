# Phase 2: Unit Test Coverage — UAT

**Started:** 2026-02-05
**Status:** Issues Found

## Tests

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | Coverage report runs without release artifacts | ✓ pass | |
| 2 | Coverage report shows module-level percentages | ✗ fail | No automated summary script |
| 3 | COVERAGE.md explains which modules need tests | ✗ fail | No thresholds, no CI gating, static doc becomes stale |
| 4 | Requirements traceability updated | — skip | Blocked by issues above |

## Issues Found

### Issue 1: No automated coverage summary (HIGH)
**Observed:** `bun run test:coverage` outputs file-level data only. No module-level aggregation.
**Expected:** Script outputs summaries by area (packages/shared, packages/mermaid, etc.)
**Impact:** Can't quickly assess coverage health by module.

### Issue 2: No coverage thresholds (HIGH)
**Observed:** No `coverageThreshold` in bunfig.toml. Coverage can drop without detection.
**Expected:** CI fails when coverage drops below targets.
**Targets agreed:**
- packages/mermaid: 95%
- packages/shared: 60%
- packages/ui: 80%
- apps/electron/src: 70%
- Overall: 70%

### Issue 3: COVERAGE.md is stale documentation (MEDIUM)
**Observed:** Static markdown file with point-in-time analysis. Will become outdated immediately.
**Expected:** Automated output replaces manual documentation.
**Action:** Delete COVERAGE.md, replace with script output.

## Session Log

### Test 1: Coverage report runs without release artifacts
**Expected:** Running `bun run test:coverage` produces output showing coverage percentages for source files, with no files from `apps/electron/release/` or `*.d.ts` files appearing.
**Result:** ✓ Pass

### Test 2: Coverage report shows module-level percentages
**Expected:** Coverage output shows area-level summaries.
**Result:** ✗ Fail - Only file-level data shown, no aggregation.

### Test 3: COVERAGE.md explains which modules need tests
**Expected:** Useful, maintainable coverage documentation with enforcement.
**Result:** ✗ Fail - Static doc, no thresholds, no CI gating.

---
