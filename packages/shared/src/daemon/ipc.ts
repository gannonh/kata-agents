/**
 * JSON-Lines IPC Protocol
 *
 * Line-delimited JSON parser and formatter for stdin/stdout communication
 * between the Electron main process and the daemon subprocess.
 */

/**
 * Create a streaming line parser that buffers input and calls `onLine`
 * for each complete newline-terminated line. Handles partial chunks,
 * multi-line chunks, and empty lines.
 */
export function createLineParser(_onLine: (line: string) => void): (chunk: string) => void {
  throw new Error('Not implemented');
}

/**
 * Format a message as a newline-terminated JSON string for IPC transmission.
 */
export function formatMessage(_msg: unknown): string {
  throw new Error('Not implemented');
}
