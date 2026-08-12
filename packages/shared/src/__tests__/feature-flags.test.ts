import { describe, it, expect, afterEach } from 'bun:test';
import { FEATURE_FLAGS, getFeatureFlagEnv, isDevRuntime, isDeveloperFeedbackEnabled, isEmbeddedServerEnabled, isGitWorkspaceV1Enabled, isShareOnlineEnabled, isWorktreeV2Enabled } from '../feature-flags.ts';

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  KATA_DEBUG: process.env.KATA_DEBUG,
  KATA_FEATURE_FAST_MODE: process.env.KATA_FEATURE_FAST_MODE,
  KATA_FEATURE_DEVELOPER_FEEDBACK: process.env.KATA_FEATURE_DEVELOPER_FEEDBACK,
  KATA_FEATURE_EMBEDDED_SERVER: process.env.KATA_FEATURE_EMBEDDED_SERVER,
  KATA_FEATURE_GIT_WORKSPACE_V1: process.env.KATA_FEATURE_GIT_WORKSPACE_V1,
  KATA_FEATURE_WORKTREE_V2: process.env.KATA_FEATURE_WORKTREE_V2,
  KATA_FEATURE_SHARE_ONLINE: process.env.KATA_FEATURE_SHARE_ONLINE,
};

afterEach(() => {
  if (ORIGINAL_ENV.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV;

  if (ORIGINAL_ENV.KATA_DEBUG === undefined) delete process.env.KATA_DEBUG;
  else process.env.KATA_DEBUG = ORIGINAL_ENV.KATA_DEBUG;

  if (ORIGINAL_ENV.KATA_FEATURE_FAST_MODE === undefined) delete process.env.KATA_FEATURE_FAST_MODE;
  else process.env.KATA_FEATURE_FAST_MODE = ORIGINAL_ENV.KATA_FEATURE_FAST_MODE;

  if (ORIGINAL_ENV.KATA_FEATURE_DEVELOPER_FEEDBACK === undefined) delete process.env.KATA_FEATURE_DEVELOPER_FEEDBACK;
  else process.env.KATA_FEATURE_DEVELOPER_FEEDBACK = ORIGINAL_ENV.KATA_FEATURE_DEVELOPER_FEEDBACK;

  if (ORIGINAL_ENV.KATA_FEATURE_EMBEDDED_SERVER === undefined) delete process.env.KATA_FEATURE_EMBEDDED_SERVER;
  else process.env.KATA_FEATURE_EMBEDDED_SERVER = ORIGINAL_ENV.KATA_FEATURE_EMBEDDED_SERVER;

  if (ORIGINAL_ENV.KATA_FEATURE_GIT_WORKSPACE_V1 === undefined) delete process.env.KATA_FEATURE_GIT_WORKSPACE_V1;
  else process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = ORIGINAL_ENV.KATA_FEATURE_GIT_WORKSPACE_V1;

  if (ORIGINAL_ENV.KATA_FEATURE_WORKTREE_V2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2;
  else process.env.KATA_FEATURE_WORKTREE_V2 = ORIGINAL_ENV.KATA_FEATURE_WORKTREE_V2;

  if (ORIGINAL_ENV.KATA_FEATURE_SHARE_ONLINE === undefined) delete process.env.KATA_FEATURE_SHARE_ONLINE;
  else process.env.KATA_FEATURE_SHARE_ONLINE = ORIGINAL_ENV.KATA_FEATURE_SHARE_ONLINE;

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

  it('FEATURE_FLAGS.fastMode uses the central default and environment override', () => {
    delete process.env.KATA_FEATURE_FAST_MODE;
    expect(FEATURE_FLAGS.fastMode).toBe(false);

    process.env.KATA_FEATURE_FAST_MODE = '1';
    expect(FEATURE_FLAGS.fastMode).toBe(true);

    process.env.KATA_FEATURE_FAST_MODE = '0';
    expect(FEATURE_FLAGS.fastMode).toBe(false);
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

  it('isEmbeddedServerEnabled defaults to true when no override is set', () => {
    delete process.env.KATA_FEATURE_EMBEDDED_SERVER;

    expect(isEmbeddedServerEnabled()).toBe(true);
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

  it('isGitWorkspaceV1Enabled defaults to true when no override is set', () => {
    delete process.env.KATA_FEATURE_GIT_WORKSPACE_V1;

    expect(isGitWorkspaceV1Enabled()).toBe(true);
  });

  it('isGitWorkspaceV1Enabled honors explicit override true', () => {
    process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '1';

    expect(isGitWorkspaceV1Enabled()).toBe(true);
  });

  it('isGitWorkspaceV1Enabled honors explicit override false', () => {
    process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '0';

    expect(isGitWorkspaceV1Enabled()).toBe(false);
  });

  it('isGitWorkspaceV1Enabled reads injected globals in renderer context', () => {
    delete process.env.KATA_FEATURE_GIT_WORKSPACE_V1;
    globalThis.__KATA_FEATURE_FLAGS__ = {
      KATA_FEATURE_GIT_WORKSPACE_V1: '1',
    };

    expect(isGitWorkspaceV1Enabled()).toBe(true);
  });

  it('isWorktreeV2Enabled defaults to true when no override is set', () => {
    delete process.env.KATA_FEATURE_WORKTREE_V2;
    delete process.env.KATA_FEATURE_GIT_WORKSPACE_V1;

    expect(FEATURE_FLAGS.worktreeV2).toBe(true);
    expect(isWorktreeV2Enabled()).toBe(true);
  });

  it('isWorktreeV2Enabled defaults true while V1 is effective', () => {
    process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '1'
    delete process.env.KATA_FEATURE_WORKTREE_V2

    expect(isWorktreeV2Enabled()).toBe(true)
    expect(FEATURE_FLAGS.worktreeV2).toBe(true)
  })

  it('isWorktreeV2Enabled requires both V1 and V2 flags', () => {
    process.env.KATA_FEATURE_WORKTREE_V2 = '1';

    process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '1';
    expect(isWorktreeV2Enabled()).toBe(true);

    process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '0';
    expect(isWorktreeV2Enabled()).toBe(false);
  });

  it('isWorktreeV2Enabled honors an explicit V2 disable while V1 is enabled', () => {
    process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '1';
    process.env.KATA_FEATURE_WORKTREE_V2 = '0';

    expect(isWorktreeV2Enabled()).toBe(false);
  });

  it('isShareOnlineEnabled defaults to false when no override is set', () => {
    delete process.env.KATA_FEATURE_SHARE_ONLINE;

    expect(isShareOnlineEnabled()).toBe(false);
  });

  it('isShareOnlineEnabled honors an explicit override', () => {
    process.env.KATA_FEATURE_SHARE_ONLINE = '1';

    expect(isShareOnlineEnabled()).toBe(true);
  });
});
