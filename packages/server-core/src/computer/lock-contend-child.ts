import { acquireRuntimeLock } from './lock.ts'
import { ComputerAlreadyRunning } from './errors.ts'

const lockPath = process.argv[2]
if (!lockPath) {
  process.stderr.write('lock path required\n')
  process.exit(1)
}

try {
  const handle = acquireRuntimeLock(lockPath)
  await Bun.sleep(1_500)
  handle.release()
  process.exit(0)
} catch (error) {
  process.exit(error instanceof ComputerAlreadyRunning ? 2 : 1)
}
