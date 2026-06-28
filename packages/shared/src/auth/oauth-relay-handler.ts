import { decodeOAuthRelayState, isOAuthRelayState } from './oauth-relay.ts';

const LOCALHOST_CALLBACK_PATH = '/api/oauth/callback';

export interface OAuthRelayHandlerConfig {
  allowedReturnOrigins: string[];
}

export class OAuthRelayError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'OAuthRelayError';
    this.status = status;
  }
}

export function parseAllowedReturnOrigins(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }

  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function validateOAuthRelayReturnTarget(
  returnTo: string,
  allowedReturnOrigins: string[],
): void {
  let url: URL;
  try {
    url = new URL(returnTo);
  } catch {
    throw new OAuthRelayError('Invalid return target URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OAuthRelayError('Return target must use http or https');
  }

  if (url.username || url.password) {
    throw new OAuthRelayError('Return target must not include credentials');
  }

  if (url.pathname !== LOCALHOST_CALLBACK_PATH) {
    throw new OAuthRelayError('Return target must use /api/oauth/callback');
  }

  if (url.protocol === 'https:') {
    if (!allowedReturnOrigins.includes(url.origin)) {
      throw new OAuthRelayError('Return target origin is not allowed');
    }
    return;
  }

  const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (!isLocalhost) {
    throw new OAuthRelayError('Return target origin is not allowed');
  }
}

export function buildOAuthRelayRedirectUrl(
  returnTo: string,
  innerState: string,
  callbackParams: URLSearchParams,
): string {
  const redirectUrl = new URL(returnTo);
  redirectUrl.search = '';

  for (const [key, value] of callbackParams.entries()) {
    if (key === 'state') {
      continue;
    }
    redirectUrl.searchParams.set(key, value);
  }

  redirectUrl.searchParams.set('state', innerState);
  return redirectUrl.toString();
}

export function handleOAuthRelayCallback(
  requestUrl: URL,
  config: OAuthRelayHandlerConfig,
): Response {
  const state = requestUrl.searchParams.get('state');
  if (!state) {
    throw new OAuthRelayError('Missing OAuth state parameter');
  }

  if (!isOAuthRelayState(state)) {
    throw new OAuthRelayError('Invalid OAuth relay state');
  }

  let relayState;
  try {
    relayState = decodeOAuthRelayState(state);
  } catch {
    throw new OAuthRelayError('Invalid OAuth relay state');
  }

  validateOAuthRelayReturnTarget(relayState.returnTo, config.allowedReturnOrigins);

  const location = buildOAuthRelayRedirectUrl(
    relayState.returnTo,
    relayState.innerState,
    requestUrl.searchParams,
  );

  return Response.redirect(location, 302);
}

export function oauthRelayErrorResponse(error: unknown): Response {
  const message = error instanceof OAuthRelayError
    ? error.message
    : 'OAuth callback relay failed';
  const status = error instanceof OAuthRelayError ? error.status : 400;

  return new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
