import { createServer, type Server } from 'http';
import { URL } from 'url';
import { randomBytes } from 'crypto';
import { openUrl } from '../utils/open-url.ts';
import { generateCallbackPage } from './callback-page.ts';
import { type OAuthSessionContext, buildOAuthDeeplinkUrl } from './types.ts';
import { discoverOAuthMetadata } from './oauth-discovery.ts';
import { exchangeMcpOAuth, prepareMcpOAuth } from './mcp-oauth.ts';

export type { OAuthMetadata } from './oauth-discovery.ts';

export interface OAuthConfig {
  mcpUrl: string; // Full MCP URL including path (e.g., https://mcp.craft.do/my/mcp)
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType: string;
}

export interface OAuthCallbacks {
  onStatus: (message: string) => void;
  onError: (error: string) => void;
}

// Port range for OAuth callback server - tries ports sequentially until one is available
const CALLBACK_PORT_START = 8914;
const CALLBACK_PORT_END = 8924;
const CALLBACK_PATH = '/oauth/callback';

function generateState(): string {
  return randomBytes(16).toString('hex');
}

export class CraftOAuth {
  private config: OAuthConfig;
  private server: Server | null = null;
  private callbacks: OAuthCallbacks;
  private sessionContext?: OAuthSessionContext;

  constructor(config: OAuthConfig, callbacks: OAuthCallbacks, sessionContext?: OAuthSessionContext) {
    this.config = config;
    this.callbacks = callbacks;
    this.sessionContext = sessionContext;
  }

  private async getServerMetadata() {
    const metadata = await discoverOAuthMetadata(
      this.config.mcpUrl,
      (msg) => this.callbacks.onStatus(msg),
    );

    if (!metadata) {
      throw new Error(`No OAuth metadata found for ${this.config.mcpUrl}`);
    }

    return metadata;
  }

  async refreshAccessToken(
    refreshToken: string,
    clientId: string,
  ): Promise<OAuthTokens> {
    const metadata = await this.getServerMetadata();

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    });

    const response = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error('Failed to refresh token');
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
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      tokenType: data.token_type || 'Bearer',
    };
  }

  async checkAuthRequired(): Promise<boolean> {
    this.callbacks.onStatus('Checking if authentication is required...');

    try {
      const metadata = await discoverOAuthMetadata(
        this.config.mcpUrl,
        (msg) => this.callbacks.onStatus(msg),
      );

      if (metadata) {
        this.callbacks.onStatus('OAuth required - server has OAuth metadata');
        return true;
      }

      this.callbacks.onStatus('No OAuth metadata found - server may be public');
      return false;
    } catch {
      this.callbacks.onStatus('Could not reach OAuth metadata - assuming public');
      return false;
    }
  }

  async authenticate(): Promise<{ tokens: OAuthTokens; clientId: string }> {
    this.callbacks.onStatus('Fetching OAuth server configuration...');

    const state = generateState();

    this.callbacks.onStatus('Starting callback server...');
    let port: number;
    let codePromise: Promise<string>;
    try {
      const server = await this.startCallbackServer(state);
      port = server.port;
      codePromise = server.codePromise;
      this.callbacks.onStatus(`Callback server listening on port ${port}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.callbacks.onStatus(`Failed to start callback server: ${msg}`);
      throw error;
    }

    let prepared;
    try {
      this.callbacks.onStatus('Preparing OAuth flow...');
      prepared = await prepareMcpOAuth(this.config.mcpUrl, {
        callbackPort: port,
        state,
        onStatus: (msg) => this.callbacks.onStatus(msg),
      });
      this.callbacks.onStatus(`Using client ID: ${prepared.clientId}`);
    } catch (error) {
      this.stopServer();
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.callbacks.onStatus(`Failed to prepare OAuth flow: ${msg}`);
      throw error;
    }

    this.callbacks.onStatus('Opening browser for authorization...');
    await openUrl(prepared.authUrl);

    this.callbacks.onStatus('Waiting for you to authorize in browser...');
    const authCode = await codePromise;
    this.callbacks.onStatus('Authorization code received!');

    this.callbacks.onStatus('Exchanging authorization code for tokens...');
    const exchangeResult = await exchangeMcpOAuth({
      code: authCode,
      codeVerifier: prepared.codeVerifier,
      tokenEndpoint: prepared.tokenEndpoint,
      clientId: prepared.clientId,
      clientSecret: prepared.clientSecret,
      redirectUri: prepared.redirectUri,
      resource: prepared.resource,
    });

    if (!exchangeResult.success || !exchangeResult.accessToken) {
      throw new Error(exchangeResult.error ?? 'Failed to exchange code for tokens');
    }

    this.callbacks.onStatus('Tokens received successfully!');

    return {
      tokens: {
        accessToken: exchangeResult.accessToken,
        refreshToken: exchangeResult.refreshToken,
        expiresAt: exchangeResult.expiresAt,
        tokenType: 'Bearer',
      },
      clientId: prepared.clientId,
    };
  }

  private async startCallbackServer(
    expectedState: string,
  ): Promise<{ port: number; codePromise: Promise<string> }> {
    let resolveCode: (code: string) => void;
    let rejectCode: (error: Error) => void;
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    const timeout = setTimeout(() => {
      this.stopServer();
      rejectCode(new Error('OAuth timeout - no callback received'));
    }, 300000);

    for (let port = CALLBACK_PORT_START; port <= CALLBACK_PORT_END; port++) {
      const candidate = createServer((req, res) => {
        const url = new URL(req.url || '/', `http://localhost:${port}`);

        if (url.pathname === CALLBACK_PATH) {
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(generateCallbackPage({
              title: 'Authorization Failed',
              isSuccess: false,
              errorDetail: error,
            }));
            clearTimeout(timeout);
            this.stopServer();
            rejectCode(new Error(`OAuth error: ${error}`));
            return;
          }

          if (state !== expectedState) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(generateCallbackPage({
              title: 'Security Error',
              isSuccess: false,
              errorDetail: 'State mismatch - possible CSRF attack.',
            }));
            clearTimeout(timeout);
            this.stopServer();
            rejectCode(new Error('OAuth state mismatch'));
            return;
          }

          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(generateCallbackPage({
              title: 'Authorization Failed',
              isSuccess: false,
              errorDetail: 'No authorization code received.',
            }));
            clearTimeout(timeout);
            this.stopServer();
            rejectCode(new Error('No authorization code'));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(generateCallbackPage({
            title: 'Authorization Successful',
            isSuccess: true,
            deeplinkUrl: buildOAuthDeeplinkUrl(this.sessionContext),
          }));

          clearTimeout(timeout);
          this.stopServer();
          resolveCode(code);
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      try {
        await new Promise<void>((resolve, reject) => {
          candidate.once('error', reject);
          candidate.listen(port, 'localhost', () => {
            candidate.removeListener('error', reject);
            resolve();
          });
        });

        this.server = candidate;
        this.server.on('error', (err) => {
          clearTimeout(timeout);
          rejectCode(new Error(`Callback server error: ${err.message}`));
        });
        return { port, codePromise };
      } catch (err: unknown) {
        candidate.close();
        const isAddressInUse =
          err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
        if (!isAddressInUse) {
          clearTimeout(timeout);
          throw err instanceof Error ? err : new Error(String(err));
        }
      }
    }

    clearTimeout(timeout);
    throw new Error(
      `All OAuth callback ports (${CALLBACK_PORT_START}-${CALLBACK_PORT_END}) are in use. Please restart the application.`,
    );
  }

  private stopServer(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  cancel(): void {
    this.stopServer();
  }
}

// Re-export discovery from the canonical module for backward compatibility.
export { discoverOAuthMetadata } from './oauth-discovery.ts';
export {
  prepareMcpOAuth,
  exchangeMcpOAuth,
  getMcpBaseUrl,
  canonicalizeMcpOAuthResource,
} from './mcp-oauth.ts';
