#!/usr/bin/env bun
/**
 * One-shot hard-cutover migration: Craft Agents → Kata Agents identity.
 * Run once during brand transition Build. Excludes historical docs and LICENSE.
 */
import { readdir, readFile, writeFile, rename, stat } from 'fs/promises';
import { join, relative } from 'path';

const ROOT = join(import.meta.dir, '..');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'release',
  'dist',
  '.husky',
]);

const SKIP_FILES = new Set([
  'bun.lock',
  'LICENSE',
  'brand-transition-migrate.ts',
]);

/** Historical completed specs — preserve Craft-era references for accuracy */
const SKIP_PATH_PREFIXES = [
  'docs/specs/rebrand-kata-agents-phase-1',
  'docs/specs/2026-06-19-ci-release-pipeline',
  'docs/specs/2026-06-20-update-ux-parity-with-kata-code',
  'docs/specs/e2e-foundation-adoption',
  'docs/specs/2026-06-22-complete-kata-brand-transition-design.md',
];

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns',
  '.woff', '.woff2', '.ttf', '.eot',
  '.zip', '.tar', '.gz', '.dmg', '.exe', '.dll', '.so', '.dylib',
  '.pdf', '.wasm',
]);

/** Ordered text replacements — longer/more-specific patterns first */
const REPLACEMENTS: Array<[string, string]> = [
  // Special env var with embedded product slug
  ['CRAFT_FEATURE_CRAFT_AGENTS_CLI', 'KATA_FEATURE_KATA_AGENTS_CLI'],
  // Docs MCP identifiers
  ['craft-agents-docs', 'kata-agents-docs'],
  ['SearchCraftAgents', 'SearchKataAgents'],
  // Package scope
  ['@craft-agent/', '@kata-sh/'],
  // App identity
  ['com.lukilabs.craft-agent', 'sh.kata.agents'],
  ['craftagents://', 'kataagents://'],
  // Domains and email
  ['agents-noreply@craft.do', 'agents-noreply@kata.sh'],
  ['agents.craft.do', 'agents.kata.sh'],
  // Config paths (instance suffixes preserved)
  ['~/.craft-agent', '~/.kata-agents'],
  ['.craft-agent', '.kata-agents'],
  // Binaries
  ['craft-server', 'kata-server'],
  ['craft-cli', 'kata-cli'],
  // Root package name in contexts
  ['"craft-agent"', '"kata-agents"'],
  ["'craft-agent'", "'kata-agents'"],
  // Product-owned binary name (after craft-cli/server to avoid partial matches)
  ['craft-agent.cmd', 'kata-agent.cmd'],
  ['craft-agent', 'kata-agent'],
  // Env prefix (after specific CRAFT_FEATURE_CRAFT_AGENTS_CLI)
  ['CRAFT_', 'KATA_'],
  // Branding constants
  ['KATA_LOGO_HTML', 'KATA_LOGO_HTML_PLACEHOLDER'], // temp to avoid double-rename
  // User-facing product names
  ['Craft Agents', 'Kata Agents'],
  ['Craft Agent', 'Kata Agent'],
  // Author metadata
  ['Craft Docs Ltd. <support@craft.do>', 'Gannon Hall <support@kata.sh>'],
  ['Craft Docs Ltd.', 'Gannon Hall'],
  // Root package name (bare)
  ['craft-agent', 'kata-agents'],
  // Restore placeholder
  ['KATA_LOGO_HTML_PLACEHOLDER', 'KATA_LOGO_HTML'],
];

/** Filename renames */
const FILE_RENAMES: Array<[string, string]> = [
  ['craft-agent.cmd', 'kata-agent.cmd'],
  ['craft-agent', 'kata-agent'],
  ['craft-metadata-schema.ts', 'kata-metadata-schema.ts'],
  ['permissions-config-craft-cli-flag.test.ts', 'permissions-config-kata-cli-flag.test.ts'],
];

function shouldSkip(relPath: string): boolean {
  if (SKIP_FILES.has(relPath.split('/').pop() ?? '')) return true;
  for (const prefix of SKIP_PATH_PREFIXES) {
    if (relPath === prefix || relPath.startsWith(prefix)) return true;
  }
  const parts = relPath.split('/');
  for (const part of parts) {
    if (SKIP_DIRS.has(part)) return true;
  }
  return false;
}

function isBinaryPath(relPath: string): boolean {
  const dot = relPath.lastIndexOf('.');
  if (dot === -1) return false;
  return BINARY_EXT.has(relPath.slice(dot).toLowerCase());
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(ROOT, full);
    if (shouldSkip(rel)) continue;
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function applyReplacements(content: string): string {
  let result = content;
  for (const [from, to] of REPLACEMENTS) {
    result = result.split(from).join(to);
  }
  return result;
}

async function migrateFiles(): Promise<{ changed: number; skipped: number }> {
  let changed = 0;
  let skipped = 0;

  for await (const filePath of walk(ROOT)) {
    const rel = relative(ROOT, filePath);
    if (isBinaryPath(rel)) {
      skipped++;
      continue;
    }

    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      skipped++;
      continue;
    }

    const updated = applyReplacements(content);
    if (updated !== content) {
      await writeFile(filePath, updated, 'utf8');
      changed++;
      console.log(`  updated: ${rel}`);
    }
  }

  return { changed, skipped };
}

async function renameFiles(): Promise<number> {
  let renamed = 0;
  for await (const filePath of walk(ROOT)) {
    const dir = join(filePath, '..');
    const base = filePath.split('/').pop() ?? '';
    for (const [from, to] of FILE_RENAMES) {
      if (base === from) {
        const newPath = join(dir, to);
        try {
          await stat(newPath);
          console.log(`  skip rename (target exists): ${relative(ROOT, filePath)} → ${to}`);
        } catch {
          await rename(filePath, newPath);
          renamed++;
          console.log(`  renamed: ${relative(ROOT, filePath)} → ${to}`);
        }
        break;
      }
    }
  }
  return renamed;
}

async function renameDirs(): Promise<void> {
  const craftLogos = join(ROOT, 'apps/electron/resources/craft-logos');
  const kataLogos = join(ROOT, 'apps/electron/resources/kata-logos');
  try {
    await stat(craftLogos);
    await rename(craftLogos, kataLogos);
    console.log('  renamed dir: apps/electron/resources/craft-logos → kata-logos');
  } catch {
    // already renamed or missing
  }
}

console.log('Brand transition migration starting...\n');

console.log('Phase A: text replacements');
const { changed, skipped } = await migrateFiles();
console.log(`  ${changed} files changed, ${skipped} binary/skipped\n`);

console.log('Phase B: file renames');
const renamed = await renameFiles();
console.log(`  ${renamed} files renamed\n`);

console.log('Phase C: directory renames');
await renameDirs();

console.log('\nDone. Run `bun install` to refresh lockfile.');
