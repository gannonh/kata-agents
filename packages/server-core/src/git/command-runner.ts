/**
 * Git command runner.
 *
 * All Git invocations go through {@link runGit}, which uses `execFile` with an
 * explicit argument array — never a shell string — so paths, refs, and messages
 * cannot be interpreted by a shell. Each call defines a timeout, an output-size
 * limit, accepted exit codes, and maps failures to a structured
 * {@link GitCommandError}.
 */

import { execFile } from 'node:child_process'

export interface RunGitOptions {
  /** Working directory to run git in. */
  cwd: string
  /** Timeout in milliseconds. Default 15000. */
  timeoutMs?: number
  /** Max combined stdout+stderr bytes before the process is killed. Default 16 MiB. */
  maxBufferBytes?: number
  /**
   * Exit codes treated as success in addition to 0. Some porcelain commands use
   * non-zero for benign "nothing to do" outcomes.
   */
  okExitCodes?: number[]
  /** Extra environment variables merged over the inherited environment. */
  env?: Record<string, string | undefined>
  /** Feed this string to git's stdin (e.g. commit message via `-F -`). */
  input?: string
  /** Optional AbortSignal for cancellation. */
  signal?: AbortSignal
}

export interface GitCommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Structured, sanitized error for a failed Git command. The message never
 * includes the full environment; only the command, exit code, and trimmed
 * stderr are surfaced.
 */
export class GitCommandError extends Error {
  readonly code: string
  readonly exitCode: number | null
  readonly stderr: string
  readonly stdout: string
  readonly args: string[]

  constructor(params: {
    message: string
    code: string
    exitCode: number | null
    stderr: string
    stdout: string
    args: string[]
  }) {
    super(params.message)
    this.name = 'GitCommandError'
    this.code = params.code
    this.exitCode = params.exitCode
    this.stderr = params.stderr
    this.stdout = params.stdout
    this.args = params.args
  }
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024

function sanitizeStderr(stderr: string): string {
  // Keep stderr bounded and single-block; strip trailing whitespace.
  const trimmed = stderr.trim()
  if (trimmed.length <= 2000) return trimmed
  return `${trimmed.slice(0, 2000)}…`
}

/**
 * Run a git command with an argument array. Rejects with {@link GitCommandError}
 * on non-zero exit (unless the code is in `okExitCodes`), timeout, or spawn
 * failure (e.g. git not installed).
 */
export function runGit(args: string[], options: RunGitOptions): Promise<GitCommandResult> {
  const {
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBufferBytes = DEFAULT_MAX_BUFFER,
    okExitCodes = [],
    env,
    input,
    signal,
  } = options

  return new Promise<GitCommandResult>((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: maxBufferBytes,
        encoding: 'utf8',
        windowsHide: true,
        env: env ? { ...process.env, ...env } : process.env,
        signal,
      },
      (error, stdout, stderr) => {
        const stdoutStr = typeof stdout === 'string' ? stdout : String(stdout ?? '')
        const stderrStr = typeof stderr === 'string' ? stderr : String(stderr ?? '')

        if (!error) {
          resolve({ stdout: stdoutStr, stderr: stderrStr, exitCode: 0 })
          return
        }

        const err = error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean; signal?: string }

        // Spawn failure (git missing)
        if (err.code === 'ENOENT') {
          reject(
            new GitCommandError({
              message: 'Git executable not found. Install Git on the workspace-owning machine.',
              code: 'GIT_NOT_FOUND',
              exitCode: null,
              stderr: sanitizeStderr(stderrStr),
              stdout: stdoutStr,
              args,
            }),
          )
          return
        }

        // Timeout / killed
        if (err.killed || err.signal) {
          reject(
            new GitCommandError({
              message: `Git command timed out after ${timeoutMs}ms: git ${args[0] ?? ''}`,
              code: 'GIT_TIMEOUT',
              exitCode: null,
              stderr: sanitizeStderr(stderrStr),
              stdout: stdoutStr,
              args,
            }),
          )
          return
        }

        const exitCode = typeof err.code === 'number' ? err.code : 1
        if (okExitCodes.includes(exitCode)) {
          resolve({ stdout: stdoutStr, stderr: stderrStr, exitCode })
          return
        }

        reject(
          new GitCommandError({
            message: `git ${args[0] ?? ''} failed (exit ${exitCode})${stderrStr ? `: ${sanitizeStderr(stderrStr)}` : ''}`,
            code: 'GIT_COMMAND_FAILED',
            exitCode,
            stderr: sanitizeStderr(stderrStr),
            stdout: stdoutStr,
            args,
          }),
        )
      },
    )

    if (input !== undefined && child.stdin) {
      child.stdin.end(input)
    }
  })
}

/** Split NUL-delimited git output into non-empty records. */
export function splitNul(output: string): string[] {
  return output.split('\0').filter((s) => s.length > 0)
}
