import { afterEach, describe, expect, it } from "bun:test";

import { startOAuthRelayTestServers } from "../../src/harness/oauthRelayServers.ts";
import { encodeOAuthRelayState } from "../../../packages/shared/src/auth/oauth-relay.ts";
import { SourceCredentialManager } from "../../../packages/shared/src/sources/credential-manager.ts";
import type { LoadedSource } from "../../../packages/shared/src/sources/types.ts";
import { isOAuthRelayState } from "../../../packages/shared/src/auth/oauth-relay.ts";

const serversToClose: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (serversToClose.length > 0) {
    const server = serversToClose.pop();
    if (server) await server.close();
  }
});

async function startServers() {
  const servers = await startOAuthRelayTestServers();
  serversToClose.push(servers);
  return servers;
}

function createMcpSource(mcpUrl: string): LoadedSource {
  return {
    config: {
      id: "mcp-e2e",
      slug: "linear-mcp",
      name: "Linear MCP",
      type: "mcp",
      enabled: true,
      mcp: {
        url: mcpUrl,
        authType: "oauth",
      },
    },
    folderPath: "/tmp/mcp-e2e",
    isLoaded: true,
  } as LoadedSource;
}

function requestTarget(url: string | URL | Request): string {
  if (typeof url === "string") {
    return url;
  }

  if (url instanceof URL) {
    return url.toString();
  }

  return url.url;
}

function mockMcpMetadataFetch(): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = requestTarget(url);
    if (init?.method === "HEAD") {
      return new Response(null, { status: 200 });
    }
    if (target.endsWith("/.well-known/oauth-authorization-server")) {
      return new Response(
        JSON.stringify({
          authorization_endpoint: "https://mcp.linear.app/oauth/authorize",
          token_endpoint: "https://mcp.linear.app/oauth/token",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
}

describe("@oauth relay callback chain", () => {
  it("relay rejects missing state with a controlled non-404 error", async () => {
    const servers = await startServers();
    const response = await fetch(`${servers.relayBaseUrl}/auth/callback?code=auth-code-123`, {
      redirect: "manual",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Missing OAuth state parameter");
  });

  it("relay success redirects to WebUI callback and completes token storage", async () => {
    const servers = await startServers();
    const innerState = "inner-state-e2e-success";
    servers.setFlow(innerState, {
      flowId: "flow-e2e",
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
    const relayResponse = await fetch(
      `${servers.relayBaseUrl}/auth/callback?code=auth-code-123&state=${encodeURIComponent(relayState)}`,
      { redirect: "manual" },
    );

    expect(relayResponse.status).toBe(302);
    const location = relayResponse.headers.get("location");
    expect(location).toBeTruthy();
    expect(location).toContain("/api/oauth/callback");
    expect(location).toContain("code=auth-code-123");
    expect(location).toContain(`state=${innerState}`);

    const callbackResponse = await fetch(location!);
    expect(callbackResponse.status).toBe(200);
    expect(await callbackResponse.text()).toContain("Authorization Successful");

    const exchangeCalls = servers.getExchangeCalls();
    expect(exchangeCalls).toHaveLength(1);
    expect(exchangeCalls[0]?.resource).toBe("https://mcp.linear.app/sse");
  });

  it("relay forwards provider errors to WebUI callback", async () => {
    const servers = await startServers();
    const innerState = "inner-state-e2e-error";
    servers.setFlow(innerState, { state: innerState });

    const relayState = encodeOAuthRelayState(servers.returnTo, innerState);
    const relayResponse = await fetch(
      `${servers.relayBaseUrl}/auth/callback?error=access_denied&error_description=User%20denied&state=${encodeURIComponent(relayState)}`,
      { redirect: "manual" },
    );

    expect(relayResponse.status).toBe(302);
    const location = relayResponse.headers.get("location");
    expect(location).toContain("error=access_denied");
    expect(location).toContain(`state=${innerState}`);

    const callbackResponse = await fetch(location!);
    expect(callbackResponse.status).toBe(200);
    const body = await callbackResponse.text();
    expect(body).toContain("Authorization Failed");
    expect(body).toContain("User denied");
  });

  it("relay rejects unsafe return targets encoded in relay state", async () => {
    const servers = await startServers();
    const relayState = encodeOAuthRelayState("https://evil.example/api/oauth/callback", "inner-state");
    const response = await fetch(
      `${servers.relayBaseUrl}/auth/callback?code=auth-code-123&state=${encodeURIComponent(relayState)}`,
      { redirect: "manual" },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Return target origin is not allowed");
  });
});

describe("@oauth MCP OAuth prepare", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("WebUI prepare uses relay redirect URI and MCP resource", async () => {
    mockMcpMetadataFetch();
    const credManager = new SourceCredentialManager();
    const prepared = await credManager.prepareOAuth(createMcpSource("HTTPS://MCP.Linear.APP/sse?x=1#frag"), {
      callbackUrl: "https://agents.kata.sh/api/oauth/callback",
    });

    expect(prepared.redirectUri).toBe("https://agents.kata.sh/auth/callback");
    expect(prepared.resource).toBe("https://mcp.linear.app/sse");

    const authUrl = new URL(prepared.authUrl);
    expect(authUrl.searchParams.get("redirect_uri")).toBe("https://agents.kata.sh/auth/callback");
    expect(authUrl.searchParams.get("resource")).toBe("https://mcp.linear.app/sse");
    expect(isOAuthRelayState(authUrl.searchParams.get("state")!)).toBe(true);
  });

  it("Electron prepare keeps local callback server and skips relay state", async () => {
    mockMcpMetadataFetch();
    const credManager = new SourceCredentialManager();
    const prepared = await credManager.prepareOAuth(createMcpSource("https://mcp.linear.app/sse"), {
      callbackPort: 8914,
    });

    expect(prepared.redirectUri).toBe("http://localhost:8914/oauth/callback");
    const authUrl = new URL(prepared.authUrl);
    expect(authUrl.searchParams.get("redirect_uri")).toBe("http://localhost:8914/oauth/callback");
    expect(isOAuthRelayState(authUrl.searchParams.get("state")!)).toBe(false);
  });
});
