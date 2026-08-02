import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

const PREFS_MODULE = pathToFileURL(join(import.meta.dir, '..', 'preferences.ts')).href;

function runScript(configDir: string, script: string) {
  return Bun.spawnSync([process.execPath, '--eval', script], {
    env: { ...process.env, KATA_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('preferences.expandToolActivityByDefault', () => {
  it('defaults to false when the preference is missing', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'preferences-tool-activity-'));
    try {
      const result = runScript(configDir, `
        import { getExpandToolActivityByDefault } from '${PREFS_MODULE}';
        console.log(JSON.stringify({ value: getExpandToolActivityByDefault() }));
      `);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual({ value: false });
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('persists the setting while preserving unrelated preferences', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'preferences-tool-activity-'));
    const prefsFile = join(configDir, 'preferences.json');
    try {
      writeFileSync(prefsFile, JSON.stringify({ name: 'Alice' }), 'utf-8');
      const result = runScript(configDir, `
        import { getExpandToolActivityByDefault, setExpandToolActivityByDefault } from '${PREFS_MODULE}';
        setExpandToolActivityByDefault(true);
        console.log(JSON.stringify({ value: getExpandToolActivityByDefault() }));
      `);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual({ value: true });

      const persisted = JSON.parse(readFileSync(prefsFile, 'utf-8'));
      expect(persisted.name).toBe('Alice');
      expect(persisted.expandToolActivityByDefault).toBe(true);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
