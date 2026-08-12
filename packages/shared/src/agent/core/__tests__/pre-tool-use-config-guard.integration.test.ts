/**
 * Non-mocked integration tests for the pre-tool-use Bash config-write guard.
 *
 * Uses REAL config detectors, content validators, the real permission
 * pipeline, and the real immutable-default classifier. `KATA_CONFIG_DIR` is
 * pointed at a hermetic temp directory BEFORE any config path module loads
 * (dynamic imports), so app-level config detection and default permissions
 * are deterministic. The temp dir is seeded with the bundled
 * permissions/default.json so the immutable-default read-only classifier
 * behaves like production.
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';

// ── Hermetic config dir: MUST be set before config path modules load ────────
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..', '..');
const APP_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'kata-agents-guard-it-'));
process.env.KATA_CONFIG_DIR = APP_CONFIG_DIR;

// Seed app-level default permissions from the bundled file.
const permissionsDir = join(APP_CONFIG_DIR, 'permissions');
mkdirSync(permissionsDir, { recursive: true });
const bundledDefaultsPath = join(REPO_ROOT, 'apps', 'electron', 'resources', 'permissions', 'default.json');
writeFileSync(join(permissionsDir, 'default.json'), readFileSync(bundledDefaultsPath, 'utf-8'));

// Workspace under test (relative config paths resolve against this).
const WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'kata-agents-guard-ws-'));

// ── Dynamic imports AFTER env setup (CONFIG_DIR is captured at module load) ──
// `import type` is erased at compile time and never triggers module evaluation,
// so it is safe to reference the pipeline's types before the dynamic imports.
import type { PreToolUseInput } from '../pre-tool-use.ts';

type PreToolUseModule = typeof import('../pre-tool-use.ts');
type ModeManagerModule = typeof import('../../mode-manager.ts');

let runPreToolUseChecks: PreToolUseModule['runPreToolUseChecks'];
let initializeModeState: ModeManagerModule['initializeModeState'];

const SESSION_ALLOW_ALL = 'guard-it-allow-all';
const SESSION_ASK = 'guard-it-ask';
const SESSION_SAFE = 'guard-it-safe';

// ── Valid content samples (verified against the real validators) ─────────────
const VALID_SOURCE_CONFIG = JSON.stringify({
  id: 'src-test',
  name: 'Test Source',
  slug: 'test-source',
  enabled: true,
  provider: 'custom',
  type: 'api',
  api: { baseUrl: 'https://example.com', authType: 'none' },
});
const VALID_SKILL_CONTENT = '---\nname: test\ndescription: d\n---\n# Body\n';
const VALID_STATUSES_CONFIG = JSON.stringify({
  version: 1,
  statuses: [
    { id: 'todo', label: 'To Do', category: 'open', isFixed: true, isDefault: true, order: 0 },
    { id: 'done', label: 'Done', category: 'closed', isFixed: true, isDefault: false, order: 1 },
    { id: 'cancelled', label: 'Cancelled', category: 'closed', isFixed: true, isDefault: false, order: 2 },
  ],
  defaultStatusId: 'todo',
});
const VALID_LABELS_CONFIG = JSON.stringify({ version: 1, labels: [] });
const VALID_PERMISSIONS_CONFIG = '{}';
const VALID_AUTOMATIONS_CONFIG = '{}';
const VALID_TOOL_ICONS_CONFIG = JSON.stringify({
  version: 1,
  tools: [{ id: 'write', displayName: 'Write', icon: 'pen.svg', commands: ['write'] }],
});

/** Build a derivable `cat <<'DELIM' > target` heredoc command. */
function heredoc(delim: string, target: string, body: string): string {
  return `cat <<'${delim}' > ${target}\n${body}\n${delim}`;
}

function createBashInput(command: string, overrides?: Partial<PreToolUseInput>): PreToolUseInput {
  return {
    toolName: 'Bash',
    input: { command },
    sessionId: SESSION_ALLOW_ALL,
    permissionMode: 'allow-all',
    workspaceRootPath: WORKSPACE_ROOT,
    workspaceId: 'guard-test-ws',
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    permissionManager: {
      isCommandWhitelisted: () => false,
      isDangerousCommand: () => false,
      getBaseCommand: (cmd: string) => cmd.split(/\s+/)[0] || cmd,
      extractDomainFromNetworkCommand: () => null,
      isDomainWhitelisted: () => false,
    },
    ...overrides,
  };
}

beforeAll(async () => {
  const preToolUse = await import('../pre-tool-use.ts');
  const modeManager = await import('../../mode-manager.ts');
  runPreToolUseChecks = preToolUse.runPreToolUseChecks;
  initializeModeState = modeManager.initializeModeState;
  initializeModeState(SESSION_ALLOW_ALL, 'allow-all');
  initializeModeState(SESSION_ASK, 'ask');
  initializeModeState(SESSION_SAFE, 'safe');
});

afterAll(() => {
  rmSync(APP_CONFIG_DIR, { recursive: true, force: true });
  rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
});

// ============================================================
// Derivable heredocs: every recognized config type
// ============================================================

describe('derivable heredocs route exact content through validation', () => {
  const recognized: Array<{
    label: string;
    target: string;
    displayFile: string;
    validContent: string;
    invalidContent: string;
  }> = [
    { label: 'source', target: 'sources/linear/config.json', displayFile: 'sources/linear/config.json', validContent: VALID_SOURCE_CONFIG, invalidContent: '{ not json' },
    { label: 'skill', target: 'skills/myskill/SKILL.md', displayFile: 'skills/myskill/SKILL.md', validContent: VALID_SKILL_CONTENT, invalidContent: 'no frontmatter here' },
    { label: 'statuses', target: 'statuses/config.json', displayFile: 'statuses/config.json', validContent: VALID_STATUSES_CONFIG, invalidContent: '{}' },
    { label: 'labels', target: 'labels/config.json', displayFile: 'labels/config.json', validContent: VALID_LABELS_CONFIG, invalidContent: '{ not json' },
    { label: 'permissions', target: 'permissions.json', displayFile: 'permissions.json', validContent: VALID_PERMISSIONS_CONFIG, invalidContent: '{ not json' },
    { label: 'automations', target: 'automations.json', displayFile: 'automations.json', validContent: VALID_AUTOMATIONS_CONFIG, invalidContent: '{ not json' },
  ];

  for (const entry of recognized) {
    it(`allows valid ${entry.label} content via heredoc`, () => {
      const result = runPreToolUseChecks(createBashInput(heredoc('CFG', entry.target, entry.validContent)));
      expect(result.type).toBe('allow');
    });

    it(`blocks invalid ${entry.label} content via heredoc with the real error`, () => {
      const result = runPreToolUseChecks(createBashInput(heredoc('CFG', entry.target, entry.invalidContent)));
      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain(`Cannot write invalid config to ${entry.displayFile}`);
        expect(result.reason).toContain('Fix the errors above and try again');
      }
    });
  }

  it('allows valid tool-icons content via heredoc to the app-level path', () => {
    const target = join(APP_CONFIG_DIR, 'tool-icons', 'tool-icons.json');
    const result = runPreToolUseChecks(createBashInput(heredoc('CFG', target, VALID_TOOL_ICONS_CONFIG)));
    expect(result.type).toBe('allow');
  });

  it('blocks invalid tool-icons content via heredoc to the app-level path', () => {
    const target = join(APP_CONFIG_DIR, 'tool-icons', 'tool-icons.json');
    const result = runPreToolUseChecks(createBashInput(heredoc('CFG', target, '{ not json')));
    expect(result.type).toBe('block');
    if (result.type === 'block') {
      expect(result.reason).toContain('Cannot write invalid config to tool-icons/tool-icons.json');
    }
  });
});

// ============================================================
// Derivable heredoc grammar details
// ============================================================

describe('derivable heredoc grammar', () => {
  it('allows an empty heredoc body to be validated (and blocks as invalid)', () => {
    const result = runPreToolUseChecks(createBashInput(heredoc('CFG', 'labels/config.json', '')));
    expect(result.type).toBe('block');
    if (result.type === 'block') {
      expect(result.reason).toContain('labels/config.json');
    }
  });

  it('supports an absolute target inside the workspace', () => {
    const target = join(WORKSPACE_ROOT, 'labels', 'config.json');
    const result = runPreToolUseChecks(
      createBashInput(heredoc('CFG', target, VALID_LABELS_CONFIG))
    );
    expect(result.type).toBe('allow');
  });

  it('resolves relative targets against the working directory (subdir → not recognized)', () => {
    const result = runPreToolUseChecks(
      createBashInput(heredoc('CFG', 'labels/config.json', VALID_LABELS_CONFIG), {
        workingDirectory: join(WORKSPACE_ROOT, 'packages', 'core'),
      })
    );
    // Resolves to {ws}/packages/core/labels/config.json — not a recognized config.
    expect(result.type).toBe('allow');
  });

  it('does not false-match sibling paths (labelsx/config.json)', () => {
    const result = runPreToolUseChecks(createBashInput(heredoc('CFG', 'labelsx/config.json', '{ not json')));
    expect(result.type).toBe('allow');
  });

  it('does not validate heredoc writes to non-config targets', () => {
    const result = runPreToolUseChecks(
      createBashInput(heredoc('A', '/tmp/out.txt', 'hello world'))
    );
    expect(result.type).toBe('allow');
  });
});

// ============================================================
// Opaque mutations → block
// ============================================================

describe('opaque mutations targeting recognized configs are blocked', () => {
  const cases: Array<{ label: string; command: string; displayFile?: string }> = [
    { label: 'redirect', command: "echo '{}' > labels/config.json", displayFile: 'labels/config.json' },
    { label: 'append redirect', command: "echo '{}' >> labels/config.json", displayFile: 'labels/config.json' },
    { label: 'tee', command: "echo '{}' | tee labels/config.json", displayFile: 'labels/config.json' },
    { label: 'sed -i', command: "sed -i 's/x/y/' labels/config.json", displayFile: 'labels/config.json' },
    { label: 'tab-stripping heredoc (<<-)', command: "cat <<-'CFG' > labels/config.json\n{}\nCFG", displayFile: 'labels/config.json' },
    { label: 'wrapper shell (bash -c)', command: 'bash -c "echo x > labels/config.json"', displayFile: 'labels/config.json' },
    { label: 'script argument', command: 'python update.py labels/config.json', displayFile: 'labels/config.json' },
    { label: 'pipeline + move chaining', command: "jq '.x = 1' labels/config.json > /tmp/out && mv /tmp/out labels/config.json", displayFile: 'labels/config.json' },
    { label: 'source permissions.json via tee', command: "echo '{}' | tee sources/linear/permissions.json", displayFile: 'sources/linear/permissions.json' },
  ];

  for (const c of cases) {
    it(`blocks ${c.label}`, () => {
      const result = runPreToolUseChecks(createBashInput(c.command));
      expect(result.type).toBe('block');
      if (result.type === 'block' && c.displayFile) {
        expect(result.reason).toContain(c.displayFile);
        expect(result.reason).toContain('bypass config validation');
        expect(result.reason).toContain('Write');
      }
    });
  }

  it('includes actionable guidance (validated Write/Edit)', () => {
    const result = runPreToolUseChecks(createBashInput("echo '{}' > labels/config.json"));
    expect(result.type).toBe('block');
    if (result.type === 'block') {
      expect(result.reason).toContain('`Write` or `Edit`');
    }
  });
});

// ============================================================
// Continuations (unaffected behavior)
// ============================================================

describe('commands accepted by immutable-default read-only classifier are unaffected', () => {
  const readOnlyCommands = [
    'cat labels/config.json',
    'grep -n bug labels/config.json',
    'git status labels/config.json',
    'head labels/config.json',
  ];

  for (const command of readOnlyCommands) {
    it(`continues for \`${command}\``, () => {
      const result = runPreToolUseChecks(createBashInput(command));
      expect(result.type).toBe('allow');
    });
  }
});

describe('non-config mutations continue', () => {
  it('allows npm install', () => {
    const result = runPreToolUseChecks(createBashInput('npm install express'));
    expect(result.type).toBe('allow');
  });

  it('allows script args with unrecognized paths', () => {
    const result = runPreToolUseChecks(createBashInput('python3 script.py /tmp/data.json'));
    expect(result.type).toBe('allow');
  });

  it('allows heredoc writes to /tmp', () => {
    const result = runPreToolUseChecks(createBashInput(heredoc('A', '/tmp/out.txt', 'data')));
    expect(result.type).toBe('allow');
  });
});

// ============================================================
// Mode coverage
// ============================================================

describe('mode coverage', () => {
  it('safe mode: merged workspace patterns cannot bypass the guard', () => {
    // Workspace permissions.json whitelists python3 update.py — step 1 (safe,
    // merged config) accepts it, but the guard classifies with immutable
    // defaults only and must still block the config-targeting mutation.
    writeFileSync(
      join(WORKSPACE_ROOT, 'permissions.json'),
      JSON.stringify({ allowedBashPatterns: [{ pattern: '^python3\\s+update\\.py' }] })
    );

    const result = runPreToolUseChecks(
      createBashInput('python3 update.py labels/config.json', {
        sessionId: SESSION_SAFE,
        permissionMode: 'safe',
      })
    );

    expect(result.type).toBe('block');
    if (result.type === 'block') {
      expect(result.reason).toContain('labels/config.json');
    }
  });

  it('ask mode: guard blocks before prompting', () => {
    const result = runPreToolUseChecks(
      createBashInput("echo '{}' > labels/config.json", {
        sessionId: SESSION_ASK,
        permissionMode: 'ask',
      })
    );

    expect(result.type).toBe('block');
    if (result.type === 'block') {
      expect(result.reason).toContain('labels/config.json');
    }
  });

  it('ask mode: valid heredoc proceeds to the normal prompt path', () => {
    const result = runPreToolUseChecks(
      createBashInput(heredoc('CFG', 'labels/config.json', VALID_LABELS_CONFIG), {
        sessionId: SESSION_ASK,
        permissionMode: 'ask',
      })
    );

    // Not blocked by the guard — flows to the ask-mode decision.
    expect(result.type).not.toBe('block');
  });
});

// ============================================================
// validateConfigWrite empty-content handling
// ============================================================

describe('validateConfigWrite empty-content handling', () => {
  it('blocks an explicit empty-string Write to a config file', () => {
    const result = runPreToolUseChecks({
      toolName: 'Write',
      input: { file_path: join(WORKSPACE_ROOT, 'labels', 'config.json'), content: '' },
      sessionId: SESSION_ALLOW_ALL,
      permissionMode: 'allow-all',
      workspaceRootPath: WORKSPACE_ROOT,
      workspaceId: 'guard-test-ws',
      activeSourceSlugs: [],
      allSourceSlugs: [],
      hasSourceActivation: false,
      permissionManager: {
        isCommandWhitelisted: () => false,
        isDangerousCommand: () => false,
        getBaseCommand: (cmd: string) => cmd.split(/\s+/)[0] || cmd,
        extractDomainFromNetworkCommand: () => null,
        isDomainWhitelisted: () => false,
      },
    });

    expect(result.type).toBe('block');
    if (result.type === 'block') {
      expect(result.reason).toContain('Cannot write invalid config to labels/config.json');
    }
  });

  it('allows a Write without a content field (not a content write)', () => {
    const result = runPreToolUseChecks({
      toolName: 'Write',
      input: { file_path: join(WORKSPACE_ROOT, 'labels', 'config.json') },
      sessionId: SESSION_ALLOW_ALL,
      permissionMode: 'allow-all',
      workspaceRootPath: WORKSPACE_ROOT,
      workspaceId: 'guard-test-ws',
      activeSourceSlugs: [],
      allSourceSlugs: [],
      hasSourceActivation: false,
      permissionManager: {
        isCommandWhitelisted: () => false,
        isDangerousCommand: () => false,
        getBaseCommand: (cmd: string) => cmd.split(/\s+/)[0] || cmd,
        extractDomainFromNetworkCommand: () => null,
        isDomainWhitelisted: () => false,
      },
    });

    expect(result.type).toBe('allow');
  });
});
