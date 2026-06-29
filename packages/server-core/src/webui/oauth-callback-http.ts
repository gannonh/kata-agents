import { generateCallbackPage } from '@kata-sh/shared/auth/callback-page';
import type { OAuthCompletionDeps } from '@kata-sh/shared/auth/oauth-completion-deps';
import { completeOAuthFlow } from '../handlers/rpc/oauth';

export interface OAuthCallbackLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

function oauthErrorPage(detail: string, status = 200): Response {
  return new Response(generateCallbackPage({
    title: 'Authorization Failed',
    isSuccess: false,
    errorDetail: detail,
  }), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * Handle GET /api/oauth/callback for WebUI-hosted OAuth completion.
 */
export async function handleWebuiOAuthCallback(
  url: URL,
  deps: OAuthCompletionDeps,
  logger: OAuthCallbackLogger,
  options: { clientId?: string; workspaceId?: string } = {},
): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const errorDescription = url.searchParams.get('error_description');

  if (error) {
    const flow = state ? deps.flowStore.getByState(state) : null;
    if (flow && state) deps.flowStore.remove(state);
    const errorMsg = errorDescription || error;
    logger.warn(`[webui] OAuth callback error: ${errorMsg}`);
    return oauthErrorPage(errorMsg);
  }

  if (!code || !state) {
    return oauthErrorPage('Missing code or state parameter', 400);
  }

  try {
    const result = await completeOAuthFlow({
      code,
      state,
      flowStore: deps.flowStore,
      credManager: deps.credManager,
      sessionManager: deps.sessionManager,
      pushSourcesChanged: deps.pushSourcesChanged,
      logger,
      clientId: options.clientId,
      workspaceId: options.workspaceId,
    });

    if (result.success) {
      return new Response(generateCallbackPage({ title: 'Authorization Successful', isSuccess: true }), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    return oauthErrorPage(result.error ?? 'Token exchange failed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Token exchange failed';
    logger.error(`[webui] OAuth callback failed: ${msg}`);
    return oauthErrorPage(msg);
  }
}
