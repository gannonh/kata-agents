import { describe, it, expect, afterEach } from 'bun:test';
import { getFeatureFlagEnv, isDevRuntime, isDeveloperFeedbackEnabled, isEmbeddedServerEnabled } from '../feature-flags.ts';

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  KATA_DEBUG: process.env.KATA_DEBUG,
  KATA_FEATURE_DEVELOPER_FEEDBACK: process.env.KATA_FEATURE_DEVELOPER_FEEDBACK,
  KATA_FEATURE_EMBEDDED_SERVER: process.env.KATA_FEATURE_EMBEDDED_SERVER,
};

afterEach(() => {
  if (ORIGINAL_ENV.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV;

  if (ORIGINAL_ENV.KATA_DEBUG === undefined) delete process.env.KATA_DEBUG;
  else process.env.KATA_DEBUG = ORIGINAL_ENV.KATA_DEBUG;

  if (ORIGINAL_ENV.KATA_FEATURE_DEVELOPER_FEEDBACK === undefined) delete process.env.KATA_FEATURE_DEVELOPER_FEEDBACK;
  else process.env.KATA_FEATURE_DEVELOPER_FEEDBACK = ORIGINAL_ENV.KATA_FEATURE_DEVELOPER_FEEDBACK;

  if (ORIGINAL_ENV.KATA_FEATURE_EMBEDDED_SERVER === undefined) delete process.env.KATA_FEATURE_EMBEDDED_SERVER;
  else process.env.KATA_FEATURE_EMBEDDED_SERVER = ORIGINAL_ENV.KATA_FEATURE_EMBEDDED_SERVER;

  delete globalThis.__KATA_FEATURE_FLAGS__;
});

describe('feature-flags runtime helpers', () => {
  it('isDevRuntime returns true for explicit dev NODE_ENV', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.KATA_DEBUG;

    expect(isDevRuntime()).toBe(true);
  });

  it('isDevRuntime returns true for KATA_DEBUG override', () => {
    process.env.NODE_ENV = 'production';
    process.env.KATA_DEBUG = '1';

    expect(isDevRuntime()).toBe(true);
  });

  it('isDeveloperFeedbackEnabled honors explicit override false', () => {
    process.env.NODE_ENV = 'development';
    process.env.KATA_FEATURE_DEVELOPER_FEEDBACK = '0';

    expect(isDeveloperFeedbackEnabled()).toBe(false);
  });

  it('isDeveloperFeedbackEnabled honors explicit override true', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.KATA_DEBUG;
    process.env.KATA_FEATURE_DEVELOPER_FEEDBACK = '1';

    expect(isDeveloperFeedbackEnabled()).toBe(true);
  });

  it('isDeveloperFeedbackEnabled falls back to dev runtime when no override', () => {
    process.env.NODE_ENV = 'production';
    process.env.KATA_DEBUG = '1';
    delete process.env.KATA_FEATURE_DEVELOPER_FEEDBACK;

    expect(isDeveloperFeedbackEnabled()).toBe(true);
  });

  it('isEmbeddedServerEnabled defaults to false when no override is set', () => {
    delete process.env.KATA_FEATURE_EMBEDDED_SERVER;

    expect(isEmbeddedServerEnabled()).toBe(false);
  });

  it('isEmbeddedServerEnabled honors explicit override true', () => {
    process.env.KATA_FEATURE_EMBEDDED_SERVER = '1';

    expect(isEmbeddedServerEnabled()).toBe(true);
  });

  it('isEmbeddedServerEnabled honors explicit override false', () => {
    process.env.KATA_FEATURE_EMBEDDED_SERVER = '0';

    expect(isEmbeddedServerEnabled()).toBe(false);
  });

  it('getFeatureFlagEnv reads injected globals when process.env has no value', () => {
    delete process.env.KATA_FEATURE_EMBEDDED_SERVER;
    globalThis.__KATA_FEATURE_FLAGS__ = {
      KATA_FEATURE_EMBEDDED_SERVER: '1',
    };

    expect(getFeatureFlagEnv('KATA_FEATURE_EMBEDDED_SERVER')).toBe('1');
    expect(isEmbeddedServerEnabled()).toBe(true);
  });

  it('process.env takes precedence over injected globals', () => {
    process.env.KATA_FEATURE_EMBEDDED_SERVER = '0';
    globalThis.__KATA_FEATURE_FLAGS__ = {
      KATA_FEATURE_EMBEDDED_SERVER: '1',
    };

    expect(getFeatureFlagEnv('KATA_FEATURE_EMBEDDED_SERVER')).toBe('0');
    expect(isEmbeddedServerEnabled()).toBe(false);
  });
});
