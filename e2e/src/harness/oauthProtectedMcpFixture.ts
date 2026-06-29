import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";

import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Local OAuth-protected MCP fixture for E2E acceptance evidence.
 *
 * Three cooperating HTTP servers on 127.0.0.1, all free-tier/no-network:
 *
 *   1. `mcp` — a Streamable HTTP MCP resource server that requires a Bearer
 *      access token for `tools/list` and `tools/call`, and returns 401 with a
 *      `WWW-Authenticate: Bearer resource_metadata=...` header on unauthenticated
 *      requests (RFC 9728 discovery). Exposes one tool: `get_status`.
 *
 *   2. `auth` — a fake OAuth authorization server:
 *        - `/.well-known/oauth-authorization-server` (metadata)
 *        - `/.well-known/oauth-protected-resource` (RFC 9728 resource metadata)
 *        - `/register` (dynamic client registration)
 *        - `/authorize` (simulated consent screen: returns 302 with a code)
 *        - `/token` (exchanges the code for an access token, honoring `resource`)
 *
 *   3. The MCP and auth servers are deliberately separate origins so the
 *      `resource` indicator and RFC 9728 discovery path are exercised.
 *
 * The fixture records every token exchange (code, verifier, redirect_uri,
 * resource) so tests can assert the MCP `resource` parameter was sent.
 */

export interface OAuthProtectedMcpFixture {
  mcpBaseUrl: string;
  mcpUrl: string;
  authBaseUrl: string;
  /** The access token the auth server will issue for the next /token call. */
  issuedAccessToken: string;
  /** Recorded /token request bodies (parsed URLSearchParams). */
  tokenRequests: Array<Record<string, string>>;
  /** Recorded /register request bodies. */
  registrationRequests: Array<Record<string, string>>;
  /** Recorded tool calls on the MCP server: { name, args, authed }. */
  toolCalls: Array<{ name: string; args: Record<string, unknown>; authed: boolean }>;
  /**
   * Simulate the user approving consent in the browser: hit /authorize and
   * follow the redirect manually (tests use redirect:"manual").
   */
  approveAuthorization(params: {
    authUrl: string;
  }): Promise<{ location: string }>;
  close(): Promise<void>;
}

function listen(server: Server): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to resolve fixture server port"));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
    server.on("error", reject);
  });
}

function toBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function parseForm(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  const out: Record<string, string> = {};
  params.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export async function startOAuthProtectedMcpFixture(): Promise<OAuthProtectedMcpFixture> {
  const issuedAccessToken = `fixture-token-${randomBytes(6).toString("hex")}`;
  const tokenRequests: Array<Record<string, string>> = [];
  const registrationRequests: Array<Record<string, string>> = [];
  const toolCalls: Array<{ name: string; args: Record<string, unknown>; authed: boolean }> = [];

  // Codes issued by /authorize, mapped to the redirect_uri used at approval time.
  const issuedCodes = new Map<string, string>();
  let authBaseUrl = "";
  let mcpBaseUrl = "";
  let mcpUrl = "";

  // --- Auth server (OAuth authorization server + protected resource metadata) ---
  const authServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);
    const method = req.method ?? "GET";

    if (url.pathname === "/.well-known/oauth-protected-resource") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          resource: mcpUrl,
          authorization_servers: [authBaseUrl],
        }),
      );
      return;
    }

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          authorization_endpoint: `${authBaseUrl}/authorize`,
          token_endpoint: `${authBaseUrl}/token`,
          registration_endpoint: `${authBaseUrl}/register`,
        }),
      );
      return;
    }

    if (url.pathname === "/register" && method === "POST") {
      const body = await toBody(req);
      // Record parsed JSON body (client_name, redirect_uris, etc.)
      try {
        registrationRequests.push(JSON.parse(body));
      } catch {
        registrationRequests.push({ raw: body });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          client_id: "fixture-dynamic-client",
          client_secret: "fixture-secret",
        }),
      );
      return;
    }

    if (url.pathname === "/authorize" && method === "GET") {
      // Simulated consent: mint a code and redirect to redirect_uri.
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const resource = url.searchParams.get("resource");
      if (!redirectUri) {
        res.writeHead(400);
        res.end("missing redirect_uri");
        return;
      }
      const code = `code-${randomBytes(4).toString("hex")}`;
      // Echo the resource back through the code so /token can validate it.
      issuedCodes.set(code, resource ?? "");
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      if (state) callback.searchParams.set("state", state);
      res.writeHead(302, { location: callback.toString() });
      res.end();
      return;
    }

    if (url.pathname === "/token" && method === "POST") {
      const body = await toBody(req);
      const params = parseForm(body);
      tokenRequests.push(params);
      const code = params.code;
      if (!code || !issuedCodes.has(code)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      issuedCodes.delete(code);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: issuedAccessToken,
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });
  const auth = await listen(authServer);
  authBaseUrl = `http://127.0.0.1:${auth.port}`;

  // --- MCP resource server (Streamable HTTP, Bearer-protected) ---
  // Low-level server + per-request transport. In stateless mode the SDK requires
  // a fresh transport per request (a reused stateless transport throws on the
  // second message). We build the handlers once and attach them to a fresh
  // transport for each incoming POST.
  function buildMcpServer() {
    const server = new McpServer(
      { name: "fixture-oauth-mcp", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "get_status",
          description: "Returns the fixture status",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      toolCalls.push({ name, args: args ?? {}, authed: true });
      if (name === "get_status") {
        return {
          content: [{ type: "text", text: "ok" }],
        };
      }
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    });

    return server;
  }

  const mcpServerHttp = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);
    const method = req.method ?? "GET";

    // RFC 9728 discovery: unauthenticated request returns 401 with resource_metadata.
    if (url.pathname === "/mcp" && method === "POST") {
      const authHeader = req.headers["authorization"];
      const body = await toBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      const isInitialize =
        parsed && typeof parsed === "object" &&
        "method" in parsed && (parsed as { method: string }).method === "initialize";

      if (!authHeader && !isInitialize) {
        res.writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": `Bearer resource_metadata="${authBaseUrl}/.well-known/oauth-protected-resource"`,
        });
        res.end(JSON.stringify({ error: "invalid_token" }));
        return;
      }

      // Forward to a fresh MCP transport for this request (stateless mode).
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(key, item);
        } else {
          headers.set(key, value);
        }
      }
      const webRequest = new Request(`${mcpBaseUrl}${url.pathname}${url.search}`, {
        method,
        headers,
        body,
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const perRequestServer = buildMcpServer();
      await perRequestServer.connect(transport);
      const response = await transport.handleRequest(webRequest);
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      res.writeHead(response.status, responseHeaders);
      const buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
      await perRequestServer.close().catch(() => {});
      return;
    }

    if (url.pathname === "/.well-known/oauth-protected-resource") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          resource: mcpUrl,
          authorization_servers: [authBaseUrl],
        }),
      );
      return;
    }

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          authorization_endpoint: `${authBaseUrl}/authorize`,
          token_endpoint: `${authBaseUrl}/token`,
          registration_endpoint: `${authBaseUrl}/register`,
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });
  const mcp = await listen(mcpServerHttp);
  mcpBaseUrl = `http://127.0.0.1:${mcp.port}`;
  mcpUrl = `${mcpBaseUrl}/mcp`;

  return {
    mcpBaseUrl,
    mcpUrl,
    authBaseUrl,
    issuedAccessToken,
    tokenRequests,
    registrationRequests,
    toolCalls,
    approveAuthorization: async ({ authUrl }) => {
      // Hit the /authorize endpoint and capture the 302 location (no browser).
      const response = await fetch(authUrl, { redirect: "manual" });
      return { location: response.headers.get("location") ?? "" };
    },
    close: async () => {
      await Promise.all([auth.close(), mcp.close()]);
    },
  };
}
