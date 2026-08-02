import { expect, test } from "@playwright/test";

import { startOAuthProtectedMcpFixture } from "../../src/harness/oauthProtectedMcpFixture.ts";
import { startOAuthRelayTestServers } from "../../src/harness/oauthRelayServers.ts";
import { SourceCredentialManager } from "../../../packages/shared/src/sources/credential-manager.ts";
import type { LoadedSource } from "../../../packages/shared/src/sources/types.ts";
import { encodeOAuthRelayState } from "../../../packages/shared/src/auth/oauth-relay.ts";

async function withOAuthRelayServers<T>(
  run: (
    servers: Awaited<ReturnType<typeof startOAuthRelayTestServers>>,
  ) => Promise<T>,
): Promise<T> {
  const servers = await startOAuthRelayTestServers();
  try {
    return await run(servers);
  } finally {
    await servers.close();
  }
}

function createMcpSource(mcpUrl: string): LoadedSource {
  return {
    config: {
      id: "playwright-mcp",
      slug: "playwright-mcp",
      name: "Playwright OAuth MCP",
      type: "mcp",
      enabled: true,
      mcp: { url: mcpUrl, authType: "oauth" },
    },
    folderPath: "/tmp/playwright-mcp",
    isLoaded: true,
  } as LoadedSource;
}

test.describe("WebUI OAuth relay @oauth", () => {
  test("browser follows relay success to WebUI callback page", async ({
    page,
  }) => {
    const fixture = await startOAuthProtectedMcpFixture();
    const servers = await startOAuthRelayTestServers();
    try {
      const source = createMcpSource(fixture.mcpUrl);
      const credentialManager = new SourceCredentialManager();
      const prepared = await credentialManager.prepareOAuth(source, {
        callbackUrl: servers.returnTo,
        useRelay: true,
      });
      const { location: providerRedirect } = await fixture.approveAuthorization(
        {
          authUrl: prepared.authUrl,
        },
      );
      const providerUrl = new URL(providerRedirect);
      const relayUrl = new URL(`${servers.relayBaseUrl}/auth/callback`);
      relayUrl.search = providerUrl.search;

      const relayResponse = await fetch(relayUrl, { redirect: "manual" });
      expect(relayResponse.status).toBe(302);
      const callbackUrl = new URL(relayResponse.headers.get("location")!);
      const innerState = callbackUrl.searchParams.get("state")!;
      servers.setFlow(innerState, {
        flowId: "flow-playwright",
        state: innerState,
        codeVerifier: prepared.codeVerifier,
        redirectUri: prepared.redirectUri,
        source,
        clientId: prepared.clientId,
        clientSecret: prepared.clientSecret,
        tokenEndpoint: prepared.tokenEndpoint,
        provider: "mcp",
        resource: prepared.resource,
        ownerClientId: "owner",
        workspaceId: "workspace-1",
        sourceSlug: source.config.slug,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });

      await page.goto(relayUrl.toString());
      await expect(page).toHaveURL(/\/api\/oauth\/callback/);
      await expect(
        page.getByText("Authorization successful", { exact: true }),
      ).toBeVisible();

      const exchangeCalls = servers.getExchangeCalls();
      expect(exchangeCalls).toHaveLength(1);
      expect(exchangeCalls[0]?.resource).toBe(fixture.mcpUrl);
      expect(fixture.tokenRequests[0]?.resource).toBe(fixture.mcpUrl);
    } finally {
      await servers.close();
      await fixture.close();
    }
  });

  test("browser follows provider errors to WebUI failure page", async ({
    page,
  }) => {
    await withOAuthRelayServers(async (servers) => {
      const innerState = "playwright-inner-error";
      servers.setFlow(innerState, { state: innerState });

      const relayState = encodeOAuthRelayState(servers.returnTo, innerState);
      await page.goto(
        `${servers.relayBaseUrl}/auth/callback?error=access_denied&error_description=User%20denied&state=${encodeURIComponent(relayState)}`,
      );

      await expect(page).toHaveURL(/\/api\/oauth\/callback/);
      await expect(
        page.getByText("Authorization failed: User denied", { exact: true }),
      ).toBeVisible();
    });
  });
});
