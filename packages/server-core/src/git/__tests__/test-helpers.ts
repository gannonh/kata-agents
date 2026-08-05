import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit } from '../command-runner'

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Kata Test',
  GIT_AUTHOR_EMAIL: 'test@kata.sh',
  GIT_COMMITTER_NAME: 'Kata Test',
  GIT_COMMITTER_EMAIL: 'test@kata.sh',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

export function makeTmpDir(prefix = 'kata-git-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

/** Initialize a git repo at dir with an initial commit on branch `main`. */
export async function initRepo(dir: string): Promise<void> {
  await runGit(['init', '-b', 'main', dir], { cwd: process.cwd(), env: GIT_ENV })
  await runGit(['config', 'user.name', 'Kata Test'], { cwd: dir, env: GIT_ENV })
  await runGit(['config', 'user.email', 'test@kata.sh'], { cwd: dir, env: GIT_ENV })
  writeFileSync(join(dir, 'README.md'), '# test repo\n')
  await runGit(['add', '.'], { cwd: dir, env: GIT_ENV })
  await runGit(['commit', '-m', 'initial commit'], { cwd: dir, env: GIT_ENV })
}

export async function git(dir: string, args: string[]): Promise<string> {
  const res = await runGit(args, { cwd: dir, env: GIT_ENV })
  return res.stdout
}

export function writeFile(dir: string, relPath: string, content: string): void {
  const full = join(dir, relPath)
  const parts = relPath.split('/')
  if (parts.length > 1) {
    mkdirSync(join(dir, parts.slice(0, -1).join('/')), { recursive: true })
  }
  writeFileSync(full, content)
}

export { runGit }

export { GIT_ENV }
