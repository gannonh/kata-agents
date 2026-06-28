import {
  handleOAuthRelayCallback,
  oauthRelayErrorResponse,
  parseAllowedReturnOrigins,
} from '../../../packages/shared/src/auth/oauth-relay-handler.ts';

export interface Env {
  KATA_OAUTH_RELAY_ALLOWED_RETURN_ORIGINS?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestUrl = new URL(request.url);

    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    try {
      return handleOAuthRelayCallback(requestUrl, {
        allowedReturnOrigins: parseAllowedReturnOrigins(
          env.KATA_OAUTH_RELAY_ALLOWED_RETURN_ORIGINS,
        ),
      });
    } catch (error) {
      return oauthRelayErrorResponse(error);
    }
  },
};
