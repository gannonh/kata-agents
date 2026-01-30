# Kata Agents v0.4.0 — Roadmap

## Overview

Milestone v0.4.0 Foundation establishes Kata Agents as an independent, compliant fork with proper CI/CD tooling before rebranding. Two phases: first build automation and upstream management, then complete trademark compliance and distribution setup.

---

## Phase 1: Setup and Tooling

**Goal:** CI/CD validates every PR and produces distributable artifacts, with documented upstream management strategy.

**Dependencies:** None (foundation phase)

**Plans:** 2 plans

Plans:
- [x] 01-01-PLAN.md — CI workflows (PR validation + release fix)
- [x] 01-02-PLAN.md — Upstream management documentation

**Requirements:**
- SETUP-01: CI workflow validates builds on PR (GitHub Actions)
- SETUP-02: CI runs test suite on PR (`bun test`)
- SETUP-03: CI produces platform build artifacts (macOS, Windows, Linux)
- SETUP-04: Upstream management strategy documented (tracking, merging, separation)

**Success Criteria:**
1. PR triggers GitHub Actions workflow that runs `bun install` and `bun run typecheck:all` without failure
2. PR triggers test execution with `bun test` and reports pass/fail status
3. Merge to main produces downloadable artifacts for macOS (dmg), Windows (exe), and Linux (AppImage)
4. `UPSTREAM.md` documents how to track, fetch, and selectively merge changes from upstream Craft Agents

---

## Phase 2: Rebranding

**Goal:** Complete trademark compliance by removing all Craft references and establishing Kata Agents identity for distribution.

**Dependencies:** Phase 1 (CI must pass before release)

**Plans:** 4 plans

Plans:
- [x] 02-01-PLAN.md — Product name and metadata (BRAND-01, BRAND-02)
- [x] 02-02-PLAN.md — Application icons (BRAND-04)
- [x] 02-03-PLAN.md — In-app logos and React components (BRAND-05)
- [x] 02-04-PLAN.md — Domain references and release configuration (BRAND-03, DIST-01)

**Requirements:**
- BRAND-01: Remove "Craft" from product name and metadata (package.json, electron-builder.yml)
- BRAND-02: Update bundle ID from `com.lukilabs.craft-agent` to `sh.kata.desktop`
- BRAND-03: Remove/replace `craft.do` domain references in codebase
- BRAND-04: Replace application icons (icns, ico, png) with Kata branding
- BRAND-05: Replace in-app logos and symbols (SVGs, React components)
- DIST-01: Configure GitHub releases for v0.4.0 distribution

**Success Criteria:**
1. Application launches with "Kata Agents" in title bar, About dialog, and system tray
2. macOS bundle identifier is `sh.kata.desktop` (verified via `mdls` on built app)
3. `grep -r "craft.do"` returns no matches in source code (excluding NOTICE, LICENSE, git history)
4. Application icon in dock/taskbar displays Kata branding (not Craft logo)
5. GitHub release v0.4.0 exists with downloadable installers for all three platforms

---

## Progress

| Phase | Status   | Requirements | Complete |
|-------|----------|--------------|----------|
| 1     | Complete | 4            | 4/4      |
| 2     | Complete | 6            | 6/6      |

**Total:** 10/10 requirements complete

---

## Coverage Map

| Requirement | Phase | Plan | Description |
|-------------|-------|------|-------------|
| SETUP-01    | 1     | 01-01 | CI validates builds on PR |
| SETUP-02    | 1     | 01-01 | CI runs test suite on PR |
| SETUP-03    | 1     | 01-01 | CI produces platform artifacts |
| SETUP-04    | 1     | 01-02 | Upstream management documented |
| BRAND-01    | 2     | 02-01 | Remove "Craft" from product name |
| BRAND-02    | 2     | 02-01 | Update bundle ID to kata.sh |
| BRAND-03    | 2     | 02-04 | Remove craft.do references |
| BRAND-04    | 2     | 02-02 | Replace application icons |
| BRAND-05    | 2     | 02-03 | Replace in-app logos |
| DIST-01     | 2     | 02-04 | Configure GitHub releases |

---
*Created: 2026-01-29*
*Updated: 2026-01-29 — Phase 2 plans added*
