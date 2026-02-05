# Test Coverage Analysis

**Last updated:** 2026-02-05
**Overall coverage:** 45.66% functions, 50.90% lines

## Coverage Summary

| Area | Functions | Lines | Status |
|------|-----------|-------|--------|
| packages/shared | ~20% | ~25% | Gaps documented |
| packages/mermaid | ~95% | ~90% | Well-tested |
| packages/ui | ~55% | ~70% | Partial |
| apps/electron/src | ~45% | ~45% | E2E tested |

## Well-Tested Modules (>80% coverage)

These modules have comprehensive test coverage and serve as patterns for future tests.

### packages/shared/src/git/

- **git-service.ts**: 100% functions, 89.66% lines
- **pr-service.ts**: 100% functions, 92% lines
- Tests: `__tests__/git-service.test.ts`, `__tests__/pr-service.test.ts`
- Patterns: File system isolation with temp dirs, mock.module() for child_process, cleanup in afterEach

### packages/shared/src/agent/

- **tool-matching.ts**: 92.86% functions, 100% lines
- **mode-types.ts**: 100% functions, 100% lines
- Tests: `__tests__/tool-matching.test.ts`, `__tests__/tool-matching-sdk-fixtures.test.ts`
- Patterns: Determinism tests, exhaustive edge cases, SDK fixture replay

### packages/shared/src/utils/

- **cli-icon-resolver.ts**: 100% functions, 94.87% lines
- Tests: `__tests__/cli-icon-resolver.test.ts`

### packages/mermaid/

Comprehensive coverage across all diagram types:

| Module | Functions | Lines |
|--------|-----------|-------|
| parser.ts | 100% | 99.42% |
| renderer.ts | 100% | 98.57% |
| ascii/converter.ts | 100% | 95.89% |
| ascii/canvas.ts | 100% | 100% |
| ascii/grid.ts | 100% | 97.21% |
| class/parser.ts | 100% | 92.35% |
| er/parser.ts | 100% | 97.73% |
| er/renderer.ts | 100% | 99.09% |

14 test files covering parser, renderer, layout, and ASCII conversion for class, ER, and sequence diagrams.

## Coverage Gaps

### High Priority (business logic, should have tests)

Modules containing core business logic with low coverage. These are candidates for future unit tests.

#### 1. packages/shared/src/agent/mode-manager.ts
- **Coverage:** 32.5% functions, 49.37% lines
- **Purpose:** Permission mode state machine (safe/ask/allow-all), manages per-session permission state
- **Risk:** Permission bypass bugs could allow unauthorized tool execution
- **Recommended approach:** Test mode transitions, edge cases around permission checking, state isolation between sessions
- **Complexity:** HIGH (1500+ lines, multiple state machines)

#### 2. packages/shared/src/config/storage.ts
- **Coverage:** 0% functions, 11.13% lines
- **Purpose:** Multi-workspace configuration persistence, workspace CRUD operations
- **Risk:** Config corruption could lose user settings
- **Recommended approach:** File system isolation pattern from git-service.test.ts, test JSON serialization edge cases
- **Complexity:** MEDIUM (1150+ lines, file I/O heavy)

#### 3. packages/shared/src/sessions/storage.ts
- **Coverage:** 0% functions, 7.59% lines
- **Purpose:** Session persistence, JSONL format, session CRUD
- **Risk:** Session data loss on corruption
- **Recommended approach:** Temp directory isolation, test JSONL parsing edge cases
- **Complexity:** HIGH (950+ lines, complex data structures)

#### 4. packages/shared/src/sessions/jsonl.ts
- **Coverage:** 0% functions, 5.45% lines
- **Purpose:** JSONL parsing and writing for session event streams
- **Risk:** Parsing failures could lose conversation history
- **Recommended approach:** Unit test parser with valid/invalid JSONL fixtures
- **Complexity:** LOW (250 lines, well-defined format)

#### 5. packages/shared/src/agent/bash-validator.ts
- **Coverage:** 100% functions, 88.79% lines
- **Purpose:** Validates bash commands for safety (read-only vs write operations)
- **Risk:** Security bypass if validation logic is incorrect
- **Recommended approach:** Comprehensive test cases for dangerous command patterns
- **Note:** Good function coverage but line gaps in edge cases

#### 6. packages/shared/src/config/validators.ts
- **Coverage:** 40% functions, 32.91% lines
- **Purpose:** Configuration validation (workspaces, sources, permissions)
- **Risk:** Invalid config could crash app or create security holes
- **Recommended approach:** Test validation rules with valid/invalid fixtures
- **Complexity:** HIGH (1700+ lines of validation rules)

#### 7. packages/shared/src/agent/permissions-config.ts
- **Coverage:** 11.54% functions, 15.26% lines
- **Purpose:** Customizable safety rules, blocked tools, allowed patterns
- **Risk:** Permission misconfiguration could block legitimate operations
- **Recommended approach:** Unit test rule matching logic
- **Complexity:** MEDIUM (700+ lines)

### Low Priority (deferred with rationale)

These modules have low coverage but testing is deferred for documented reasons.

#### OAuth and Authentication (`packages/shared/src/auth/`)

| Module | Functions | Lines | Rationale |
|--------|-----------|-------|-----------|
| google-oauth.ts | 0% | 16.59% | OAuth flows require real browser interaction, tested via E2E |
| microsoft-oauth.ts | 0% | 17.45% | OAuth flows require real browser interaction, tested via E2E |
| slack-oauth.ts | 0% | 16.67% | OAuth flows require real browser interaction, tested via E2E |
| oauth.ts | 0% | 4.22% | Orchestrates OAuth flows, integration-test territory |
| callback-server.ts | 0% | 4.96% | HTTP server for OAuth callbacks, tested via E2E |
| callback-page.ts | 0% | 0.68% | HTML generation for OAuth UI, visual testing |
| claude-token.ts | 0% | 4.29% | Token refresh logic, requires mock token server |

**Rationale:** OAuth flows involve browser redirects, token servers, and real credential storage. The E2E live test suite (`e2e/tests/live/auth.live.e2e.ts`) verifies authentication works end-to-end with real credentials. Unit tests would require extensive mocking without testing the actual OAuth protocol.

#### MCP Sources (`packages/shared/src/sources/`)

| Module | Functions | Lines | Rationale |
|--------|-----------|-------|-----------|
| credential-manager.ts | 3.85% | 5.03% | MCP credential handling, integration with MCP protocol |
| storage.ts | 0% | 8.22% | Source persistence, tested via E2E source tests |
| server-builder.ts | 14.29% | 16.20% | MCP server configuration, protocol-specific |
| api-tools.ts | 5.56% | 11.94% | API source tool definitions, tested via E2E |
| types.ts | 0% | 4.44% | Type definitions, runtime behavior minimal |

**Rationale:** MCP sources require running MCP servers (stdio or SSE) to test meaningfully. Mock MCP servers would test the mock, not the integration. E2E tests with the filesystem MCP (`e2e/tests/live/mcps.live.e2e.ts`) verify source functionality.

#### Credentials (`packages/shared/src/credentials/`)

| Module | Functions | Lines | Rationale |
|--------|-----------|-------|-----------|
| manager.ts | 0% | 4.55% | Credential CRUD with encryption |
| secure-storage.ts | 0% | 10.79% | AES-256-GCM encryption, OS keychain |

**Rationale:** Credential storage uses platform-specific secure storage APIs and AES-256-GCM encryption. Unit tests would need to mock the entire encryption subsystem. E2E tests verify credentials work end-to-end.

#### UI Rendering Utilities

| Module | Functions | Lines | Rationale |
|--------|-----------|-------|-----------|
| packages/ui/turn-utils.ts | 47.37% | 41.14% | React-specific rendering, visual testing |
| apps/electron/icon-cache.ts | 0% | 8.76% | Icon caching for UI, tested via E2E |

**Rationale:** UI utilities are tightly coupled with React rendering. Visual correctness is validated through E2E tests, not unit tests.

#### System Utilities

| Module | Functions | Lines | Rationale |
|--------|-----------|-------|-----------|
| utils/debug.ts | 12.5% | 10.61% | Debug logging, side-effect heavy |
| utils/perf.ts | 0% | 13.31% | Performance measurement, timing-sensitive |
| utils/files.ts | 0% | 8.28% | File operations, integration territory |
| network-interceptor.ts | 6.25% | 8.09% | Fetch interception, requires real HTTP |

**Rationale:** System utilities like debug logging, performance measurement, and file operations are side-effect heavy and timing-sensitive. They're implicitly tested through integration and E2E tests.

### Out of Scope

These areas are intentionally not unit tested. They're covered by E2E tests.

#### apps/electron/src/main/
- Electron main process (window management, IPC handlers)
- Tested via E2E: `e2e/tests/live/*.live.e2e.ts`

#### apps/electron/src/renderer/
- React components (UI rendering, state management)
- Tested via E2E: All live E2E tests verify renderer behavior

#### apps/electron/src/preload/
- Context bridge (exposes IPC to renderer)
- Tested via E2E: IPC communication verified through UI interactions

## Testing Recommendations

Prioritized modules for future test coverage:

1. **sessions/jsonl.ts** - LOW complexity, HIGH value. JSONL parser is isolated and easy to test. Foundation for session persistence tests.

2. **agent/mode-manager.ts** - HIGH complexity, CRITICAL security. Permission mode state machine is central to the security model. Should test mode transitions and permission checking.

3. **config/validators.ts** - HIGH complexity, MEDIUM risk. Validation rules protect against invalid configuration. Test with fixtures.

4. **sessions/storage.ts** - MEDIUM complexity after jsonl.ts done. Session CRUD builds on JSONL parser.

5. **config/storage.ts** - MEDIUM complexity. Workspace persistence is similar to session storage pattern.

6. **agent/permissions-config.ts** - MEDIUM complexity. Permission rule matching is security-relevant.

## Notes

- **Coverage threshold not enforced:** Bun coverage reports use warning-only policy. No CI failures on low coverage.
- **Goal is appropriate coverage:** Not targeting 100%. Unit tests for business logic, E2E tests for integration paths.
- **E2E tests cover integration:** The 15 live E2E tests (`e2e/tests/live/*.live.e2e.ts`) cover end-to-end flows that unit tests cannot.
- **Bun coverage limitation:** Bun only tracks imported modules. Modules not loaded during tests don't appear in reports, which can create false high coverage percentages.
- **Test patterns established:** git-service.test.ts and pr-service.test.ts provide patterns for file system isolation, mocking, and lifecycle hooks.
