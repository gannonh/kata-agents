#!/usr/bin/env bun
/**
 * Build script for standalone Kata Agent server.
 *
 * Assembles a self-contained distribution directory with all runtime
 * dependencies, resources, and platform-specific binaries.
 *
 * Usage:
 *   bun run scripts/build-server.ts
 *   bun run scripts/build-server.ts --platform=linux --arch=x64
 *   bun run scripts/build-server.ts --platform=linux --arch=arm64 --compress
 *
 * Options:
 *   --platform       Target platform: darwin, linux (default: current)
 *   --arch           Target architecture: x64, arm64 (default: current)
 *   --output         Output directory (default: dist/server)
 *   --compress       Create .tar.gz archive after assembly
 *   --skip-download  Skip Bun/uv downloads (use existing if present)
 *   --help           Show help
 */

process.on('uncaughtException', (error) => {
  console.error('\n  Build failed (uncaught):', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('\n  Build failed (unhandled):', reason);
  process.exit(1);
});

import { parseArgs } from 'util';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  existsSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  cpSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
} from 'fs';
import { $ } from 'bun';
import { verifyLegalDirectory } from './verify-legal-assets';
import {
  renderCanonicalCompose,
  renderPackagedInstallScript,
  renderPackagedServerWrapper,
} from './server-packaging';
import {
  type Platform,
  type Arch,
  type BuildConfig,
  BUN_VERSION,
  UV_VERSION,
  downloadBun,
  downloadUv,
  buildMcpServers,
  getPlatformKey,
} from './build/common';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ServerPlatform = 'darwin' | 'linux';

interface ServerBuildConfig {
  platform: ServerPlatform;
  arch: Arch;
  rootDir: string;
  electronDir: string;  // Source of resources
  outputDir: string;
  compress: boolean;
  skipDownload: boolean;
  version: string;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`
Standalone server build script for Kata Agent

Usage:
  bun run scripts/build-server.ts [options]

Options:
  --platform=<platform>  Target platform: darwin, linux
                         (default: ${process.platform})
  --arch=<arch>          Target architecture: x64, arm64
                         (default: ${process.arch === 'arm64' ? 'arm64' : 'x64'})
  --output=<path>        Output directory (default: dist/server)
  --compress             Create .tar.gz after assembly
  --skip-download        Reuse existing Bun/uv binaries
  --help                 Show this help message

Examples:
  # Build for current platform
  bun run scripts/build-server.ts

  # Build Linux x64 tarball
  bun run scripts/build-server.ts --platform=linux --arch=x64 --compress

  # Build Linux ARM64 tarball
  bun run scripts/build-server.ts --platform=linux --arch=arm64 --compress
`);
}

// ---------------------------------------------------------------------------
// Resource assembly
// ---------------------------------------------------------------------------

function assembleResources(config: ServerBuildConfig): void {
  const { electronDir, outputDir, platform, arch } = config;
  const srcResources = join(electronDir, 'resources');
  const destResources = join(outputDir, 'resources');

  console.log('  Copying legal files...');
  for (const file of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) {
    copyFileSync(join(config.rootDir, file), join(outputDir, file));
  }
  verifyLegalDirectory(outputDir);

  console.log('  Copying docs, themes, permissions, tool-icons...');
  for (const dir of ['docs', 'themes', 'permissions', 'tool-icons']) {
    const src = join(srcResources, dir);
    if (existsSync(src)) {
      cpSync(src, join(destResources, dir), { recursive: true });
    }
  }

  // Config defaults
  const configDefaults = join(srcResources, 'config-defaults.json');
  if (existsSync(configDefaults)) {
    copyFileSync(configDefaults, join(destResources, 'config-defaults.json'));
  }

  // Python scripts (skip tests/)
  console.log('  Copying Python scripts...');
  const scriptsDir = join(srcResources, 'scripts');
  const destScripts = join(destResources, 'scripts');
  mkdirSync(destScripts, { recursive: true });
  if (existsSync(scriptsDir)) {
    for (const entry of readdirSync(scriptsDir)) {
      if (entry === 'tests') continue;
      const src = join(scriptsDir, entry);
      const stat = lstatSync(src);
      if (stat.isFile()) {
        copyFileSync(src, join(destScripts, entry));
      }
    }
  }

  // Shell wrappers for doc tools (not .cmd files — those are Windows-only)
  console.log('  Copying doc tool wrappers...');
  const binDir = join(destResources, 'bin');
  mkdirSync(binDir, { recursive: true });
  const srcBin = join(srcResources, 'bin');
  if (existsSync(srcBin)) {
    for (const entry of readdirSync(srcBin)) {
      const src = join(srcBin, entry);
      const stat = lstatSync(src);
      // Only copy files (not platform directories), skip .cmd
      if (stat.isFile() && !entry.endsWith('.cmd')) {
        copyFileSync(src, join(binDir, entry));
      }
    }
  }

  // MCP servers
  console.log('  Copying MCP servers...');
  for (const server of ['session-mcp-server', 'bridge-mcp-server']) {
    const src = join(srcResources, server);
    if (existsSync(src)) {
      cpSync(src, join(destResources, server), { recursive: true });
    }
  }

  // Also copy session-mcp-server from packages/ build output (dev path fallback)
  const sessionServerDist = join(config.rootDir, 'packages', 'session-mcp-server', 'dist', 'index.js');
  if (existsSync(sessionServerDist)) {
    const destSessionServer = join(destResources, 'session-mcp-server');
    mkdirSync(destSessionServer, { recursive: true });
    copyFileSync(sessionServerDist, join(destSessionServer, 'index.js'));
  }
}

// ---------------------------------------------------------------------------
// uv binary — download into output dir (not electron resources)
// ---------------------------------------------------------------------------

async function downloadUvForServer(config: ServerBuildConfig): Promise<void> {
  const { platform, arch, outputDir, skipDownload } = config;
  const uvDest = join(outputDir, 'resources', 'bin', 'uv');

  if (skipDownload && existsSync(uvDest)) {
    console.log('  uv already present, skipping download');
    return;
  }

  // Use common.ts downloadUv which writes to electronDir/resources/bin/{platform-arch}/
  // Then we'll copy the binary to our flat layout
  const platformKey = getPlatformKey(platform, arch);
  const electronUvPath = join(config.electronDir, 'resources', 'bin', platformKey, 'uv');

  if (!existsSync(electronUvPath)) {
    // Download using the shared helper
    const buildConfig: BuildConfig = {
      platform,
      arch,
      upload: false,
      uploadLatest: false,
      uploadScript: false,
      rootDir: config.rootDir,
      electronDir: config.electronDir,
    };
    await downloadUv(buildConfig);
  }

  if (!existsSync(electronUvPath)) {
    throw new Error(`uv binary not found after download at ${electronUvPath}`);
  }

  // Flatten: copy to resources/bin/uv (no platform subdirectory in server dist)
  const binDir = join(outputDir, 'resources', 'bin');
  mkdirSync(binDir, { recursive: true });
  copyFileSync(electronUvPath, uvDest);
  await $`chmod +x ${uvDest}`.quiet();
  console.log(`  uv binary installed (${(lstatSync(uvDest).size / 1024 / 1024).toFixed(1)} MB)`);
}

// ---------------------------------------------------------------------------
// Bun runtime — download into output dir
// ---------------------------------------------------------------------------

async function downloadBunForServer(config: ServerBuildConfig): Promise<void> {
  const { platform, arch, outputDir, skipDownload } = config;
  const runtimeDir = join(outputDir, 'vendor', 'bun');
  const bunDest = join(runtimeDir, 'bun');

  if (skipDownload && existsSync(bunDest)) {
    console.log('  Bun already present, skipping download');
    return;
  }

  // Download to electron's vendor dir using shared helper, then copy
  const buildConfig: BuildConfig = {
    platform,
    arch,
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir: config.rootDir,
    electronDir: config.electronDir,
  };
  await downloadBun(buildConfig);

  const electronBunPath = join(config.electronDir, 'vendor', 'bun', 'bun');
  if (!existsSync(electronBunPath)) {
    throw new Error(`Bun binary not found after download at ${electronBunPath}`);
  }

  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(electronBunPath, bunDest);
  await $`chmod +x ${bunDest}`.quiet();
  console.log(`  Bun runtime installed (${(lstatSync(bunDest).size / 1024 / 1024).toFixed(1)} MB)`);
}

// ---------------------------------------------------------------------------
// Production node_modules
// ---------------------------------------------------------------------------

/**
 * Recursively resolve and copy a package and its entire dependency tree.
 * Reads each package's package.json to discover transitive deps.
 */
function copyDependencyTree(
  dep: string,
  srcModules: string,
  destModules: string,
  visited: Set<string>,
): void {
  if (visited.has(dep)) return;
  visited.add(dep);

  const src = join(srcModules, dep);
  if (!existsSync(src)) return;

  // Ensure scope directory exists
  if (dep.startsWith('@')) {
    const scope = dep.split('/')[0]!;
    mkdirSync(join(destModules, scope), { recursive: true });
  }

  const dest = join(destModules, dep);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, dereference: true });

  // Recurse into dependencies
  const pkgPath = join(src, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      for (const childDep of Object.keys(pkg.dependencies || {})) {
        copyDependencyTree(childDep, srcModules, destModules, visited);
      }
    } catch {
      // Skip if package.json is malformed
    }
  }
}

/**
 * Scan all .ts files in a directory tree for import/require statements
 * and return the set of external npm package names (not relative paths,
 * not node: builtins, not workspace @kata-sh/* packages).
 */
function scanImports(dir: string): Set<string> {
  const packages = new Set<string>();
  // Match: import ... from 'pkg', require('pkg'), import('pkg')
  const importRe = /(?:from\s+['"]|require\s*\(\s*['"]|import\s*\(\s*['"])([^'"]+)['"]/g;

  function walk(d: string): void {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'tests' && entry.name !== '__tests__') {
        walk(full);
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
        const content = readFileSync(full, 'utf-8');
        let match: RegExpExecArray | null;
        while ((match = importRe.exec(content)) !== null) {
          const spec = match[1]!;
          // Skip relative imports, node: builtins, workspace packages
          if (spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('@kata-sh/')) continue;
          // Extract package name (handle scoped: @scope/name)
          const parts = spec.split('/');
          const pkgName = spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!;
          packages.add(pkgName);
        }
      }
    }
  }

  walk(dir);
  return packages;
}

function copyProductionDeps(config: ServerBuildConfig): void {
  const { rootDir, outputDir, platform, arch } = config;
  const srcModules = join(rootDir, 'node_modules');
  const destModules = join(outputDir, 'node_modules');

  // Track all copied packages to avoid duplicates
  const copied = new Set<string>();

  // -------------------------------------------------------------------------
  // 1. Scan source code for ALL external imports across server packages
  //    This catches everything — declared deps, undeclared deps, transitive
  //    imports that happen to work due to hoisting. No more whack-a-mole.
  // -------------------------------------------------------------------------
  // messaging-gateway is included so its runtime deps (grammy, etc.) land in node_modules.
  // messaging-whatsapp-worker is intentionally OMITTED: Baileys and its transitive deps
  // are bundled directly into packages/messaging-whatsapp-worker/dist/worker.cjs by
  // scripts/build-wa-worker.ts — pulling them into node_modules would duplicate the tree.
  const SERVER_PACKAGES = ['server', 'server-core', 'shared', 'core', 'session-tools-core', 'session-mcp-server', 'messaging-gateway'];

  const allImports = new Set<string>();
  for (const pkg of SERVER_PACKAGES) {
    const pkgSrc = join(rootDir, 'packages', pkg, 'src');
    const imports = scanImports(pkgSrc);
    for (const imp of imports) allImports.add(imp);
  }
  console.log(`  Found ${allImports.size} external packages referenced in source`);

  // Also include declared dependencies (catches deps used only at runtime / dynamically)
  for (const pkg of SERVER_PACKAGES) {
    const pkgJsonPath = join(rootDir, 'packages', pkg, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    try {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      for (const [dep, version] of Object.entries(pkgJson.dependencies || {}) as [string, string][]) {
        if (typeof version === 'string' && version.startsWith('workspace:')) continue;
        allImports.add(dep);
      }
      // Also peer dependencies (they're real runtime deps)
      for (const dep of Object.keys(pkgJson.peerDependencies || {})) {
        allImports.add(dep);
      }
    } catch { /* skip */ }
  }

  // Copy each discovered package and its full transitive dependency tree
  for (const dep of allImports) {
    copyDependencyTree(dep, srcModules, destModules, copied);
  }
  console.log(`  Source imports + declared deps: ${copied.size} packages`);

  // -------------------------------------------------------------------------
  // 2. Platform-specific native binaries (optionalDependencies, not in dep trees)
  // -------------------------------------------------------------------------
  // NOTE on `@anthropic-ai/claude-agent-sdk-<platform>-<arch>`: since SDK
  // 0.2.113 the SDK ships only sdk.mjs in the main package; the native
  // `claude` binary lives in this per-platform optional dep. The server runs
  // on its host platform/arch so we ship only the matching one.
  const sdkPlatformPkg = platform === 'win32'
    ? `@anthropic-ai/claude-agent-sdk-win32-${arch}`
    : `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;

  const PLATFORM_DEPS = [
    `@img/sharp-${platform === 'darwin' ? 'darwin' : 'linux'}-${arch}`,
    `@img/sharp-libvips-${platform === 'darwin' ? 'darwin' : 'linux'}-${arch}`,
    '@img/colour',
    sdkPlatformPkg,
    '@vscode/ripgrep',
  ];

  for (const dep of PLATFORM_DEPS) {
    if (copied.has(dep)) continue;
    const src = join(srcModules, dep);
    if (!existsSync(src)) {
      console.log(`  Skipping ${dep} (not installed for current platform)`);
      continue;
    }
    if (dep.startsWith('@')) {
      const scope = dep.split('/')[0]!;
      mkdirSync(join(destModules, scope), { recursive: true });
    }
    mkdirSync(dirname(join(destModules, dep)), { recursive: true });
    cpSync(src, join(destModules, dep), { recursive: true, dereference: true });
    copied.add(dep);
  }

  console.log(`  Total: ${copied.size} packages copied to node_modules`);
}

function getDirSize(dir: string): number {
  let size = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isFile()) {
      size += lstatSync(fullPath).size;
    } else if (entry.isDirectory()) {
      size += getDirSize(fullPath);
    }
  }
  return size;
}

// ---------------------------------------------------------------------------
// Workspace packages
// ---------------------------------------------------------------------------

function copyWorkspacePackages(config: ServerBuildConfig): void {
  const { rootDir, outputDir } = config;

  // messaging-whatsapp-worker is included so dist/worker.cjs (built in step 4) ships.
  // The worker is spawned as a Node subprocess against that file at runtime; see
  // KATA_MESSAGING_WA_WORKER env resolution in packages/server/src/index.ts.
  const packages = [
    'server',
    'server-core',
    'shared',
    'core',
    'session-tools-core',
    'session-mcp-server',
    'messaging-gateway',
    'messaging-whatsapp-worker',
  ];

  for (const pkg of packages) {
    const src = join(rootDir, 'packages', pkg);
    const dest = join(outputDir, 'packages', pkg);

    if (!existsSync(src)) {
      console.warn(`  Warning: package ${pkg} not found`);
      continue;
    }

    mkdirSync(dest, { recursive: true });

    // Copy package.json
    copyFileSync(join(src, 'package.json'), join(dest, 'package.json'));

    // Copy tsconfig.json if present
    const tsconfig = join(src, 'tsconfig.json');
    if (existsSync(tsconfig)) {
      copyFileSync(tsconfig, join(dest, 'tsconfig.json'));
    }

    // Copy src/ directory
    const srcDir = join(src, 'src');
    if (existsSync(srcDir)) {
      cpSync(srcDir, join(dest, 'src'), { recursive: true });
    }

    // Copy dist/ directory if present (built artifacts like session-mcp-server)
    const distDir = join(src, 'dist');
    if (existsSync(distDir)) {
      cpSync(distDir, join(dest, 'dist'), { recursive: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Root config files for workspace resolution
// ---------------------------------------------------------------------------

function createRootConfig(config: ServerBuildConfig): void {
  const { outputDir, version } = config;

  // Root package.json with workspaces (Bun resolves @kata-sh/* through this)
  const rootPkg = {
    name: 'kata-server-dist',
    version,
    private: true,
    workspaces: ['packages/*'],
  };
  writeFileSync(join(outputDir, 'package.json'), JSON.stringify(rootPkg, null, 2) + '\n');

  // Root tsconfig.json for path resolution
  const rootTsconfig = {
    compilerOptions: {
      target: 'ESNext',
      module: 'ESNext',
      moduleResolution: 'bundler',
      paths: {
        '@kata-sh/server-core/*': ['./packages/server-core/src/*'],
        '@kata-sh/shared/*': ['./packages/shared/src/*'],
        '@kata-sh/core/*': ['./packages/core/src/*'],
        '@kata-sh/session-tools-core/*': ['./packages/session-tools-core/src/*'],
      },
    },
  };
  writeFileSync(join(outputDir, 'tsconfig.json'), JSON.stringify(rootTsconfig, null, 2) + '\n');

  // Create workspace symlinks in node_modules/@kata-sh/
  // Bun needs these to resolve workspace package imports at runtime
  const scopeDir = join(outputDir, 'node_modules', '@kata-sh');
  mkdirSync(scopeDir, { recursive: true });

  const packagesDir = join(outputDir, 'packages');
  if (existsSync(packagesDir)) {
    for (const pkg of readdirSync(packagesDir)) {
      const pkgJsonPath = join(packagesDir, pkg, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;

      try {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
        const name: string = pkgJson.name || '';
        if (name.startsWith('@kata-sh/')) {
          const shortName = name.replace('@kata-sh/', '');
          const linkPath = join(scopeDir, shortName);
          const target = join('..', '..', 'packages', pkg);
          if (!existsSync(linkPath)) {
            symlinkSync(target, linkPath, 'dir');
            console.log(`  Symlink: ${name} -> packages/${pkg}`);
          }
        }
      } catch {
        // Skip if package.json is malformed
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry scripts
// ---------------------------------------------------------------------------

function createEntryScripts(config: ServerBuildConfig): void {
  const { outputDir } = config;
  const binDir = join(outputDir, 'bin');
  mkdirSync(binDir, { recursive: true });

  writeFileSync(join(binDir, 'kata-server'), renderPackagedServerWrapper());

  // start.sh — convenience entry
  const startSh = `#!/bin/sh
# Kata Agent Server — convenience entry point
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$DIR/.env" ]; then
  set -a
  . "$DIR/.env"
  set +a
fi
exec "$DIR/bin/kata-server" "$@"
`;
  writeFileSync(join(outputDir, 'start.sh'), startSh);

  writeFileSync(join(outputDir, 'install.sh'), renderPackagedInstallScript());

  // Make scripts executable at build time
  for (const script of [
    join(binDir, 'kata-server'),
    join(outputDir, 'start.sh'),
    join(outputDir, 'install.sh'),
  ]) {
    chmodSync(script, 0o755);
  }
}

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

function createDockerFiles(config: ServerBuildConfig): void {
  const { outputDir, version } = config;

  const dockerfile = `FROM oven/bun:1.3-slim

WORKDIR /app

# Copy pre-assembled server distribution
COPY . .

# Make binaries executable
RUN chmod +x bin/kata-server vendor/bun/bun resources/bin/uv && \\
    for f in resources/bin/*; do [ -f "$f" ] && chmod +x "$f"; done

ENV KATA_IS_PACKAGED=true
ENV KATA_BUNDLED_ASSETS_ROOT=/app
ENV KATA_APP_ROOT=/app
ENV KATA_RESOURCES_PATH=/app/resources
ENV KATA_UV=/app/resources/bin/uv
ENV KATA_SCRIPTS=/app/resources/scripts
ENV KATA_RPC_HOST=0.0.0.0
ENV KATA_RPC_PORT=9100
ENV KATA_DATA_ROOT=/var/lib/kata-agents
ENV KATA_HEALTH_PORT=9101
ENV PATH="/app/resources/bin:/app/vendor/bun:\${PATH}"

EXPOSE 9100 9101

ENTRYPOINT ["/app/bin/kata-server"]
`;
  writeFileSync(join(outputDir, 'Dockerfile'), dockerfile);

  writeFileSync(join(outputDir, 'docker-compose.yml'), renderCanonicalCompose());
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      platform: { type: 'string', default: process.platform },
      arch: { type: 'string', default: process.arch === 'arm64' ? 'arm64' : 'x64' },
      output: { type: 'string', default: 'dist/server' },
      compress: { type: 'boolean', default: false },
      'skip-download': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    showHelp();
    process.exit(0);
  }

  const platform = values.platform as ServerPlatform;
  if (platform !== 'darwin' && platform !== 'linux') {
    console.error(`Unsupported platform: ${platform}. Use darwin or linux.`);
    process.exit(1);
  }

  const arch = values.arch as Arch;
  if (arch !== 'x64' && arch !== 'arm64') {
    console.error(`Unsupported arch: ${arch}. Use x64 or arm64.`);
    process.exit(1);
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptDir);
  const electronDir = join(rootDir, 'apps', 'electron');

  if (!existsSync(join(rootDir, 'package.json'))) {
    console.error('Must run from the repository root');
    process.exit(1);
  }

  // Read version from electron package.json
  const electronPkg = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf-8'));
  const version: string = electronPkg.version;

  const outputDir = join(rootDir, values.output!);

  const config: ServerBuildConfig = {
    platform,
    arch,
    rootDir,
    electronDir,
    outputDir,
    compress: values.compress ?? false,
    skipDownload: values['skip-download'] ?? false,
    version,
  };

  console.log(`=== Building Kata Agent Server ${version} for ${platform}-${arch} ===`);
  console.log(`  Output: ${outputDir}`);

  // Step 1: Clean
  console.log('\n[1/8] Cleaning output directory...');
  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true, force: true });
  }
  mkdirSync(outputDir, { recursive: true });

  // Step 2: Download Bun runtime
  console.log(`\n[2/8] Downloading Bun ${BUN_VERSION}...`);
  await downloadBunForServer(config);

  // Step 3: Download uv
  console.log(`\n[3/8] Downloading uv ${UV_VERSION}...`);
  await downloadUvForServer(config);

  // Step 4: Build MCP servers
  console.log('\n[4/8] Building MCP servers...');
  const buildConfig: BuildConfig = {
    platform,
    arch,
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir,
    electronDir,
  };
  buildMcpServers(buildConfig);

  // Build the WhatsApp worker bundle. Must happen before copyWorkspacePackages
  // so dist/worker.cjs exists when we copy the messaging-whatsapp-worker package.
  // The bundle embeds Baileys + transitive deps; see scripts/build-wa-worker.ts.
  console.log('  Building WhatsApp worker bundle...');
  await $`bun run ${join(rootDir, 'scripts', 'build-wa-worker.ts')}`.cwd(rootDir);

  // Step 5: Assemble resources
  console.log('\n[5/8] Assembling resources...');
  assembleResources(config);

  // Step 6: Copy production node_modules
  console.log('\n[6/8] Copying production dependencies...');
  copyProductionDeps(config);

  // Step 7: Copy workspace packages
  console.log('\n[7/8] Copying workspace packages...');
  copyWorkspacePackages(config);
  createRootConfig(config);

  // Step 8: Create entry scripts + Docker files
  console.log('\n[8/8] Creating entry scripts...');
  createEntryScripts(config);
  createDockerFiles(config);

  // Calculate total size
  const totalSize = getDirSize(outputDir);
  console.log(`\n  Assembly complete: ${(totalSize / 1024 / 1024).toFixed(0)} MB`);

  // Compress if requested
  if (config.compress) {
    const archiveName = `kata-server-${version}-${platform}-${arch}.tar.gz`;
    const archivePath = join(dirname(outputDir), archiveName);
    console.log(`\nCompressing to ${archiveName}...`);
    await $`tar -czf ${archivePath} -C ${outputDir} .`;
    const archiveSize = lstatSync(archivePath).size;
    console.log(`  Archive: ${(archiveSize / 1024 / 1024).toFixed(0)} MB`);
    console.log(`  Path: ${archivePath}`);
  }

  console.log('\n  Build completed successfully!');
  console.log(`\nQuick start:`);
  console.log(`  KATA_SERVER_TOKEN=<secret> ${outputDir}/start.sh`);
}

main();
