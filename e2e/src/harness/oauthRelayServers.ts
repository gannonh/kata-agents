import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWebuiHandler } from "../../../packages/server-core/src/webui/http-server.ts";
import { exchangeMcpOAuth } from "../../../packages/shared/src/auth/mcp-oauth.ts";
import {
  handleOAuthRelayCallback,
  oauthRelayErrorResponse,
} from "../../../packages/shared/src/auth/oauth-relay-handler.ts";
import { OAuthFlowStore } from "../../../packages/shared/src/auth/oauth-flow-store.ts";
import type { LoadedSource } from "../../../packages/shared/src/sources/types.ts";
import type { PendingOAuthFlow } from "../../../packages/shared/src/auth/oauth-flow-store.ts";

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

export interface OAuthRelayTestServers {
  relayBaseUrl: string;
  webuiBaseUrl: string;
  returnTo: string;
  setFlow: (state: string, flow: Partial<PendingOAuthFlow> & { state: string }) => void;
  getExchangeCalls: () => Array<Record<string, unknown>>;
  getStoredAccessToken: () => string | undefined;
  close: () => Promise<void>;
}

function nodeRequestListener(
  fetchHandler: (req: Request) => Promise<Response>,
): (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void {
  return async (req, res) => {
    const host = req.headers.host ?? "127.0.0.1";
    const url = `http://${host}${req.url ?? "/"}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      } else {
        headers.set(key, value);
      }
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const request = new Request(url, {
      method: req.method,
      headers,
      body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
    });

    const response = await fetchHandler(request);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    const body = Buffer.from(await response.arrayBuffer());
    res.end(body);
  };
}

async function listen(server: Server): Promise<{ port: number; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve OAuth relay test server port");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export async function startOAuthRelayTestServers(): Promise<OAuthRelayTestServers> {
  const webuiDir = mkdtempSync(join(tmpdir(), "kata-oauth-e2e-webui-"));
  writeFileSync(join(webuiDir, "login.html"), "<!doctype html><html><body>login</body></html>");
  writeFileSync(join(webuiDir, "index.html"), "<!doctype html><html><body>app</body></html>");

  const flowStore = new OAuthFlowStore();
  const exchangeCalls: Array<Record<string, unknown>> = [];
  let storedToken: string | undefined;

  const handler = createWebuiHandler({
    webuiDir,
    secret: "test-secret",
    password: "test-password",
    wsProtocol: "ws",
    wsPort: 9100,
    getHealthCheck: () => ({ status: "ok" }),
    logger: noopLogger,
  });

  handler.setOAuthCallbackDeps({
    flowStore,
    credManager: {
      exchangeAndStore: async (
        _source: LoadedSource,
        _provider: string,
        params: {
          code: string;
          codeVerifier: string;
          tokenEndpoint: string;
          clientId: string;
          clientSecret?: string;
          redirectUri: string;
          resource?: string;
        },
      ) => {
        exchangeCalls.push({ ...params });
        const result = await exchangeMcpOAuth(params);
        if (result.success && result.accessToken) {
          storedToken = result.accessToken;
        }
        return { success: result.success, error: result.error, email: result.email };
      },
    },
    sessionManager: { completeAuthRequest: async () => {} },
    pushSourcesChanged: () => {},
  });

  const webuiServer = createServer(nodeRequestListener(handler.fetch));
  const webui = await listen(webuiServer);
  const webuiBaseUrl = `http://127.0.0.1:${webui.port}`;
  const returnTo = `${webuiBaseUrl}/api/oauth/callback`;

  const relayServer = createServer(
    nodeRequestListener(async (req) => {
      const requestUrl = new URL(req.url);
      if (req.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      try {
        return handleOAuthRelayCallback(requestUrl, {
          allowedReturnOrigins: [webuiBaseUrl],
          allowLocalhostReturns: true,
        });
      } catch (error) {
        return oauthRelayErrorResponse(error);
      }
    }),
  );
  const relay = await listen(relayServer);
  const relayBaseUrl = `http://127.0.0.1:${relay.port}`;

  return {
    relayBaseUrl,
    webuiBaseUrl,
    returnTo,
    setFlow: (state, flow) => {
      flowStore.store({
        flowId: flow.flowId ?? "flow-e2e",
        state,
        codeVerifier: flow.codeVerifier ?? "",
        redirectUri: flow.redirectUri ?? "https://agents.kata.sh/auth/callback",
        source: (flow.source ?? { config: { slug: "fixture" } }) as LoadedSource,
        clientId: flow.clientId ?? "client",
        clientSecret: flow.clientSecret,
        tokenEndpoint: flow.tokenEndpoint ?? "",
        provider: (flow.provider ?? "mcp") as PendingOAuthFlow["provider"],
        resource: flow.resource,
        ownerClientId: flow.ownerClientId ?? "owner",
        workspaceId: flow.workspaceId ?? "workspace-1",
        sourceSlug: flow.sourceSlug ?? "fixture",
        createdAt: flow.createdAt ?? Date.now(),
        expiresAt: flow.expiresAt ?? Date.now() + 60_000,
        sessionId: flow.sessionId,
        authRequestId: flow.authRequestId,
      });
    },
    getExchangeCalls: () => [...exchangeCalls],
    getStoredAccessToken: () => storedToken,
    close: async () => {
      handler.dispose();
      flowStore.dispose();
      storedToken = undefined;
      await Promise.all([relay.close(), webui.close()]);
    },
  };
}
