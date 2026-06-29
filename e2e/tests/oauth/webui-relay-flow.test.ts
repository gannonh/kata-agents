import { afterEach, describe, expect, it } from "bun:test";

import { startOAuthProtectedMcpFixture } from "../../src/harness/oauthProtectedMcpFixture.ts";
import { startOAuthRelayTestServers } from "../../src/harness/oauthRelayServers.ts";
import { SourceCredentialManager } from "../../../packages/shared/src/sources/credential-manager.ts";
import { validateMcpConnection } from "../../../packages/shared/src/mcp/validation.ts";
import { isOAuthRelayState } from "../../../packages/shared/src/auth/oauth-relay.ts";
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
 *   1. SourceCredentialManager.prepareOAuth({ useRelay: true }) wraps the flow.
 *   2. The provider redirects to the relay callback URL with a ca1. state.
 *   3. The relay handler 302-redirects to WebUI /api/oauth/callback.
 *   4. createWebuiHandler + completeOAuthFlow exchanges the code via the harness cred manager.
 *   5. validateMcpConnection proves the OAuth-protected source is usable.
 */
describe("@oauth WebUI full relay flow (AC5, AC6, AC7)", () => {
  it("prepareOAuth wraps for the relay and includes the MCP resource", async () => {
    const fixture = await startOAuthProtectedMcpFixture();
    fixturesToClose.push(fixture);
    const credManager = new SourceCredentialManager();
    const returnTo = "http://127.0.0.1:3100/api/oauth/callback";

    const prepared = await credManager.prepareOAuth(
      createMcpSource(fixture.mcpUrl),
      { callbackUrl: returnTo, useRelay: true },
    );

    expect(prepared.resource).toBe(fixture.mcpUrl);
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
      { callbackUrl: relay.returnTo, useRelay: true },
    );

    const { location: providerRedirect } = await fixture.approveAuthorization({
      authUrl: prepared.authUrl,
    });
    const providerUrl = new URL(providerRedirect);
    const providerState = providerUrl.searchParams.get("state")!;
    const providerCode = providerUrl.searchParams.get("code")!;
    expect(isOAuthRelayState(providerState)).toBe(true);

    const relayUrl = new URL(`${relay.relayBaseUrl}/auth/callback`);
    relayUrl.search = providerUrl.search;
    const relayResponse = await fetch(relayUrl.toString(), { redirect: "manual" });

    expect(relayResponse.status).toBe(302);
    const relayLocation = relayResponse.headers.get("location")!;
    const webuiUrl = new URL(relayLocation);
    expect(webuiUrl.origin).toBe(relay.webuiBaseUrl);
    expect(webuiUrl.pathname).toBe("/api/oauth/callback");
    expect(webuiUrl.searchParams.get("code")).toBe(providerCode);

    const innerState = webuiUrl.searchParams.get("state")!;
    expect(isOAuthRelayState(innerState)).toBe(false);

    relay.setFlow(innerState, {
      flowId: "flow-full",
      state: innerState,
      codeVerifier: prepared.codeVerifier,
      redirectUri: prepared.redirectUri,
      source: createMcpSource(fixture.mcpUrl),
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

    const exchangeCalls = relay.getExchangeCalls();
    expect(exchangeCalls).toHaveLength(1);
    expect(exchangeCalls[0]?.resource).toBe(fixture.mcpUrl);
    expect(exchangeCalls[0]?.redirectUri).toBe("https://agents.kata.sh/auth/callback");

    const storedToken = relay.getStoredAccessToken();
    expect(storedToken).toBeTruthy();

    expect(fixture.tokenRequests[0]?.resource).toBe(fixture.mcpUrl);
    expect(fixture.tokenRequests[0]?.redirect_uri).toBe(
      "https://agents.kata.sh/auth/callback",
    );
    expect(fixture.tokenRequests[0]?.code_verifier).toBe(prepared.codeVerifier);

    const validation = await validateMcpConnection({
      mcpUrl: fixture.mcpUrl,
      mcpAccessToken: storedToken!,
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
      { callbackUrl: relay.returnTo, useRelay: true },
    );

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

    expect(relay.getExchangeCalls()).toHaveLength(0);
    expect(fixture.tokenRequests).toHaveLength(0);
  });
});
