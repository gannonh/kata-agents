---
id: electron-typecheck
title: Fix TypeScript errors in apps/electron to enable CI typecheck
priority: medium
area: ci
created: 2026-01-30
---

# Fix TypeScript errors in apps/electron

## Summary

The `apps/electron` package has pre-existing TypeScript errors that were not being caught because `typecheck:all` only checked `packages/core` and `packages/shared`. These need to be fixed so we can add electron to the CI typecheck.

## Current State

- `typecheck:all` now covers: `core`, `shared`, `mermaid`, `ui`
- `apps/electron` is excluded until these errors are fixed

## Errors to Fix

### Critical (actual bugs)

1. **ipc.ts:1231** - `getExistingClaudeCredentials` does not exist on auth module
2. **sessions.ts:610** - `string | undefined` not assignable to `string`
3. **sessions.ts:617** - `"name_changed"` not a valid event type
4. **thumbnail-protocol.ts:167,186** - Buffer type not assignable to BodyInit
5. **preload/index.ts:66** - `readFileBinary` does not exist in ElectronAPI type
6. **App.tsx:1060** - `readFileBinary` does not exist on ElectronAPI

### Test File (icon-cache.test.ts)

~12 errors related to mock typing and test assertions. Consider:
- Fixing the mock types
- Or excluding test files from typecheck (they still run via `bun test`)

### Lower Priority (playground/settings)

- **AppearanceSettingsPage.tsx:142** - `"appearance"` not assignable to DocFeature
- **playground/registry/turn-card.tsx** - 4 errors with stale component props (`onOpenFile`)

## Acceptance Criteria

- [ ] All TypeScript errors in `apps/electron` are fixed
- [ ] Update `typecheck:all` to include electron:
  ```
  && cd ../../apps/electron && bun run tsc --noEmit
  ```
- [ ] CI passes with electron included

## Related

- Part of v0.4.0 foundation work
- Enables comprehensive CI coverage
