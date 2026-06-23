#!/usr/bin/env bun
/** Second-pass: identifiers, schemes, file renames not covered by pass 1 */
import { readdir, readFile, writeFile, rename, stat } from 'fs/promises';
import { join, relative } from 'path';

const ROOT = join(import.meta.dir, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'release', 'dist', '.husky']);
const SKIP_FILES = new Set(['bun.lock', 'LICENSE', 'brand-transition-migrate.ts', 'brand-transition-pass2.ts']);
const SKIP_PREFIXES = [
  'docs/specs/rebrand-kata-agents-phase-1',
  'docs/specs/2026-06-19-ci-release-pipeline',
  'docs/specs/2026-06-20-update-ux-parity-with-kata-code',
  'docs/specs/e2e-foundation-adoption',
  'docs/specs/2026-06-22-complete-kata-brand-transition-design.md',
];

const REPLACEMENTS: Array<[string, string]> = [
  // Deeplink scheme (without ://)
  ["'craftagents'", "'kataagents'"],
  ['"craftagents"', '"kataagents"'],
  ['craftagents:', 'kataagents:'],
  ['craftagents1', 'kataagents1'],
  ['craftagents2', 'kataagents2'],
  ['craftagents${', 'kataagents${'],
  ['`craftagents${', '`kataagents${'],
  // Docker user
  ['craftagents', 'kataagents'],
  // Identifiers
  ['isCraftAgentsCliEnabled', 'isKataAgentsCliEnabled'],
  ['craftAgentsCli', 'kataAgentsCli'],
  ['getCraftAgentReadOnlyBashPatterns', 'getKataAgentReadOnlyBashPatterns'],
  ['isCraftAgentPattern', 'isKataAgentPattern'],
  ['getCraftAgentEnvironmentMarker', 'getKataAgentEnvironmentMarker'],
  ['craft_agent_environment', 'kata_agent_environment'],
  ['parseInternalCraftAgentsDeepLink', 'parseInternalKataAgentsDeepLink'],
  ['allowCraftMetadataProperties', 'allowKataMetadataProperties'],
  ['stripCraftMetadata', 'stripKataMetadata'],
  ['CraftAgentEvent', 'KataAgentEvent'],
  ['CraftAgentLogo', 'KataAgentLogo'],
  ['CraftAgentsLogo', 'KataAgentsLogo'],
  ['CraftAgentsSymbol', 'KataAgentsSymbol'],
  ['CraftAgentsBot', 'KataAgentsBot'],
  ['CraftAgent', 'KataAgent'],
  ['CraftAgents', 'KataAgents'],
  ['mockCraftAgentsCliFlag', 'mockKataAgentsCliFlag'],
  ['sync-craft-agent-bash-patterns', 'sync-kata-agent-bash-patterns'],
  ['permissions-craft-agent-sync', 'permissions-kata-agent-sync'],
  ['craft-metadata-schema', 'kata-metadata-schema'],
  ['craft-logos', 'kata-logos'],
  // i18n keys
  ['menu.aboutCraftAgents', 'menu.aboutKataAgents'],
  ['menu.hideCraftAgents', 'menu.hideKataAgents'],
  ['menu.quitCraftAgents', 'menu.quitKataAgents'],
];

const FILE_RENAMES: Array<[string, string]> = [
  ['CraftAgentsLogo.tsx', 'KataAgentsLogo.tsx'],
  ['CraftAgentsSymbol.tsx', 'KataAgentsSymbol.tsx'],
  ['sync-craft-agent-bash-patterns.ts', 'sync-kata-agent-bash-patterns.ts'],
  ['permissions-craft-agent-sync.test.ts', 'permissions-kata-agent-sync.test.ts'],
  ['craft-metadata-schema.test.ts', 'kata-metadata-schema.test.ts'],
];

function shouldSkip(rel: string): boolean {
  if (SKIP_FILES.has(rel.split('/').pop() ?? '')) return true;
  for (const p of SKIP_PREFIXES) if (rel === p || rel.startsWith(p)) return true;
  return rel.split('/').some((p) => SKIP_DIRS.has(p));
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(ROOT, full);
    if (shouldSkip(rel)) continue;
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function apply(s: string): string {
  let r = s;
  for (const [a, b] of REPLACEMENTS) r = r.split(a).join(b);
  return r;
}

let changed = 0;
for await (const f of walk(ROOT)) {
  if (/\.(png|jpg|ico|icns|woff|gif|webp|pdf|dmg|exe|dll|so|dylib|zip|tar|gz|wasm)$/i.test(f)) continue;
  let c: string;
  try { c = await readFile(f, 'utf8'); } catch { continue; }
  const u = apply(c);
  if (u !== c) { await writeFile(f, u); changed++; console.log('  ' + relative(ROOT, f)); }
}
console.log(`Text: ${changed} files`);

for await (const f of walk(ROOT)) {
  const base = f.split('/').pop() ?? '';
  for (const [from, to] of FILE_RENAMES) {
    if (base === from) {
      const dest = join(f, '..', to);
      try { await stat(dest); } catch { await rename(f, dest); console.log(`Renamed ${relative(ROOT, f)} → ${to}`); }
      break;
    }
  }
}
