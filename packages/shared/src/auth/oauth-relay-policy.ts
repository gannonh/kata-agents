/** Canonical WebUI OAuth callback path — must match relay return-target validation. */
export const WEBUI_OAUTH_CALLBACK_PATH = '/api/oauth/callback';

export function isWebUiOAuthCallbackUrl(callbackUrl: string | undefined): boolean {
  if (!callbackUrl) return false;
  try {
    return new URL(callbackUrl).pathname === WEBUI_OAUTH_CALLBACK_PATH;
  } catch {
    return false;
  }
}
