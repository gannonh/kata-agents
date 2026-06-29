import { expect, test } from "@playwright/test";

import { startOAuthRelayTestServers } from "../../src/harness/oauthRelayServers.ts";
import { encodeOAuthRelayState } from "../../../packages/shared/src/auth/oauth-relay.ts";

async function withOAuthRelayServers<T>(
  run: (servers: Awaited<ReturnType<typeof startOAuthRelayTestServers>>) => Promise<T>,
): Promise<T> {
  const servers = await startOAuthRelayTestServers();
  try {
    return await run(servers);
  } finally {
    await servers.close();
  }
}

test.describe("WebUI OAuth relay @oauth", () => {
  test("browser follows relay success to WebUI callback page", async ({ page }) => {
    await withOAuthRelayServers(async (servers) => {
      const innerState = "playwright-inner-success";
      servers.setFlow(innerState, {
        flowId: "flow-playwright",
        state: innerState,
        codeVerifier: "verifier",
        redirectUri: "https://agents.kata.sh/auth/callback",
        source: { config: { slug: "linear-mcp" } },
        clientId: "client-id",
        clientSecret: "client-secret",
        tokenEndpoint: "https://example.com/oauth/token",
        provider: "mcp",
        resource: "https://mcp.linear.app/sse",
        ownerClientId: "owner",
        workspaceId: "workspace-1",
        sourceSlug: "linear-mcp",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });

      const relayState = encodeOAuthRelayState(servers.returnTo, innerState);
      await page.goto(
        `${servers.relayBaseUrl}/auth/callback?code=auth-code-123&state=${encodeURIComponent(relayState)}`,
      );

      await expect(page).toHaveURL(/\/api\/oauth\/callback/);
      await expect(page.getByRole("heading", { name: "Authorization Successful" })).toBeVisible();
      await expect(page.getByText("Authorization successful", { exact: true })).toBeVisible();

      const exchangeCalls = servers.getExchangeCalls();
      expect(exchangeCalls).toHaveLength(1);
      expect(exchangeCalls[0]?.resource).toBe("https://mcp.linear.app/sse");
    });
  });

  test("browser follows provider errors to WebUI failure page", async ({ page }) => {
    await withOAuthRelayServers(async (servers) => {
      const innerState = "playwright-inner-error";
      servers.setFlow(innerState, { state: innerState });

      const relayState = encodeOAuthRelayState(servers.returnTo, innerState);
      await page.goto(
        `${servers.relayBaseUrl}/auth/callback?error=access_denied&error_description=User%20denied&state=${encodeURIComponent(relayState)}`,
      );

      await expect(page).toHaveURL(/\/api\/oauth\/callback/);
      await expect(page.getByRole("heading", { name: "Authorization Failed" })).toBeVisible();
      await expect(page.getByText("User denied")).toBeVisible();
    });
  });
});
