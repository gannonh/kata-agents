---
type: BuildReport
title: MCP OAuth callback support — build report
description: Build completion report for the MCP OAuth callback relay and MCP resource parameter work.
tags: [mcp, oauth, cloudflare, build]
timestamp: 2026-06-28T00:00:00Z
---

# MCP OAuth callback support — build report

## Spec

- [2026-06-26-mcp-oauth-callback-support-plan.md](./2026-06-26-mcp-oauth-callback-support-plan.md)

## SHAs

- Base SHA: unavailable in this worktree (`git` failed with `relativeworktrees` extension error)
- Final head SHA: unavailable in this worktree

## Tasks completed

1. Added `workers/oauth-callback-relay/` Cloudflare Worker with route config for `agents.kata.sh/auth/callback`.
2. Implemented shared relay handler (`packages/shared/src/auth/oauth-relay-handler.ts`) with state decode, return-target validation, success/error redirect forwarding, and controlled error responses.
3. Added MCP OAuth `resource` canonicalization and wired it through authorization URL construction, token exchange, and the OAuth flow store.
4. Preserved WebUI `/api/oauth/callback` completion path and added Electron no-relay regression coverage.
5. Updated bundled sources docs, release notes, and worker README.

## Files changed

- `workers/oauth-callback-relay/*`
- `packages/shared/src/auth/oauth-relay-handler.ts`
- `packages/shared/src/auth/oauth.ts`
- `packages/shared/src/auth/oauth-flow-types.ts`
- `packages/shared/src/auth/oauth-flow-store.ts`
- `packages/shared/src/auth/index.ts`
- `packages/shared/src/auth/__tests__/oauth-relay-handler.test.ts`
- `packages/shared/src/auth/__tests__/oauth.test.ts`
- `packages/shared/src/sources/__tests__/oauth-relay.test.ts`
- `packages/server-core/src/handlers/rpc/oauth.ts`
- `apps/electron/resources/docs/sources.md`
- `apps/electron/resources/release-notes/next.md`
- `package.json`

## Verification

| Command | Result |
|---------|--------|
| `cd packages/shared && bun test src/auth/__tests__/oauth.test.ts src/auth/__tests__/oauth-relay.test.ts src/auth/__tests__/oauth-relay-handler.test.ts src/sources/__tests__/oauth-relay.test.ts` | pass (91 tests) |
| `cd packages/server-core && bun test src/webui/__tests__/oauth-callback.test.ts` | pass (2 tests) |
| `cd packages/shared && bun run tsc --noEmit` | pass |
| `cd packages/server-core && bun run tsc --noEmit` | pass |

## Review gates

- Spec compliance: implemented against acceptance criteria 1–11 at code/test level.
- Code quality: single-agent path; no dedicated TDD skill was available; tests were written before/alongside production code per TDD best practices.
- Independent subagent review: unavailable in this run.

## Approved deviations

- Worker deployment to Cloudflare was not executed in this environment (requires zone credentials). Route config and README document the deploy step.
- Manual WebUI OAuth smoke with a real OAuth-protected MCP provider was not run (no provider credentials in this environment).
- Manual Electron OAuth smoke was not run; automated regression test covers the no-relay Electron callbackPort path.

## Known follow-ups

- Deploy `workers/oauth-callback-relay` to the `kata.sh` zone and confirm production/staging WebUI origins in `KATA_OAUTH_RELAY_ALLOWED_RETURN_ORIGINS`.
- Run manual end-to-end OAuth smoke against a real provider (for example Linear MCP) after deployment.
- Added E2E integration coverage: `e2e/tests/oauth/oauth.integration.test.ts` (`bun run e2e:oauth`).
- Verify report: [2026-06-26-mcp-oauth-callback-support-verify-report.md](./2026-06-26-mcp-oauth-callback-support-verify-report.md).

## Status update

Spec status updated to `Implemented` in frontmatter and body.
