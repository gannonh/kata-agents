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

## Acceptance criteria review

| AC | Result | Evidence |
|----|--------|----------|
| 1 Public callback route exists | **Fail (deploy pending)** | Production probe returns Vercel `DEPLOYMENT_NOT_FOUND` 404 (`responses/production-callback-missing-state.txt`). Local relay E2E proves controlled 400 for missing state (`logs/e2e-oauth.log`). |
| 2 Relay success redirects correctly | **Pass** | `e2e/tests/oauth/oauth.integration.test.ts` + `oauth-relay-handler.test.ts` |
| 3 Relay provider errors forward correctly | **Pass** | `e2e/tests/oauth/oauth.integration.test.ts` + unit tests |
| 4 Relay rejects unsafe return targets | **Pass** | `e2e/tests/oauth/oauth.integration.test.ts` + `oauth-relay-handler.test.ts` |
| 5 MCP resource parameter present | **Pass** | `oauth.test.ts`, `e2e/tests/oauth/oauth.integration.test.ts` |
| 6 WebUI callback completes token storage | **Pass** | `server-core/.../oauth-callback.test.ts` + E2E relay chain with exchange capture |
| 7 OAuth-protected MCP source usable | **Fail (blocked)** | No real provider credentials or local OAuth MCP fixture in UAT environment |
| 8 Electron local callback still works | **Partial** | Automated: `e2e/tests/oauth/oauth.integration.test.ts` (callbackPort, no relay). Manual macOS Electron walkthrough not run (Linux UAT host). |
| 9 No relay-side token handling | **Pass** | Worker source review: redirect-only (`workers/oauth-callback-relay/src/index.ts`) |
| 10 Docs and release notes updated | **Pass** | `apps/electron/resources/docs/sources.md`, `release-notes/next.md` |
| 11 Targeted tests pass | **Pass** | 93 unit + 6 E2E integration (`logs/unit-oauth-relay.log`, `logs/e2e-oauth.log`) |

## E2E coverage added

- `e2e/tests/oauth/oauth.integration.test.ts` — `@oauth` relay/callback chain and MCP prepare paths
- `e2e/src/harness/oauthRelayServers.ts` — local relay + WebUI callback servers
- `bun run e2e:oauth` — Linux-friendly offline integration tier

## Recommendation

**Pending user sign-off** with follow-ups:

1. Deploy `workers/oauth-callback-relay` and re-probe AC1 on production.
2. Run manual OAuth smoke with a real MCP provider (e.g. Linear) after deploy.
3. Run macOS Electron OAuth walkthrough for AC8 manual confirmation.

## Status

Spec remains `Implemented` at code level. Production sign-off blocked on worker deploy and manual provider smoke.
