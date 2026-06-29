import { createHash, randomBytes } from 'crypto';

import type { OAuthExchangeParams, OAuthExchangeResult, PreparedOAuthFlow } from './oauth-flow-types.ts';
import { discoverOAuthMetadata } from './oauth-discovery.ts';
import { generatePKCE } from './pkce.ts';

const CALLBACK_PATH = '/oauth/callback';
const CLIENT_NAME = 'Claude Code (Kata Agent)';

function generateMcpOAuthState(): string {
  return randomBytes(16).toString('hex');
}

class McpClientRegistrationError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'McpClientRegistrationError';
    this.status = status;
  }
}

function shouldFallbackToDefaultMcpClient(error: unknown): boolean {
  return error instanceof McpClientRegistrationError && (error.status === 401 || error.status === 403);
}

async function registerMcpOAuthClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ client_id: string; client_secret?: string }> {
  let response: Response;
  try {
    response = await fetch(registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new McpClientRegistrationError(`Failed to register OAuth client: ${message}`);
  }

  if (!response.ok) {
    const error = await response.text();
    throw new McpClientRegistrationError(`Failed to register OAuth client: ${error}`, response.status);
  }

  return response.json() as Promise<{ client_id: string; client_secret?: string }>;
}

async function exchangeMcpCodeForTokens(
  tokenEndpoint: string,
  code: string,
  codeVerifier: string,
  clientId: string,
  redirectUri: string,
  resource?: string,
): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType: string;
}> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  if (resource) {
    params.set('resource', resource);
  }

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to exchange code for tokens: ${error}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  const expiresIn = data.expires_in ?? 3600;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
    tokenType: data.token_type || 'Bearer',
  };
}

export interface PrepareMcpOAuthOptions {
  callbackPort?: number;
  callbackUrl?: string;
  /** Pre-generated CSRF state (must match the callback server when using Electron). */
  state?: string;
  /** Pre-generated PKCE verifier (paired with state when using Electron). */
  codeVerifier?: string;
  onStatus?: (message: string) => void;
}

/**
 * Prepare an MCP OAuth flow without starting a callback server or opening a browser.
 */
export async function prepareMcpOAuth(
  mcpUrl: string,
  options: PrepareMcpOAuthOptions,
): Promise<PreparedOAuthFlow> {
  if (!options.callbackUrl && options.callbackPort === undefined) {
    throw new Error('Either callbackUrl or callbackPort is required for MCP OAuth');
  }

  const metadata = await discoverOAuthMetadata(mcpUrl, options.onStatus);
  if (!metadata) {
    throw new Error(`No OAuth metadata found for ${mcpUrl}`);
  }

  const resource = canonicalizeMcpOAuthResource(mcpUrl);
  const pkce = options.codeVerifier
    ? {
        codeVerifier: options.codeVerifier,
        codeChallenge: createHash('sha256').update(options.codeVerifier).digest('base64url'),
      }
    : generatePKCE();

  const state = options.state ?? generateMcpOAuthState();
  const redirectUri = options.callbackUrl
    ?? `http://localhost:${options.callbackPort}${CALLBACK_PATH}`;

  let clientId: string;
  let clientSecret: string | undefined;
  if (metadata.registration_endpoint) {
    try {
      const client = await registerMcpOAuthClient(metadata.registration_endpoint, redirectUri);
      clientId = client.client_id;
      clientSecret = client.client_secret;
    } catch (error) {
      if (!shouldFallbackToDefaultMcpClient(error)) {
        throw error;
      }
      clientId = 'kata-agent';
    }
  } else {
    clientId = 'kata-agent';
  }

  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', pkce.codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('resource', resource);

  return {
    authUrl: authUrl.toString(),
    state,
    codeVerifier: pkce.codeVerifier,
    tokenEndpoint: metadata.token_endpoint,
    clientId,
    clientSecret,
    redirectUri,
    provider: 'mcp',
    resource,
  };
}

export async function exchangeMcpOAuth(params: OAuthExchangeParams): Promise<OAuthExchangeResult> {
  try {
    const tokens = await exchangeMcpCodeForTokens(
      params.tokenEndpoint,
      params.code,
      params.codeVerifier,
      params.clientId,
      params.redirectUri,
      params.resource,
    );

    return {
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      oauthClientId: params.clientId,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'MCP OAuth exchange failed',
    };
  }
}

export function getMcpBaseUrl(mcpUrl: string): string {
  try {
    return new URL(mcpUrl).origin;
  } catch {
    return mcpUrl;
  }
}

export function canonicalizeMcpOAuthResource(mcpUrl: string): string {
  let url: URL;
  try {
    url = new URL(mcpUrl);
  } catch {
    throw new Error(`Invalid MCP URL: ${mcpUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`MCP URL must use http or https: ${mcpUrl}`);
  }

  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();

  if (url.protocol === 'http:' && url.port === '80') {
    url.port = '';
  }
  if (url.protocol === 'https:' && url.port === '443') {
    url.port = '';
  }

  const path = url.pathname || '/';
  return `${url.origin}${path}`;
}
