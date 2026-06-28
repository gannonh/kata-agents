# OAuth callback relay worker

Stateless Cloudflare Worker that serves `https://agents.kata.sh/auth/callback`.

The worker decodes the outer `ca1.` relay state envelope, validates the encoded return target, and redirects the browser to the deployment-local `/api/oauth/callback` endpoint with provider query parameters and the inner OAuth state.

## Local development

```bash
cd workers/oauth-callback-relay
bun install
bun run dev
```

## Tests

Relay behavior is tested in the shared package:

```bash
cd packages/shared && bun test src/auth/__tests__/oauth-relay-handler.test.ts
```

## Deployment

1. Confirm hosted WebUI origins in `wrangler.toml` (`KATA_OAUTH_RELAY_ALLOWED_RETURN_ORIGINS`).
2. Deploy with Cloudflare credentials configured for the `kata.sh` zone:

```bash
cd workers/oauth-callback-relay
bun run deploy
```

The worker does not store OAuth state, exchange authorization codes, or persist tokens.
