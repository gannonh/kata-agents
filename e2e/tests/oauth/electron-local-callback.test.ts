import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startOAuthProtectedMcpFixture } from "../../src/harness/oauthProtectedMcpFixture.ts";
import { createCallbackServer } from "../../../packages/shared/src/auth/callback-server.ts";
import { completeOAuthFlow } from "../../../packages/server-core/src/handlers/rpc/oauth.ts";
import { OAuthFlowStore } from "../../../packages/shared/src/auth/oauth-flow-store.ts";
import { validateMcpConnection } from "../../../packages/shared/src/mcp/validation.ts";
import { exchangeMcpOAuth } from "../../../packages/shared/src/auth/oauth.ts";
import { SourceCredentialManager } from "../../../packages/shared/src/sources/credential-manager.ts";
import { isOAuthRelayState } from "../../../packages/shared/src/auth/oauth-relay.ts";
import type { LoadedSource } from "../../../packages/shared/src/sources/types.ts";

const fixturesToClose: Array<{ close: () => Promise<void> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (fixturesToClose.length > 0) {
    const fixture = fixturesToClose.pop();
    if (fixture) await fixture.close();
  }
});

function createMcpSource(mcpUrl: string, workspaceRootPath: string): LoadedSource {
  const dir = mkdtempSync(join(tmpdir(), "kata-electron-oauth-src-"));
  tempDirs.push(dir);
  return {
    config: {
      id: "mcp-electron",
      slug: "electron-fixture-mcp",
      name: "Electron Fixture MCP",
      type: "mcp",
      enabled: true,
      mcp: { url: mcpUrl, authType: "oauth" },
    },
    folderPath: dir,
    workspaceRootPath,
    workspaceId: "ws-electron",
    isLoaded: true,
  } as LoadedSource;
}

/**
 * Electron local OAuth callback path (AC8).
 *
 * Mirrors apps/electron/src/preload/bootstrap.ts performOAuth:
 *   1. createCallbackServer (local, http://localhost:<port>/callback) — no relay.
 *   2. SourceCredentialManager.prepareOAuth(callbackUrl) — redirect_uri is
 *      http://localhost:<port>/callback, state is a plain CSRF token
 *      (NOT a ca1. relay envelope).
 *   3. The user approves consent; the provider redirects to the local server.
 *   4. completeOAuthFlow exchanges the code for a token and stores the credential.
 *   5. validateMcpConnection with the stored token lists the MCP tool.
 *
 * Proves Electron OAuth uses the local callback server and does NOT require the
 * Cloudflare relay for local desktop flows.
 */
describe("@oauth Electron local callback (AC8)", () => {
  it("prepareOAuth uses the local callback server and a plain (non-relay) state", async () => {
    const fixture = await startOAuthProtectedMcpFixture();
    fixturesToClose.push(fixture);
    const credManager = new SourceCredentialManager();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "kata-electron-oauth-ws-"));
    tempDirs.push(workspaceRoot);
    const source = createMcpSource(fixture.mcpUrl, workspaceRoot);

    const prepared = await credManager.prepareOAuth(source, { callbackPort: 6477 });

    // Local callback server redirect URI, not the public relay.
    expect(prepared.redirectUri).toBe("http://localhost:6477/oauth/callback");
    const authUrl = new URL(prepared.authUrl);
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      "http://localhost:6477/oauth/callback",
    );
    // Plain state — the Electron path skips relay wrapping.
    expect(isOAuthRelayState(prepared.state)).toBe(false);
    expect(isOAuthRelayState(authUrl.searchParams.get("state")!)).toBe(false);
    // AC5: resource is still present on the Electron path.
    expect(prepared.resource).toBe(fixture.mcpUrl);
    expect(authUrl.searchParams.get("resource")).toBe(fixture.mcpUrl);
  });

  it("completes OAuth via the real local callback server and makes the source usable", async () => {
    const fixture = await startOAuthProtectedMcpFixture();
    fixturesToClose.push(fixture);
    const workspaceRoot = mkdtempSync(join(tmpdir(), "kata-electron-oauth-ws-"));
    tempDirs.push(workspaceRoot);
    const source = createMcpSource(fixture.mcpUrl, workspaceRoot);

    // 1. Start the real local callback server (Electron preload path).
    const callbackServer = await createCallbackServer({ appType: "electron" });
    fixturesToClose.push({ close: async () => { await callbackServer.close(); } });
    const port = Number(new URL(callbackServer.url).port);

    // 2. Prepare the flow with the exact local callback URL used by
    //    apps/electron/src/preload/bootstrap.ts performOAuth.
    const credManager = new SourceCredentialManager();
    const callbackUrl = `${callbackServer.url}/callback`;
    const prepared = await credManager.prepareOAuth(source, { callbackUrl });
    expect(prepared.redirectUri).toBe(callbackUrl);
    expect(isOAuthRelayState(new URL(prepared.authUrl).searchParams.get("state")!)).toBe(false);

    // 3. Simulate the user approving consent. The provider redirects to the
    //    local callback server (http://localhost:<port>/oauth/callback).
    const { location } = await fixture.approveAuthorization({
      authUrl: prepared.authUrl,
    });
    const providerUrl = new URL(location);
    expect(providerUrl.origin).toBe(`http://localhost:${port}`);
    expect(providerUrl.pathname).toBe("/callback");
    const code = providerUrl.searchParams.get("code")!;
    const state = providerUrl.searchParams.get("state")!;
    expect(state).toBe(prepared.state);
    expect(isOAuthRelayState(state)).toBe(false);

    // 4. Drive the callback server (as a browser redirect would) and wait for
    //    it to resolve the callback payload.
    const callbackPromise = callbackServer.promise;
    // Fire the request; the callback server resolves the promise and closes.
    await fetch(`http://localhost:${port}${providerUrl.pathname}?${providerUrl.searchParams.toString()}`).catch(() => {});
    const callback = await callbackPromise;
    expect(callback.query.code).toBe(code);
    expect(callback.query.state).toBe(state);

    // 5. completeOAuthFlow: exchange the code and store the credential.
    const flowStore = new OAuthFlowStore();
    flowStore.store({
      flowId: "flow-electron",
      state: prepared.state,
      codeVerifier: prepared.codeVerifier,
      redirectUri: prepared.redirectUri,
      source,
      clientId: prepared.clientId,
      clientSecret: prepared.clientSecret,
      tokenEndpoint: prepared.tokenEndpoint,
      provider: "mcp",
      resource: prepared.resource,
      ownerClientId: "client-electron",
      workspaceId: "ws-electron",
      sourceSlug: "electron-fixture-mcp",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });

    // Hermetic credManager: real exchangeMcpOAuth + capture the stored token.
    let storedToken: string | undefined;
    const hermeticCredManager = {
      async exchangeAndStore(
        _source: LoadedSource,
        _provider: string,
        params: { code: string; codeVerifier: string; tokenEndpoint: string; clientId: string; clientSecret?: string; redirectUri: string; resource?: string },
      ) {
        const result = await exchangeMcpOAuth(params);
        if (result.success && result.accessToken) {
          storedToken = result.accessToken;
        }
        return { success: result.success, error: result.error, email: result.email };
      },
    };
    const sessionManager = { completeAuthRequest: async () => {} };
    let sourcesChangedPushed = false;
    const pushSourcesChanged = () => {
      sourcesChangedPushed = true;
    };

    try {
      const result = await completeOAuthFlow({
        code,
        state: prepared.state,
        flowStore,
        credManager: hermeticCredManager as unknown as Parameters<typeof completeOAuthFlow>[0]["credManager"],
        sessionManager: sessionManager as unknown as Parameters<typeof completeOAuthFlow>[0]["sessionManager"],
        pushSourcesChanged,
        logger: { info: () => {} },
        clientId: "client-electron",
        workspaceId: "ws-electron",
      });

      // AC6: the flow completed and the source status update was pushed.
      expect(result.success).toBe(true);
      expect(sourcesChangedPushed).toBe(true);
      expect(storedToken).toBeTruthy();
      // The flow was removed from the store after completion.
      expect(flowStore.getByState(prepared.state)).toBeNull();

      // AC5 at the token endpoint: the fixture recorded resource + redirect_uri.
      expect(fixture.tokenRequests[0]?.resource).toBe(fixture.mcpUrl);
      expect(fixture.tokenRequests[0]?.redirect_uri).toBe(prepared.redirectUri);

      // AC7/AC8: the stored token makes the MCP source usable via the local path.
      const validation = await validateMcpConnection({
        mcpUrl: fixture.mcpUrl,
        mcpAccessToken: storedToken!,
      });
      expect(validation.success).toBe(true);
      expect(validation.tools).toEqual(["get_status"]);
    } finally {
      flowStore.dispose();
    }
  });
});
