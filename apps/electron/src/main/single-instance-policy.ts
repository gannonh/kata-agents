/**
 * Development runtimes must be able to run alongside an installed app.
 * Packaged production/nightly builds retain Electron's single-instance lock.
 */
export function shouldAcquireSingleInstanceLock(
  isPackaged: boolean,
  isDevRuntime: boolean,
): boolean {
  return isPackaged && !isDevRuntime
}
