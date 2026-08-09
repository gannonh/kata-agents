/**
 * Source development bypasses Electron's lock so E2E/dev launches can coexist
 * with an installed app. Packaged builds, including packaged development
 * builds, retain a lock; packaged development gets an isolated userData path
 * before this policy is evaluated.
 */
export function shouldAcquireSingleInstanceLock(
  isPackaged: boolean,
  _isDevRuntime: boolean,
): boolean {
  return isPackaged
}

export function findDeepLinkArg(commandLine: readonly string[], scheme: string): string | undefined {
  return commandLine.find(arg => arg.startsWith(`${scheme}://`))
}
