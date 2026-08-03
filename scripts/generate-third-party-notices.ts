#!/usr/bin/env bun
/**
 * Generate the repository's third-party attribution and license inventory.
 *
 * The inventory follows runtime dependency edges declared by the workspace
 * manifests, records PEP 723 dependencies used by bundled Python tools, and
 * includes the non-package components that are copied into release artifacts.
 * Run `bun run licenses:generate` after dependency or bundled-asset changes.
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'

type JsonObject = Record<string, unknown>

type LicenseFile = {
  /** Actual installed path used to read the license text. */
  actualPath: string
  /** Stable package-relative path rendered in the generated inventory. */
  displayPath: string
}

type PackageRecord = {
  name: string
  version: string
  license: string
  source: string
  licenseFiles: LicenseFile[]
  packageRoot: string
}

type LicenseText = {
  packages: string[]
  path: string
  text: string
}

type PythonRecord = {
  name: string
  constraint: string
  license: string
  source: string
}

const ROOT = resolve(import.meta.dir, '..')
const OUTPUT = join(ROOT, 'THIRD-PARTY-NOTICES.md')
const PACKAGE_JSON = 'package.json'
const LICENSE_FILE = /^(license|licence|copying|notice|copyright)(\..*)?$/i
const PLATFORM_PACKAGES = new Set([
  'darwin',
  'linux',
  'win32',
  'windows',
  'android',
  'freebsd',
])

const PYTHON_LICENSES: Record<string, { license: string; source: string }> = {
  click: { license: 'BSD-3-Clause', source: 'https://github.com/pallets/click' },
  'diff-match-patch': {
    license: 'Apache-2.0',
    source: 'https://github.com/diff-match-patch-python/diff-match-patch',
  },
  icalendar: { license: 'BSD-2-Clause', source: 'https://github.com/collective/icalendar' },
  img2pdf: {
    license: 'LGPL-3.0-or-later',
    source: 'https://gitlab.mister-muffin.de/josch/img2pdf',
  },
  markitdown: { license: 'MIT', source: 'https://github.com/microsoft/markitdown' },
  openpyxl: { license: 'MIT', source: 'https://foss.heptapod.net/openpyxl/openpyxl' },
  pillow: { license: 'MIT-CMU', source: 'https://github.com/python-pillow/Pillow' },
  pypdf: { license: 'BSD-3-Clause', source: 'https://github.com/py-pdf/pypdf' },
  pypdfium2: { license: 'BSD-3-Clause', source: 'https://github.com/pypdfium2-team/pypdfium2' },
  'python-dateutil': {
    license: 'Apache-2.0 OR BSD-3-Clause',
    source: 'https://github.com/dateutil/dateutil',
  },
  'python-docx': { license: 'MIT', source: 'https://github.com/python-openxml/python-docx' },
  'python-pptx': { license: 'MIT', source: 'https://github.com/scanny/python-pptx' },
}

const NATIVE_COMPONENTS = [
  {
    name: 'Bun runtime',
    license: 'MIT and bundled third-party licenses',
    source: 'https://github.com/oven-sh/bun',
    note: 'The server and desktop artifacts bundle a platform-specific Bun runtime.',
  },
  {
    name: 'uv runtime',
    license: 'Apache-2.0 OR MIT',
    source: 'https://github.com/astral-sh/uv',
    note: 'The document tools use the platform-specific uv binary to resolve PEP 723 packages.',
  },
  {
    name: 'Electron and Chromium',
    license: 'MIT, BSD-3-Clause, and other upstream licenses',
    source: 'https://github.com/electron/electron',
    note: 'Electron release files retain the upstream Chromium/Electron license notices.',
  },
]

const readJson = (path: string): JsonObject =>
  JSON.parse(readFileSync(path, 'utf8')) as JsonObject

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const dependencyNames = (pkg: JsonObject): string[] => {
  const names = new Set<string>()
  for (const field of ['dependencies', 'optionalDependencies']) {
    const dependencies = pkg[field]
    if (!dependencies || typeof dependencies !== 'object') continue
    for (const [name, range] of Object.entries(dependencies as JsonObject)) {
      if (typeof range === 'string' && range.startsWith('workspace:')) continue
      names.add(name)
    }
  }
  return [...names].sort()
}

const packageSource = (pkg: JsonObject, name: string): string => {
  const repository = pkg.repository
  if (typeof repository === 'string' && repository.trim()) {
    return repository.replace(/^git\+/, '').replace(/\.git$/, '')
  }
  if (repository && typeof repository === 'object') {
    const url = asString((repository as JsonObject).url)
    if (url) return url.replace(/^git\+/, '').replace(/\.git$/, '')
  }
  return asString(pkg.homepage) ?? `https://www.npmjs.com/package/${encodeURIComponent(name)}`
}

const packageLicense = (pkg: JsonObject): string => {
  const license = pkg.license ?? pkg.licenseExpression
  if (typeof license === 'string' && license.trim()) return license.trim()
  if (Array.isArray(license)) {
    const values = license
      .map((value) => (typeof value === 'string' ? value : value && typeof value === 'object' ? (value as JsonObject).type : undefined))
      .filter((value): value is string => Boolean(value))
    if (values.length) return values.join(' OR ')
  }
  if (license && typeof license === 'object') {
    const type = asString((license as JsonObject).type)
    if (type) return type
  }
  return 'License metadata not declared; see package license files'
}

const packageCandidates = (name: string, fromDir: string): string[] => {
  const candidates: string[] = []
  let current = fromDir
  while (true) {
    candidates.push(join(current, 'node_modules', name))
    const parent = resolve(current, '..')
    if (parent === current) break
    current = parent
  }
  return candidates
}

const resolvePackage = (name: string, fromDir: string): string | undefined => {
  for (const candidate of packageCandidates(name, fromDir)) {
    if (existsSync(join(candidate, PACKAGE_JSON))) return candidate
  }
  return undefined
}

const isPlatformPackageName = (name: string): boolean => {
  const lower = name.toLowerCase()
  return lower.endsWith('.exe') || [...PLATFORM_PACKAGES].some((platform) =>
    lower.includes(`-${platform}-`) || lower.endsWith(`-${platform}`),
  ) || /-(?:arm|arm64|x64|ia32|ppc64|riscv64|s390x|wasm32)(?:-|$)/.test(lower)
}

const isPlatformPackage = (pkg: JsonObject): boolean =>
  Array.isArray(pkg.os) || Array.isArray(pkg.cpu) ||
  (typeof pkg.name === 'string' && isPlatformPackageName(pkg.name))

const packageLicenseFiles = (packageRoot: string, packageName: string): LicenseFile[] => {
  if (!existsSync(packageRoot)) return []
  return readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => ({
      actualPath: relative(ROOT, join(packageRoot, entry.name)).replaceAll('\\', '/'),
      // Bun's hoisting layout differs between platforms and versions. Keep the
      // installed path for reading, but render a stable logical path so the
      // checked-in inventory is reproducible in CI and release environments.
      displayPath: join('node_modules', packageName, entry.name).replaceAll('\\', '/'),
    }))
    .sort((a, b) => a.displayPath.localeCompare(b.displayPath))
}

const workspaceManifestPaths = (): string[] => {
  const paths = [join(ROOT, PACKAGE_JSON)]
  for (const workspaceRoot of ['packages', 'apps']) {
    const directory = join(ROOT, workspaceRoot)
    if (!existsSync(directory)) continue
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'online-docs') continue
      const manifest = join(directory, entry.name, PACKAGE_JSON)
      if (existsSync(manifest)) paths.push(manifest)
    }
  }
  return paths.sort()
}

const collectPackages = (): { packages: PackageRecord[]; unresolved: string[] } => {
  const queue = workspaceManifestPaths().flatMap((manifest) => {
    const pkg = readJson(manifest)
    return dependencyNames(pkg).map((name) => ({ name, fromDir: resolve(manifest, '..') }))
  })
  const visited = new Set<string>()
  const packages = new Map<string, PackageRecord>()
  const unresolved = new Set<string>()

  while (queue.length) {
    const item = queue.shift()!
    if (item.name.startsWith('@kata-sh/')) continue
    if (isPlatformPackageName(item.name)) continue
    const packageRoot = resolvePackage(item.name, item.fromDir)
    if (!packageRoot) {
      unresolved.add(item.name)
      continue
    }

    let packageJson: JsonObject
    try {
      packageJson = readJson(join(packageRoot, PACKAGE_JSON))
    } catch {
      unresolved.add(`${item.name} (invalid package.json)`)
      continue
    }

    if (isPlatformPackage(packageJson)) continue
    const realRoot = (() => {
      try {
        return realpathSync(packageRoot)
      } catch {
        return packageRoot
      }
    })()
    if (visited.has(realRoot)) continue
    visited.add(realRoot)

    const name = asString(packageJson.name) ?? item.name
    const version = asString(packageJson.version) ?? 'unknown'
    const record: PackageRecord = {
      name,
      version,
      license: packageLicense(packageJson),
      source: packageSource(packageJson, name),
      licenseFiles: packageLicenseFiles(packageRoot, name),
      packageRoot,
    }
    packages.set(`${name}@${version}`, record)

    for (const dependency of dependencyNames(packageJson)) {
      queue.push({ name: dependency, fromDir: packageRoot })
    }
  }

  return {
    packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)),
    unresolved: [...unresolved].sort(),
  }
}

const collectPythonPackages = (): PythonRecord[] => {
  const directory = join(ROOT, 'apps', 'electron', 'resources', 'scripts')
  const records = new Map<string, PythonRecord>()
  if (!existsSync(directory)) return []

  // readdir order is filesystem-dependent (APFS returns hash order, ext4
  // returns alphabetical). Later files overwrite shared package constraints
  // below, so sort first to keep the inventory reproducible in CI.
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.py')) continue
    const text = readFileSync(join(directory, entry.name), 'utf8')
    const markerStart = text.indexOf('# ///')
    const markerEnd = markerStart < 0 ? -1 : text.indexOf('# ///', markerStart + 6)
    const header = markerStart >= 0 && markerEnd > markerStart
      ? text.slice(markerStart, markerEnd)
      : ''
    const matches = header.matchAll(/["']([^"']+)["']/g)
    for (const match of matches) {
      const raw = match[1]!.trim()
      if (raw.startsWith('>') || raw.startsWith('=')) continue
      const nameMatch = raw.match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\[[^\]]+\])?(.*)$/)
      if (!nameMatch) continue
      const name = nameMatch[1]!
      const constraint = nameMatch[2] || '*'
      const metadata = PYTHON_LICENSES[name.toLowerCase()]
      if (!metadata) continue
      records.set(name.toLowerCase(), { name, constraint, ...metadata })
    }
  }

  return [...records.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const collectThemes = (): Array<{ name: string; author: string; license: string; source: string; path: string }> => {
  const directory = join(ROOT, 'apps', 'electron', 'resources', 'themes')
  const themes: Array<{ name: string; author: string; license: string; source: string; path: string }> = []
  if (!existsSync(directory)) return themes
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const theme = readJson(join(directory, entry.name))
    themes.push({
      name: asString(theme.name) ?? entry.name,
      author: asString(theme.author) ?? 'Not specified',
      license: asString(theme.license) ?? 'Not specified',
      source: asString(theme.source) ?? 'Bundled Kata Agents theme',
      path: relative(ROOT, join(directory, entry.name)).replaceAll('\\', '/'),
    })
  }
  return themes.sort((a, b) => a.name.localeCompare(b.name))
}

const collectLicenseTexts = (packages: PackageRecord[]): Map<string, LicenseText> => {
  const texts = new Map<string, LicenseText>()
  for (const pkg of packages) {
    for (const licenseFile of pkg.licenseFiles) {
      const absolute = join(ROOT, licenseFile.actualPath)
      let text: string
      try {
        if (statSync(absolute).size > 64 * 1024) continue
        text = readFileSync(absolute, 'utf8').trim()
      } catch {
        continue
      }
      if (!text || text.includes('\u0000')) continue
      const hash = createHash('sha256').update(text).digest('hex')
      const existing = texts.get(hash)
      if (existing) {
        existing.packages.push(`${pkg.name}@${pkg.version}`)
      } else {
        texts.set(hash, { packages: [`${pkg.name}@${pkg.version}`], path: licenseFile.displayPath, text })
      }
    }
  }
  for (const value of texts.values()) value.packages.sort()
  return new Map([...texts.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}

const markdownCell = (value: string): string => value.replaceAll('|', '\\|').replaceAll('\n', ' ')

const render = (): string => {
  const { packages, unresolved } = collectPackages()
  const pythonPackages = collectPythonPackages()
  const themes = collectThemes()
  const licenseTexts = collectLicenseTexts(packages)
  const generatedAt = 'generated from the checked-in manifests and bundled assets'

  const lines: string[] = [
    '# Third-Party Notices',
    '',
    `> This file is ${generatedAt}. Do not edit it by hand; run \`bun run licenses:generate\` after changing dependencies or bundled assets.`,
    '>',
    '> It is an attribution and license inventory, not a replacement for the license terms of any component. The packaged desktop and server artifacts include this file at their top level. Where a dependency provides a license file, its text is reproduced below when practical; otherwise the source package remains authoritative.',
    '>',
    '> License-file paths are normalized to each package\'s logical `node_modules` location so this inventory remains stable across dependency hoisting layouts.',
    '',
    '## Upstream project and fork',
    '',
    '- **Craft Agents** — Copyright 2026 Craft Docs Ltd.; Apache-2.0. The upstream attribution and Anthropic terms are preserved verbatim in [`NOTICE`](NOTICE).',
    '- **Kata Agents modifications** — Copyright 2026 Gannon Hall; distributed under the Apache License, Version 2.0 unless a file states otherwise.',
    '',
    '## Components with separate terms',
    '',
    '- **Claude Agent SDK** — subject to Anthropic\'s Commercial Terms of Service, not the Apache-2.0 license: https://www.anthropic.com/legal/commercial-terms',
    '- **ShellGuard security corpus** — Apache-2.0; test cases in `packages/shared/tests/shellguard-corpus.test.ts` were adapted from https://github.com/jonchun/shellguard and its security-pipeline test corpus.',
    '',
    '## JavaScript and TypeScript runtime dependencies',
    '',
    '| Package | Version | License | Source | License files found |',
    '| --- | --- | --- | --- | --- |',
  ]

  for (const pkg of packages) {
    lines.push(`| \`${markdownCell(pkg.name)}\` | \`${markdownCell(pkg.version)}\` | ${markdownCell(pkg.license)} | ${markdownCell(pkg.source)} | ${pkg.licenseFiles.length ? pkg.licenseFiles.map((file) => `\`${file.displayPath}\``).join(', ') : 'Not present in package'} |`)
  }

  lines.push('', '## Python/PyPI dependencies used by bundled tools', '', '| Package | Requested range | License | Source |', '| --- | --- | --- | --- |')
  for (const pkg of pythonPackages) {
    lines.push(`| \`${pkg.name}\` | \`${markdownCell(pkg.constraint)}\` | ${markdownCell(pkg.license)} | ${markdownCell(pkg.source)} |`)
  }
  lines.push('', 'The Python tools use PEP 723 metadata and resolve these packages through uv at runtime. Their wheel/sdist license files remain authoritative for the resolved version.', '')

  lines.push('## Bundled runtimes and assets', '', '| Component | License / terms | Source | Notes |', '| --- | --- | --- | --- |')
  for (const component of NATIVE_COMPONENTS) {
    lines.push(`| ${component.name} | ${markdownCell(component.license)} | ${component.source} | ${markdownCell(component.note)} |`)
  }
  lines.push('', '### Bundled themes', '', '| Theme | Author | License | Source | Asset |', '| --- | --- | --- | --- | --- |')
  for (const theme of themes) {
    lines.push(`| ${markdownCell(theme.name)} | ${markdownCell(theme.author)} | ${markdownCell(theme.license)} | ${markdownCell(theme.source)} | \`${theme.path}\` |`)
  }
  lines.push('', '### Bundled tool-identification artwork', '', 'The files under `apps/electron/resources/tool-icons/` identify the command or service named in `tool-icons.json`. They are not software dependencies: each project or provider retains its own trademark and artwork rights. They are used only as command-identifying UI artwork, and no trademark license beyond that use is claimed by Kata Agents.', '', '- The inventory of icon filenames and displayed project names is maintained in `apps/electron/resources/tool-icons/tool-icons.json`.', '- The Kata Agent icon is project artwork owned by Kata Agents.', '- For third-party marks, consult the named project/provider\'s official brand or source repository before reusing the artwork outside this product.', '')

  if (unresolved.length) {
    lines.push('## Dependency resolution notes', '', 'The following declared runtime dependency names were not present in the local install used to generate this file. A release build must install the frozen lockfile before regeneration; these entries are intentionally surfaced instead of silently omitted.', '')
    for (const name of unresolved) lines.push(`- \`${name}\``)
    lines.push('')
  }

  lines.push('## Embedded license texts', '', 'The following texts are deduplicated from license/notice files found in the installed runtime dependency graph. The package inventory above remains the source of the package-to-license mapping.', '')
  for (const [hash, value] of licenseTexts) {
    lines.push(`### License text \`${hash.slice(0, 12)}\``, '', `Applies to: ${value.packages.map((pkg) => `\`${pkg}\``).join(', ')}`, '', `Source file: \`${value.path}\``, '')
    for (const line of value.text.split('\n')) lines.push(`    ${line}`)
    lines.push('')
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

const main = (): void => {
  const content = render()
  if (process.argv.includes('--check')) {
    if (!existsSync(OUTPUT) || readFileSync(OUTPUT, 'utf8') !== content) {
      console.error(`${OUTPUT} is stale. Run: bun run licenses:generate`)
      process.exit(1)
    }
    console.log('Third-party notices are up to date.')
    return
  }
  writeFileSync(OUTPUT, content)
  console.log(`Generated ${relative(ROOT, OUTPUT)} (${content.length} bytes).`)
}

if (import.meta.main) main()
