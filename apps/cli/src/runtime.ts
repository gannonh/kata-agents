import { resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

/**
 * True when this module is the executed entry point (not imported by a test).
 * Portable across Bun and plain Node, and across the ESM source and the CJS
 * published bundle (which has `__filename` instead of `import.meta.url`).
 */
export function isMainModule(): boolean {
  try {
    const launched = process.argv[1]
    if (!launched) return false
    const launchedPath = resolve(launched)
    // CJS bundle (esbuild provides __filename); ESM source uses import.meta.url
    // @ts-expect-error - __filename only exists in the CJS bundle
    if (typeof __filename !== 'undefined') {
      return launchedPath === resolve(__filename)
    }
    return launchedPath === resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

/**
 * Read all of stdin as a string. Works under Bun and Node (process.stdin is a
 * readable stream in both).
 */
export async function readStdin(timeoutMs = 30_000): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    const cleanup = () => {
      clearTimeout(timer)
      process.stdin.off('data', onData)
      process.stdin.off('end', finish)
      process.stdin.off('close', finish)
      process.stdin.off('error', onError)
      process.stdin.pause()
    }
    const finish = () => {
      cleanup()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const onData = (chunk: Buffer) => chunks.push(chunk)
    const onError = (err: Error) => {
      cleanup()
      if (chunks.length > 0) {
        resolve(Buffer.concat(chunks).toString('utf8'))
      } else {
        reject(err)
      }
    }
    const timer = setTimeout(() => {
      cleanup()
      if (chunks.length > 0) {
        resolve(Buffer.concat(chunks).toString('utf8'))
      } else {
        reject(new Error('Timed out reading stdin'))
      }
    }, timeoutMs)
    process.stdin.on('data', onData)
    process.stdin.on('end', finish)
    process.stdin.on('close', finish)
    process.stdin.on('error', onError)
    process.stdin.resume()
  })
}
