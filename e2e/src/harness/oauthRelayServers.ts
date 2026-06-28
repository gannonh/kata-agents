import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  handleOAuthRelayCallback,
  oauthRelayErrorResponse,
} from "../../../packages/shared/src/auth/oauth-relay-handler.ts";

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

type OAuthFlow = Record<string, unknown>;

export interface OAuthRelayTestServers {
  relayBaseUrl: string;
  webuiBaseUrl: string;
  returnTo: string;
  setFlow: (state: string, flow: OAuthFlow) => void;
  getExchangeCalls: () => Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

async function nodeRequestListener(
  fetchHandler: (req: Request) => Promise<Response>,
): Promise<(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void> {
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

function callbackHtml(title: string, body: string): Response {
  return new Response(`<!doctype html><html><body><h1>${title}</h1><p>${body}</p></body></html>`, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function startOAuthRelayTestServers(): Promise<OAuthRelayTestServers> {
  const webuiDir = mkdtempSync(join(tmpdir(), "kata-oauth-e2e-webui-"));
  writeFileSync(join(webuiDir, "login.html"), "<!doctype html><html><body>login</body></html>");
  writeFileSync(join(webuiDir, "index.html"), "<!doctype html><html><body>app</body></html>");

  const flows = new Map<string, OAuthFlow>();
  const exchangeCalls: Array<Record<string, unknown>> = [];

  const webuiServer = createServer(
    await nodeRequestListener(async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/api/oauth/callback" || req.method !== "GET") {
        return new Response("Not Found", { status: 404 });
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");

      if (error) {
        if (state && flows.has(state)) flows.delete(state);
        const errorMsg = errorDescription || error;
        noopLogger.warn(`OAuth callback error: ${errorMsg}`);
        return callbackHtml("Authorization Failed", errorMsg);
      }

      if (!code || !state) {
        return callbackHtml("Authorization Failed", "Missing code or state parameter");
      }

      const flow = flows.get(state);
      if (!flow) {
        return callbackHtml("Authorization Failed", "Unknown or expired OAuth flow");
      }

      exchangeCalls.push({
        code,
        codeVerifier: flow.codeVerifier,
        tokenEndpoint: flow.tokenEndpoint,
        clientId: flow.clientId,
        clientSecret: flow.clientSecret,
        redirectUri: flow.redirectUri,
        resource: flow.resource,
      });
      flows.delete(state);
      return callbackHtml("Authorization Successful", "Authorization successful");
    }),
  );
  const webui = await listen(webuiServer);
  const webuiBaseUrl = `http://127.0.0.1:${webui.port}`;
  const returnTo = `${webuiBaseUrl}/api/oauth/callback`;

  const relayServer = createServer(
    await nodeRequestListener(async (req) => {
      const requestUrl = new URL(req.url);
      if (req.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      try {
        return handleOAuthRelayCallback(requestUrl, {
          allowedReturnOrigins: [webuiBaseUrl],
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
      flows.set(state, flow);
    },
    getExchangeCalls: () => [...exchangeCalls],
    close: async () => {
      await Promise.all([relay.close(), webui.close()]);
    },
  };
}
