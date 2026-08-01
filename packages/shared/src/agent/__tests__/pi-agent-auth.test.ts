import { describe, expect, it } from 'bun:test';
import { buildPiAuthCredential } from '../pi-agent.ts';

describe('Pi subprocess credential shaping', () => {
  const oauth = {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: 1234567890,
  };

  it('preserves native OAuth credentials for ChatGPT Codex', () => {
    expect(buildPiAuthCredential('openai-codex', oauth)).toEqual({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: 1234567890,
    });
  });

  it('keeps API-key credentials for the OpenAI API provider', () => {
    expect(buildPiAuthCredential('openai', oauth)).toEqual({
      type: 'api_key',
      key: 'access-token',
    });
  });

  it('does not downgrade Codex OAuth to an API key without a refresh token', () => {
    expect(buildPiAuthCredential('openai-codex', {
      accessToken: 'access-token',
    })).toBeNull();
  });
});
