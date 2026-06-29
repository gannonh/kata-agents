---
type: VerifyReport
title: MCP OAuth callback support — verify report
description: UAT and acceptance evidence for MCP OAuth callback relay and MCP resource parameter work.
tags: [mcp, oauth, cloudflare, verify, uat]
timestamp: 2026-06-28T21:30:00Z
---

# MCP OAuth callback support — verify report

## Spec

- [2026-06-26-mcp-oauth-callback-support-plan.md](./2026-06-26-mcp-oauth-callback-support-plan.md)
- Build report: [2026-06-26-mcp-oauth-callback-support-build-report.md](./2026-06-26-mcp-oauth-callback-support-build-report.md)

## UAT evidence

- `uat-evidence/mixed-20260628-212533/`
- `uat-evidence/electron-20260628-215346/` — macOS dev-box acceptance pass with added OAuth E2E coverage.

## Acceptance criteria review

| AC | Result | Evidence |
|----|--------|----------|
| 1 Public callback route exists | **Fail (deploy pending)** | Production probe still returns Vercel `DEPLOYMENT_NOT_FOUND` 404 (`uat-evidence/electron-20260628-215346/responses/production-callback-missing-state.txt`). Local worker entrypoint E2E proves controlled 400 for missing/malformed state (`e2e/tests/oauth/worker-entrypoint.test.ts`, `logs/e2e-oauth-full-rerun2.log`). |
| 2 Relay success redirects correctly | **Pass** | `e2e/tests/web/oauth-relay.spec.ts`, `e2e/tests/oauth/oauth.integration.test.ts`, `e2e/tests/oauth/worker-entrypoint.test.ts`, and `oauth-relay-handler.test.ts`. |
| 3 Relay provider errors forward correctly | **Pass** | `e2e/tests/web/oauth-relay.spec.ts`, `e2e/tests/oauth/oauth.integration.test.ts`, `e2e/tests/oauth/webui-relay-flow.test.ts`, worker entrypoint tests, and unit tests. |
| 4 Relay rejects unsafe return targets | **Pass** | `e2e/tests/oauth/oauth.integration.test.ts`, `e2e/tests/oauth/worker-entrypoint.test.ts`, and `oauth-relay-handler.test.ts`. |
| 5 MCP resource parameter present | **Pass** | `oauth.test.ts`, `e2e/tests/oauth/oauth.integration.test.ts`, `e2e/tests/oauth/webui-relay-flow.test.ts`, and `e2e/tests/oauth/electron-local-callback.test.ts`. |
| 6 WebUI callback completes token storage | **Pass** | `server-core/.../oauth-callback.test.ts` + E2E relay chain with exchange capture (`e2e/tests/oauth/webui-relay-flow.test.ts`). |
| 7 OAuth-protected MCP source usable | **Pass (local fixture)** | `e2e/src/harness/oauthProtectedMcpFixture.ts` plus `e2e/tests/oauth/webui-relay-flow.test.ts` prove OAuth approval, token exchange with `resource`, stored-token MCP validation, and `tools/list` success (`get_status`). Real-provider credentials were unavailable. |
| 8 Electron local callback still works | **Pass (macOS automated)** | `e2e/tests/oauth/electron-local-callback.test.ts` uses the real `createCallbackServer`, plain non-relay state, token exchange, source-status push, and stored-token MCP validation. |
| 9 No relay-side token handling | **Pass** | Worker source review: redirect-only (`workers/oauth-callback-relay/src/index.ts`) and worker entrypoint tests. |
| 10 Docs and release notes updated | **Pass** | `apps/electron/resources/docs/sources.md`, `release-notes/next.md`. |
| 11 Targeted tests pass | **Pass** | 93 unit/server tests + 19 OAuth E2E tests (`uat-evidence/electron-20260628-215346/logs/unit-oauth-relay-final2.log`, `logs/e2e-oauth-full-rerun2.log`). |

## E2E coverage added

- `e2e/tests/oauth/oauth.integration.test.ts` — `@oauth` relay/callback chain and MCP prepare paths.
- `e2e/tests/oauth/worker-entrypoint.test.ts` — actual Cloudflare Worker module entrypoint coverage for controlled non-404 errors, success redirects, provider-error forwarding, unsafe return rejection, and allowlist parsing.
- `e2e/src/harness/oauthProtectedMcpFixture.ts` — local OAuth authorization server + OAuth-protected Streamable HTTP MCP fixture.
- `e2e/tests/oauth/webui-relay-flow.test.ts` — full WebUI relay flow against the fixture, including relay wrapping, provider approval, callback exchange capture, real token exchange, and `validateMcpConnection` `tools/list` success.
- `e2e/tests/oauth/electron-local-callback.test.ts` — real local `createCallbackServer` Electron path with non-relay state, token exchange, source status push, and stored-token MCP validation.
- `e2e/tests/web/oauth-relay.spec.ts` — Playwright browser coverage for success and provider-error redirects through the relay into WebUI callback pages.
- `e2e/tests/web/recorded.spec.ts` and `e2e/playwright.codegen.config.ts` — recording template for future WebUI walkthroughs.
- `bun run e2e:web` — Playwright browser tier covers 2 real OAuth relay tests, with the recording template skipped.
- `bun run e2e:oauth` — offline OAuth integration tier covers 19 tests across 4 files.

## Recommendation

**Pending user sign-off** with follow-ups:

1. Deploy `workers/oauth-callback-relay` and re-probe AC1 on production.
2. Run manual OAuth smoke with a real MCP provider (e.g. Linear) after deploy. Local fixture coverage is passing.

## Status

Spec remains `Implemented` at code level. E2E coverage now proves the WebUI relay path in a Playwright browser, OAuth-protected MCP usability via local fixture, and Electron local callback path on macOS. Production sign-off remains blocked on worker deploy and real-provider smoke.
