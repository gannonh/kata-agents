/**
 * Stdout guard for JSONL subprocess mode.
 *
 * Mirrors @mariozechner/pi-coding-agent's output-guard (used by runRpcMode) so
 * Pi SDK subprocess output (e.g. npm install) is redirected to stderr instead
 * of corrupting the JSONL protocol on stdout.
 */

interface StdoutTakeoverState {
  rawStdoutWrite: typeof process.stdout.write;
  rawStderrWrite: typeof process.stderr.write;
  originalStdoutWrite: typeof process.stdout.write;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

export function takeOverStdout(): void {
  if (stdoutTakeoverState) return;

  const rawStdoutWrite = process.stdout.write.bind(process.stdout);
  const rawStderrWrite = process.stderr.write.bind(process.stderr);
  const originalStdoutWrite = process.stdout.write;

  process.stdout.write = ((chunk, encodingOrCallback, callback) => {
    if (typeof encodingOrCallback === 'function') {
      return rawStderrWrite(String(chunk), encodingOrCallback);
    }
    if (typeof encodingOrCallback === 'string') {
      return rawStderrWrite(String(chunk), encodingOrCallback, callback);
    }
    return rawStderrWrite(String(chunk), callback);
  }) as typeof process.stdout.write;

  stdoutTakeoverState = { rawStdoutWrite, rawStderrWrite, originalStdoutWrite };
}

export function writeRawStdout(text: string): void {
  if (stdoutTakeoverState) {
    stdoutTakeoverState.rawStdoutWrite(text);
    return;
  }
  process.stdout.write(text);
}
