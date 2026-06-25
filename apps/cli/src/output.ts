// ANSI colors (disabled when NO_COLOR is set or stdout is not a TTY)

export const useColor = !process.env.NO_COLOR && process.stdout.isTTY !== false

export const c = {
  dim: (s: string) => useColor ? `\x1b[2m${s}\x1b[22m` : s,
  green: (s: string) => useColor ? `\x1b[32m${s}\x1b[39m` : s,
  red: (s: string) => useColor ? `\x1b[31m${s}\x1b[39m` : s,
  cyan: (s: string) => useColor ? `\x1b[36m${s}\x1b[39m` : s,
  bold: (s: string) => useColor ? `\x1b[1m${s}\x1b[22m` : s,
  yellow: (s: string) => useColor ? `\x1b[33m${s}\x1b[39m` : s,
  blue: (s: string) => useColor ? `\x1b[34m${s}\x1b[39m` : s,
}

export const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function out(data: unknown, jsonMode: boolean): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
  } else if (typeof data === 'string') {
    process.stdout.write(data + '\n')
  } else {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
  }
}

export function err(msg: string): void {
  process.stderr.write(`Error: ${msg}\n`)
}

export function createSpinner(text: string): { stop(): void } {
  let i = 0
  let stopped = false
  process.stdout.write(`${text} ${c.dim(spinnerFrames[i++ % spinnerFrames.length])}`)
  const timer = setInterval(() => {
    process.stdout.write(`\r\x1b[2K${text} ${c.dim(spinnerFrames[i++ % spinnerFrames.length])}`)
  }, 80)
  timer.unref()
  return {
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      process.stdout.write('\r\x1b[2K')
    },
  }
}
