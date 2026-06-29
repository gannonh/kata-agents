import { afterEach, describe, expect, it } from "bun:test";

import { startOAuthProtectedMcpFixture } from "../../src/harness/oauthProtectedMcpFixture.ts";
import { startOAuthRelayTestServers } from "../../src/harness/oauthRelayServers.ts";
import { SourceCredentialManager } from "../../../packages/shared/src/sources/credential-manager.ts";
import { exchangeMcpOAuth } from "../../../packages/shared/src/auth/oauth.ts";
import { validateMcpConnection } from "../../../packages/shared/src/mcp/validation.ts";
import {
  decodeOAuthRelayState,
  isOAuthRelayState,
} from "../../../packages/shared/src/auth/oauth-relay.ts";
import type { LoadedSource } from "../../../packages/shared/src/sources/types.ts";

const fixturesToClose: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (fixturesToClose.length > 0) {
    const fixture = fixturesToClose.pop();
    if (fixture) await fixture.close();
  }
});

function createMcpSource(mcpUrl: string, slug = "fixture-mcp"): LoadedSource {
  return {
    config: {
      id: "mcp-fixture",
      slug,
      name: "Fixture OAuth MCP",
      type: "mcp",
      enabled: true,
      mcp: {
        url: mcpUrl,
        authType: "oauth",
      },
    },
    folderPath: "/tmp/mcp-fixture",
    isLoaded: true,
  } as LoadedSource;
}

/**
 * Full WebUI relay flow against a local OAuth-protected MCP fixture.
 *
 * Exercises the complete production chain without real provider credentials:
 *   1. SourceCredentialManager.prepareOAuth(callbackUrl) wraps the flow for the relay
 *      (redirect_uri = https://agents.kata.sh/auth/callback, state = ca1. envelope).
 *   2. The provider redirects to the relay callback URL with a ca1. state.
 *   3. The local relay handler decodes the state and 302-redirects to the
 *      WebUI /api/oauth/callback with the provider code and the inner state.
 *   4. completeOAuthFlow (simulated via exchangeMcpOAuth) exchanges the code
 *      for a token, recording that resource + redirect_uri were sent.
 *   5. validateMcpConnection with the stored token lists the MCP tool,
 *      proving the OAuth-protected source is usable.
 *
 * Covers AC5 (resource param), AC6 (callback completes token storage), and
 * AC7 (OAuth-protected MCP source becomes usable) with a local fixture.
 */
describe("@oauth WebUI full relay flow (AC5, AC6, AC7)", () => {
  it("prepareOAuth wraps for the relay and includes the MCP resource", async () => {
    const fixture = await startOAuthProtectedMcpFixture();
    fixturesToClose.push(fixture);
    const credManager = new SourceCredentialManager();
    const returnTo = "http://127.0.0.1:3100/api/oauth/callback";

    const prepared = await credManager.prepareOAuth(
      createMcpSource(fixture.mcpUrl),
      { callbackUrl: returnTo },
    );

    // AC5: resource is the normalized MCP URL.
    expect(prepared.resource).toBe(fixture.mcpUrl);

    // Relay wrapping: provider-facing redirect_uri is the public relay, state is ca1.
    expect(prepared.redirectUri).toBe("https://agents.kata.sh/auth/callback");
    const authUrl = new URL(prepared.authUrl);
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      "https://agents.kata.sh/auth/callback",
    );
    expect(authUrl.searchParams.get("resource")).toBe(fixture.mcpUrl);
    expect(isOAuthRelayState(authUrl.searchParams.get("state")!)).toBe(true);
  });

  it("completes the relay callback chain and makes the MCP source usable", async () => {
    const fixture = await startOAuthProtectedMcpFixture();
    fixturesToClose.push(fixture);
    const relay = await startOAuthRelayTestServers();
    fixturesToClose.push(relay);

    const credManager = new SourceCredentialManager();
    const prepared = await credManager.prepareOAuth(
      createMcpSource(fixture.mcpUrl),
      { callbackUrl: relay.returnTo },
    );

    // 1. Simulate the user approving consent in the browser. The provider
    //    redirects to the public relay callback URL with the ca1. state.
    const { location: providerRedirect } = await fixture.approveAuthorization({
      authUrl: prepared.authUrl,
    });
    const providerUrl = new URL(providerRedirect);
    const providerState = providerUrl.searchParams.get("state")!;
    const providerCode = providerUrl.searchParams.get("code")!;
    expect(isOAuthRelayState(providerState)).toBe(true);

    // 2. Drive the relay handler with the provider's redirect to the relay.
    //    (relay.relayBaseUrl stands in for https://agents.kata.sh.)
    const relayUrl = new URL(`${relay.relayBaseUrl}/auth/callback`);
    relayUrl.search = providerUrl.search;
    const relayResponse = await fetch(relayUrl.toString(), { redirect: "manual" });

    expect(relayResponse.status).toBe(302);
    const relayLocation = relayResponse.headers.get("location")!;
    const webuiUrl = new URL(relayLocation);
    expect(webuiUrl.origin).toBe(relay.webuiBaseUrl);
    expect(webuiUrl.pathname).toBe("/api/oauth/callback");
    expect(webuiUrl.searchParams.get("code")).toBe(providerCode);

    // The inner state is what the server stored; the relay must unwrap it.
    const innerState = webuiUrl.searchParams.get("state")!;
    expect(isOAuthRelayState(innerState)).toBe(false);

    // 3. Seed the WebUI callback flow store (as oauth:start would) and hit the
    //    WebUI /api/oauth/callback, which performs the token exchange.
    relay.setFlow(innerState, {
      flowId: "flow-full",
      state: innerState,
      codeVerifier: prepared.codeVerifier,
      redirectUri: prepared.redirectUri,
      source: { config: { slug: "fixture-mcp" } },
      clientId: prepared.clientId,
      clientSecret: prepared.clientSecret,
      tokenEndpoint: prepared.tokenEndpoint,
      provider: "mcp",
      resource: prepared.resource,
      ownerClientId: "owner",
      workspaceId: "workspace-1",
      sourceSlug: "fixture-mcp",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });

    const callbackResponse = await fetch(relayLocation);
    expect(callbackResponse.status).toBe(200);
    expect(await callbackResponse.text()).toContain("Authorization Successful");

    // AC6: the WebUI callback captured the exchange params it would forward
    //    to the token endpoint, including the MCP resource and relay redirect_uri.
    const exchangeCalls = relay.getExchangeCalls();
    expect(exchangeCalls).toHaveLength(1);
    expect(exchangeCalls[0]?.resource).toBe(fixture.mcpUrl);
    expect(exchangeCalls[0]?.redirectUri).toBe("https://agents.kata.sh/auth/callback");

    // 5. AC7: the stored token makes the MCP source usable.
    //    Perform the real token exchange against the fixture's /token endpoint
    //    (the test relay's WebUI callback is a recording stub by design), then
    //    validate the MCP connection with the issued access token.
    const stored = await exchangeMcpOAuth({
      code: providerCode,
      codeVerifier: prepared.codeVerifier,
      tokenEndpoint: prepared.tokenEndpoint,
      clientId: prepared.clientId,
      clientSecret: prepared.clientSecret,
      redirectUri: prepared.redirectUri,
      resource: prepared.resource,
    });
    expect(stored.success).toBe(true);
    expect(stored.accessToken).toBeTruthy();

    // AC5 at the token endpoint: the fixture recorded resource + redirect_uri.
    expect(fixture.tokenRequests[0]?.resource).toBe(fixture.mcpUrl);
    expect(fixture.tokenRequests[0]?.redirect_uri).toBe(
      "https://agents.kata.sh/auth/callback",
    );
    expect(fixture.tokenRequests[0]?.code_verifier).toBe(prepared.codeVerifier);

    const validation = await validateMcpConnection({
      mcpUrl: fixture.mcpUrl,
      mcpAccessToken: stored.accessToken!,
    });
    expect(validation.success).toBe(true);
    expect(validation.tools).toEqual(["get_status"]);
  });

  it("forwards a provider error through the relay to a failed WebUI callback", async () => {
    const fixture = await startOAuthProtectedMcpFixture();
    fixturesToClose.push(fixture);
    const relay = await startOAuthRelayTestServers();
    fixturesToClose.push(relay);

    const credManager = new SourceCredentialManager();
    const prepared = await credManager.prepareOAuth(
      createMcpSource(fixture.mcpUrl),
      { callbackUrl: relay.returnTo },
    );

    // Build a provider error redirect to the relay (no consent given).
    const providerUrl = new URL(prepared.authUrl);
    const errorRedirect = new URL("https://agents.kata.sh/auth/callback");
    errorRedirect.searchParams.set("error", "access_denied");
    errorRedirect.searchParams.set("error_description", "User denied");
    errorRedirect.searchParams.set("state", providerUrl.searchParams.get("state")!);

    const relayUrl = new URL(`${relay.relayBaseUrl}/auth/callback`);
    relayUrl.search = errorRedirect.search;
    const relayResponse = await fetch(relayUrl.toString(), { redirect: "manual" });

    expect(relayResponse.status).toBe(302);
    const relayLocation = relayResponse.headers.get("location")!;
    const webuiUrl = new URL(relayLocation);
    expect(webuiUrl.searchParams.get("error")).toBe("access_denied");
    expect(webuiUrl.searchParams.get("error_description")).toBe("User denied");

    const innerState = webuiUrl.searchParams.get("state")!;
    relay.setFlow(innerState, { state: innerState });

    const callbackResponse = await fetch(relayLocation);
    expect(callbackResponse.status).toBe(200);
    const body = await callbackResponse.text();
    expect(body).toContain("Authorization Failed");
    expect(body).toContain("User denied");

    // No token exchange should have happened on the error path.
    expect(relay.getExchangeCalls()).toHaveLength(0);
    expect(fixture.tokenRequests).toHaveLength(0);
  });
});
