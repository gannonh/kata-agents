import { describe, expect, it } from "bun:test";

// Import the actual Cloudflare Worker default export. Driving it with real
// Request objects proves the worker runtime entrypoint (the module that
// wrangler deploys to agents.kata.sh/auth/callback) serves the callback route
// with controlled non-404 responses and correct 302 redirects.
import worker, { type Env } from "../../../workers/oauth-callback-relay/src/index.ts";
import { encodeOAuthRelayState } from "../../../packages/shared/src/auth/oauth-relay.ts";

const PRODUCTION_ORIGIN = "https://agents.kata.sh";
const PRODUCTION_CALLBACK = `${PRODUCTION_ORIGIN}/auth/callback`;
const PRODUCTION_RETURN_TO = `${PRODUCTION_ORIGIN}/api/oauth/callback`;

function callWorker(
  url: string,
  env: Env = { KATA_OAUTH_RELAY_ALLOWED_RETURN_ORIGINS: PRODUCTION_ORIGIN },
  method: "GET" | "POST" = "GET",
): Promise<Response> {
  return worker.fetch(new Request(url, { method }), env);
}

describe("@oauth worker entrypoint (AC1: public callback route)", () => {
  it("returns a controlled 400 (not 404) for missing state", async () => {
    const response = await callWorker(`${PRODUCTION_CALLBACK}?code=auth-code-123`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Missing OAuth state parameter");
    // The header that proves it is not the Vercel DEPLOYMENT_NOT_FOUND 404.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns a controlled 400 for malformed relay state", async () => {
    const response = await callWorker(`${PRODUCTION_CALLBACK}?code=x&state=ca1.not-valid`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid OAuth relay state");
  });

  it("returns 405 for non-GET methods", async () => {
    const response = await callWorker(PRODUCTION_CALLBACK, {}, "POST");
    expect(response.status).toBe(405);
  });

  it("redirects valid success callbacks to /api/oauth/callback with code and inner state (AC2)", async () => {
    const relayState = encodeOAuthRelayState(PRODUCTION_RETURN_TO, "inner-state-worker");
    const response = await callWorker(
      `${PRODUCTION_CALLBACK}?code=auth-code-123&state=${encodeURIComponent(relayState)}`,
    );
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toBe(
      `${PRODUCTION_RETURN_TO}?code=auth-code-123&state=inner-state-worker`,
    );
  });

  it("forwards provider errors to /api/oauth/callback with inner state (AC3)", async () => {
    const relayState = encodeOAuthRelayState(PRODUCTION_RETURN_TO, "inner-state-err");
    const response = await callWorker(
      `${PRODUCTION_CALLBACK}?error=access_denied&error_description=User%20denied&state=${encodeURIComponent(relayState)}`,
    );
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toContain("error=access_denied");
    expect(location).toContain("error_description=User+denied");
    expect(location).toContain("state=inner-state-err");
  });

  it("rejects unsafe return targets encoded in relay state (AC4)", async () => {
    const relayState = encodeOAuthRelayState(
      "https://evil.example/api/oauth/callback",
      "inner-state",
    );
    const response = await callWorker(
      `${PRODUCTION_CALLBACK}?code=x&state=${encodeURIComponent(relayState)}`,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Return target origin is not allowed");
  });

  it("accepts localhost dev return targets when the hosted allowlist is configured", async () => {
    const devReturnTo = "http://localhost:3100/api/oauth/callback";
    const relayState = encodeOAuthRelayState(devReturnTo, "inner-dev");
    const response = await callWorker(
      `${PRODUCTION_CALLBACK}?code=dev-code&state=${encodeURIComponent(relayState)}`,
    );
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toBe(`${devReturnTo}?code=dev-code&state=inner-dev`);
  });

  it("parses the production KATA_OAUTH_RELAY_ALLOWED_RETURN_ORIGINS env var", async () => {
    const staging = "https://staging.agents.kata.sh";
    const relayState = encodeOAuthRelayState(
      `${staging}/api/oauth/callback`,
      "inner-staging",
    );
    const response = await callWorker(
      `${PRODUCTION_CALLBACK}?code=x&state=${encodeURIComponent(relayState)}`,
      { KATA_OAUTH_RELAY_ALLOWED_RETURN_ORIGINS: `${PRODUCTION_ORIGIN}, ${staging}` },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("staging.agents.kata.sh");
  });
});
