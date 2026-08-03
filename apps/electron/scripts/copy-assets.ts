/**
 * Cross-platform asset copy script.
 *
 * Copies the resources/ directory to dist/resources/.
 * All bundled assets (docs, themes, permissions, tool-icons) now live in resources/
 * which electron-builder handles natively via directories.buildResources.
 *
 * At Electron startup, setBundledAssetsRoot(__dirname) is called, and then
 * getBundledAssetsDir('docs') resolves to <__dirname>/resources/docs/, etc.
 *
 * Run: bun scripts/copy-assets.ts
 */

import { cpSync, copyFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { verifyLegalDirectory } from '../../../scripts/verify-legal-assets';

// Clean stale files (e.g. renamed brand assets) so the destination mirrors the source exactly.
rmSync('dist/resources', { recursive: true, force: true });

// Copy all resources (icons, themes, docs, permissions, tool-icons, etc.)
cpSync('resources', 'dist/resources', { recursive: true });

console.log('✓ Copied resources/ → dist/resources/');

// Legal files must be present at the packaged app resource root, not only in
// the source repository. electron-builder includes dist/**/* in every target.
const legalFiles = ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md'];
for (const file of legalFiles) {
  copyFileSync(join('..', '..', file), join('dist', file));
}
verifyLegalDirectory('dist');
console.log('✓ Copied and verified legal files → dist/');

// Copy PowerShell parser script (for Windows command validation in Explore mode)
// Source: packages/shared/src/agent/powershell-parser.ps1
// Destination: dist/resources/powershell-parser.ps1
const psParserSrc = join('..', '..', 'packages', 'shared', 'src', 'agent', 'powershell-parser.ps1');
const psParserDest = join('dist', 'resources', 'powershell-parser.ps1');
try {
  copyFileSync(psParserSrc, psParserDest);
  console.log('✓ Copied powershell-parser.ps1 → dist/resources/');
} catch (err) {
  // Only warn - PowerShell validation is optional on non-Windows platforms
  console.log('⚠ powershell-parser.ps1 copy skipped (not critical on non-Windows)');
}
