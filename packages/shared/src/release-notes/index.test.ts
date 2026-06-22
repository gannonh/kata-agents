import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setBundledAssetsRoot } from '../utils/paths.ts';
import { getReleaseNotesList, getLatestReleaseVersion } from './index.ts';

// getReleaseNotesList reads bundled assets from disk and caches them on first
// call, so this fixture must be installed before any other caller in-process.
const root = mkdtempSync(join(tmpdir(), 'release-notes-'));
const notesDir = join(root, 'resources', 'release-notes');
mkdirSync(notesDir, { recursive: true });
writeFileSync(join(notesDir, '0.10.6.md'), '# v0.10.6\n\nNewest.');
writeFileSync(join(notesDir, '0.9.0.md'), '# v0.9.0\n\nOlder.');
// Non-versioned files that must never reach the overlay.
writeFileSync(join(notesDir, 'next.md'), '# Pending Release Notes\n\nDo not show.');
writeFileSync(join(notesDir, 'README.md'), 'Not a release note.');
setBundledAssetsRoot(root);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('getReleaseNotesList', () => {
  test('excludes next.md and other non-X.Y.Z files', () => {
    const versions = getReleaseNotesList().map((n) => n.version);
    expect(versions).toEqual(['0.10.6', '0.9.0']);
    expect(versions).not.toContain('next');
    expect(versions).not.toContain('README');
  });

  test('latest version ignores the accumulator', () => {
    expect(getLatestReleaseVersion()).toBe('0.10.6');
  });
});
