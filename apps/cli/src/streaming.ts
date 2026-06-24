import type { CliRpcClient } from './client.ts'
import type { CliArgs } from './args.ts'
import { readStdin } from './runtime.ts'
import { err } from './output.ts'

/**
 * Read prompt text from positional args + stdin.
 */
export async function readPrompt(words: string[], restArgs?: string[]): Promise<string> {
  let message = words.join(' ')

  const wantsStdin = restArgs?.includes('--stdin')
  const isTTY = typeof process.stdin.isTTY === 'boolean' ? process.stdin.isTTY : false
  if (wantsStdin || (!message && !isTTY)) {
    const stdinText = await readStdin()
    message = message ? `${message}\n${stdinText}` : stdinText
  }

  return message
}

/**
 * Subscribe to session events, send the message, stream output, wait for completion.
 */
export async function sendAndStream(
  client: CliRpcClient,
  sessionId: string,
  message: string,
  args: CliArgs,
): Promise<number> {
  let exitCode = 0
  let finished = false
  const streamJson = args.outputFormat === 'stream-json'

  const unsub = client.on('session:event', (event: unknown) => {
    const ev = event as { type: string; sessionId: string; [key: string]: unknown }
    if (ev.sessionId !== sessionId) return

    if (streamJson) {
      process.stdout.write(JSON.stringify(ev) + '\n')
    }

    switch (ev.type) {
      case 'text_delta':
        if (!streamJson) process.stdout.write(ev.delta as string)
        break
      case 'tool_start':
        if (!streamJson) process.stdout.write(`\n[tool: ${ev.toolName}${ev.toolIntent ? ` — ${ev.toolIntent}` : ''}]\n`)
        break
      case 'tool_result': {
        if (!streamJson) {
          const result = String(ev.result ?? '')
          if (result.length > 200) {
            process.stdout.write(`${result.slice(0, 200)}...\n`)
          } else if (result) {
            process.stdout.write(`${result}\n`)
          }
        }
        break
      }
      case 'error':
        if (!streamJson) err(String(ev.error))
        exitCode = 1
        finished = true
        break
      case 'complete':
        if (!streamJson) process.stdout.write('\n')
        finished = true
        break
      case 'interrupted':
        if (!streamJson) process.stdout.write('\n[interrupted]\n')
        exitCode = 130
        finished = true
        break
    }
  })

  await client.invoke('sessions:sendMessage', sessionId, message)

  const deadline = Date.now() + args.sendTimeout
  while (!finished && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }

  unsub()

  if (!finished) {
    err('Send timeout — no completion event received')
    exitCode = 1
  }

  return exitCode
}
