/**
 * Minimal extension → language token map for diff syntax highlighting.
 *
 * The renderer's ShikiDiffViewer performs its own detection, but attaching a
 * best-effort language token to the server-side diff DTO keeps the wire result
 * self-describing for non-Electron clients and tests.
 */

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  xml: 'xml',
  vue: 'vue',
  svelte: 'svelte',
}

export function detectDiffLanguage(path: string): string {
  const base = path.split('/').pop() ?? path
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : ''
  return EXTENSION_LANGUAGE[ext] ?? 'text'
}
