import { describe, expect, it } from 'bun:test';

import {
  encodeOAuthRelayState,
} from '../oauth-relay.ts';
import {
  OAuthRelayError,
  buildOAuthRelayRedirectUrl,
  handleOAuthRelayCallback,
  parseAllowedReturnOrigins,
  validateOAuthRelayReturnTarget,
} from '../oauth-relay-handler.ts';

const ALLOWED_ORIGINS = ['https://agents.kata.sh'];

function relayState(returnTo: string, innerState = 'inner-state-123'): string {
  return encodeOAuthRelayState(returnTo, innerState);
}

describe('parseAllowedReturnOrigins', () => {
  it('parses comma-separated exact origins', () => {
    expect(parseAllowedReturnOrigins('https://agents.kata.sh, https://staging.example.com'))
      .toEqual(['https://agents.kata.sh', 'https://staging.example.com']);
  });

  it('returns an empty list for missing config', () => {
    expect(parseAllowedReturnOrigins(undefined)).toEqual([]);
  });
});

describe('validateOAuthRelayReturnTarget', () => {
  it('accepts hosted HTTPS return targets on the allowlist', () => {
    expect(() => validateOAuthRelayReturnTarget(
      'https://agents.kata.sh/api/oauth/callback',
      ALLOWED_ORIGINS,
    )).not.toThrow();
  });

  it('accepts localhost development callbacks', () => {
    expect(() => validateOAuthRelayReturnTarget(
      'http://localhost:3100/api/oauth/callback',
      ALLOWED_ORIGINS,
    )).not.toThrow();
    expect(() => validateOAuthRelayReturnTarget(
      'http://127.0.0.1:3100/api/oauth/callback',
      ALLOWED_ORIGINS,
    )).not.toThrow();
  });

  it('rejects unapproved HTTPS hosts', () => {
    expect(() => validateOAuthRelayReturnTarget(
      'https://evil.example/api/oauth/callback',
      ALLOWED_ORIGINS,
    )).toThrow('Return target origin is not allowed');
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => validateOAuthRelayReturnTarget(
      'javascript:alert(1)',
      ALLOWED_ORIGINS,
    )).toThrow('Return target must use http or https');
  });

  it('rejects URLs with credentials in the authority', () => {
    expect(() => validateOAuthRelayReturnTarget(
      'https://user:pass@agents.kata.sh/api/oauth/callback',
      ALLOWED_ORIGINS,
    )).toThrow('Return target must not include credentials');
  });

  it('rejects localhost URLs without the expected callback path', () => {
    expect(() => validateOAuthRelayReturnTarget(
      'http://localhost:3100/oauth/callback',
      ALLOWED_ORIGINS,
    )).toThrow('Return target must use /api/oauth/callback');
  });

  it('rejects malformed URLs', () => {
    expect(() => validateOAuthRelayReturnTarget(
      'not-a-url',
      ALLOWED_ORIGINS,
    )).toThrow('Invalid return target URL');
  });
});

describe('buildOAuthRelayRedirectUrl', () => {
  it('forwards provider success parameters with the inner state', () => {
    const params = new URLSearchParams('code=auth-code-123&state=ca1.outer');
    const location = buildOAuthRelayRedirectUrl(
      'https://agents.kata.sh/api/oauth/callback',
      'inner-state-123',
      params,
    );

    const url = new URL(location);
    expect(url.origin).toBe('https://agents.kata.sh');
    expect(url.pathname).toBe('/api/oauth/callback');
    expect(url.searchParams.get('code')).toBe('auth-code-123');
    expect(url.searchParams.get('state')).toBe('inner-state-123');
  });

  it('forwards provider error parameters with the inner state', () => {
    const params = new URLSearchParams('error=access_denied&error_description=User%20denied&state=ca1.outer');
    const location = buildOAuthRelayRedirectUrl(
      'https://agents.kata.sh/api/oauth/callback',
      'inner-state-456',
      params,
    );

    const url = new URL(location);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('error_description')).toBe('User denied');
    expect(url.searchParams.get('state')).toBe('inner-state-456');
  });
});

describe('handleOAuthRelayCallback', () => {
  it('redirects valid relay callbacks to the encoded return target', () => {
    const requestUrl = new URL(
      `https://agents.kata.sh/auth/callback?code=auth-code-123&state=${encodeURIComponent(relayState('https://agents.kata.sh/api/oauth/callback'))}`,
    );

    const response = handleOAuthRelayCallback(requestUrl, {
      allowedReturnOrigins: ALLOWED_ORIGINS,
    });

    expect(response.status).toBe(302);
    const location = response.headers.get('Location');
    expect(location).toBeTruthy();

    const redirectUrl = new URL(location!);
    expect(redirectUrl.toString()).toBe(
      'https://agents.kata.sh/api/oauth/callback?code=auth-code-123&state=inner-state-123',
    );
  });

  it('returns a controlled error for missing state', () => {
    const requestUrl = new URL('https://agents.kata.sh/auth/callback?code=auth-code-123');

    expect(() => handleOAuthRelayCallback(requestUrl, {
      allowedReturnOrigins: ALLOWED_ORIGINS,
    })).toThrow(OAuthRelayError);
  });

  it('returns a controlled error for malformed relay state', () => {
    const requestUrl = new URL('https://agents.kata.sh/auth/callback?code=auth-code-123&state=ca1.not-valid');

    expect(() => handleOAuthRelayCallback(requestUrl, {
      allowedReturnOrigins: ALLOWED_ORIGINS,
    })).toThrow('Invalid OAuth relay state');
  });

  it('rejects unsafe return targets encoded in relay state', () => {
    const requestUrl = new URL(
      `https://agents.kata.sh/auth/callback?code=auth-code-123&state=${encodeURIComponent(relayState('https://evil.example/api/oauth/callback'))}`,
    );

    expect(() => handleOAuthRelayCallback(requestUrl, {
      allowedReturnOrigins: ALLOWED_ORIGINS,
    })).toThrow('Return target origin is not allowed');
  });
});
