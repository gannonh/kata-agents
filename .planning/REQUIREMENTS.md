# Requirements: v0.7.0 Testing Infrastructure

## Unit Test Coverage

- [ ] **COV-01**: Coverage report runs via `bun test --coverage` and identifies untested modules
- [ ] **COV-02**: pr-service.ts has unit tests following git-service.test.ts patterns
- [ ] **COV-03**: Other coverage gaps identified by report are filled or documented with rationale

## Live E2E Tests

- [ ] **E2E-01**: Live fixture infrastructure uses `~/.kata-agents-demo/` with real OAuth credentials
- [ ] **E2E-02**: `bun run test:e2e:live` script runs live tests separately from CI smoke tests
- [ ] **E2E-03**: Auth test verifies app loads with real credentials, no onboarding wizard
- [ ] **E2E-04**: Chat round-trip test sends message, verifies streaming response renders
- [ ] **E2E-05**: Session lifecycle tests create, rename, switch, delete sessions with persistence verification
- [ ] **E2E-06**: Git status test verifies branch badge shows correct branch in demo repo
- [ ] **E2E-07**: Permission mode test cycles through safe/ask/allow-all and verifies indicator updates

## Future (Deferred)

- Mock API server for CI-based chat testing (issue #49)
- Mock MCP servers for tool discovery testing (issue #49)
- Git repo test fixtures for CI (issue #49)

## Out of Scope

- MCP server connection tests — requires mock infrastructure
- Workspace switching tests — lower priority than core session tests

## Traceability

| Requirement | Phase | Plan |
|-------------|-------|------|
| COV-01 | — | — |
| COV-02 | — | — |
| COV-03 | — | — |
| E2E-01 | — | — |
| E2E-02 | — | — |
| E2E-03 | — | — |
| E2E-04 | — | — |
| E2E-05 | — | — |
| E2E-06 | — | — |
| E2E-07 | — | — |
