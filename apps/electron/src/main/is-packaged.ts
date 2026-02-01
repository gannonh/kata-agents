/**
 * Reliable packaged app detection
 *
 * Electron's `app.isPackaged` can incorrectly return `false` when `asar: false`
 * is set in electron-builder config. This utility provides a more reliable check
 * by examining the executable path to determine if we're in a packaged app.
 *
 * Detection methods:
 * - macOS: Check if running from inside a .app bundle (path contains '.app/Contents/')
 * - Windows: Check if running from Program Files or AppData install locations
 * - Linux: Check if running from /usr, /opt, or AppImage mount point
 * - Fallback: Use Electron's app.isPackaged
 */

import { app } from 'electron'

/**
 * Returns true if the app is running as a packaged distribution,
 * false if running from source (development).
 *
 * More reliable than `app.isPackaged` when `asar: false` is set.
 */
export function isPackagedApp(): boolean {
  // First, trust app.isPackaged if it says true
  if (app.isPackaged) {
    return true
  }

  // app.isPackaged returned false - do additional checks
  const execPath = process.execPath.toLowerCase()
  const appPath = app.getAppPath().toLowerCase()

  // macOS: Check if inside a .app bundle
  if (process.platform === 'darwin') {
    if (execPath.includes('.app/contents/') || appPath.includes('.app/contents/')) {
      return true
    }
  }

  // Windows: Check common install locations
  if (process.platform === 'win32') {
    const isInProgramFiles = execPath.includes('program files') ||
                             execPath.includes('programfiles') ||
                             execPath.includes('appdata\\local\\programs')
    if (isInProgramFiles) {
      return true
    }
  }

  // Linux: Check common install locations and AppImage
  if (process.platform === 'linux') {
    const isInstalled = execPath.startsWith('/usr/') ||
                        execPath.startsWith('/opt/') ||
                        execPath.includes('/tmp/.mount_') || // AppImage mount point
                        process.env.APPIMAGE !== undefined
    if (isInstalled) {
      return true
    }
  }

  // Check if we're NOT in a node_modules directory (strong indicator of packaged app)
  // Development typically runs from within node_modules (electron binary)
  if (!execPath.includes('node_modules') && !appPath.includes('node_modules')) {
    // Additional check: make sure we're not just running `electron .` from project root
    // by checking if the app path looks like a real install location
    if (!appPath.includes('/dev/') && !appPath.includes('\\dev\\')) {
      return true
    }
  }

  // Fall back to Electron's detection
  return app.isPackaged
}

/**
 * Debug mode is enabled when running from source or with --debug flag.
 * Uses the reliable isPackagedApp() instead of app.isPackaged.
 */
export const isDebugMode = !isPackagedApp() || process.argv.includes('--debug')
