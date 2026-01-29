# Upstream Management

Kata Desktop is a fork of Craft Agents. This document describes how to track and selectively adopt changes from the upstream repository.

## Current Status

> **Note:** As of 2026-01-29, the upstream remote is configured but may point to a legacy URL.
> Run `git remote -v` to verify. If it shows a different URL than documented below,
> update it using `git remote set-url upstream https://github.com/AiCodecraft/craft-agents.git`

## Source Repository

- **URL:** https://github.com/AiCodecraft/craft-agents
- **Remote name:** `upstream`
- **Sync branch:** `upstream/sync`

## Initial Setup

```bash
# Add upstream remote (one-time)
git remote add upstream https://github.com/AiCodecraft/craft-agents.git

# Create sync branch to track upstream
git fetch upstream
git checkout -b upstream/sync upstream/main --no-track
git push origin upstream/sync
```

> **Note:** If upstream remote already exists but points to a different URL, update it:
> ```bash
> git remote set-url upstream https://github.com/AiCodecraft/craft-agents.git
> ```

## Monthly Sync Process

```bash
# 1. Update sync branch
git checkout upstream/sync
git fetch upstream
git reset --hard upstream/main
git push origin upstream/sync --force

# 2. Review new commits
git log upstream/sync --oneline -20

# 3. Compare with our main
git log main..upstream/sync --oneline
```

## Cherry-Pick Workflow

```bash
# 1. Create feature branch from main
git checkout main
git checkout -b feature/upstream-[description]

# 2. Cherry-pick specific commit(s)
git cherry-pick <commit-sha>

# 3. Resolve conflicts if any, then push
git push origin feature/upstream-[description]

# 4. Open PR to main - follows standard review process
```

## Adoption Criteria

| Change Type | Policy | Rationale |
|-------------|--------|-----------|
| Bug fixes | Adopt readily | Direct user benefit, low risk |
| Security patches | Adopt immediately | Critical for user safety |
| SDK updates | Evaluate carefully | Test before adopting, may have breaking changes |
| New features | Case-by-case | Evaluate fit with Kata direction |
| Refactors | Generally skip | Adds merge complexity without user value |
| Branding changes | Never adopt | Defeats purpose of fork |

## Conflict Resolution

When cherry-picking causes conflicts:

1. **Resolve in the feature branch, not in main** - Keep main clean until PR is approved
2. **If conflict is extensive, consider skipping that commit** - Not all upstream changes are worth the complexity
3. **Document significant conflict resolutions in PR description** - Future maintainers need context

### Common Conflict Areas

- `apps/electron/electron-builder.yml` - Bundle ID, product name differ
- `apps/electron/resources/` - Icons and branding assets
- `packages/shared/src/branding.ts` - Service URLs and domain references

## Review Cadence

| Frequency | Action |
|-----------|--------|
| Monthly | Review upstream commits, identify candidates for adoption |
| As-needed | Cherry-pick security fixes immediately |
| Quarterly | Evaluate SDK version alignment with upstream |

## Commit Message Convention

When cherry-picking from upstream, use this format:

```
feat(upstream): [description]

Cherry-picked from AiCodecraft/craft-agents@<sha>
Original commit: <original message>

Adopted because: [rationale]
```

This creates a clear audit trail linking Kata commits to their upstream origins.

## Branch Protection

- **main:** Protected, requires PR review
- **upstream/sync:** Force-pushable (mirrors upstream exactly)
- **feature/upstream-*:** Standard feature branch rules apply

---
*Last updated: 2026-01-29*
