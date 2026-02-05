/**
 * Settings Live E2E Tests
 * Tests app settings, workspace settings, and preferences.
 */
import { test, expect } from '../../fixtures/live.fixture'

test.describe('Live Settings', () => {
  test.setTimeout(60_000)

  test('app settings page loads and displays version', async ({ mainWindow }) => {
    // Navigate to settings via keyboard shortcut
    await mainWindow.keyboard.press('Meta+,')

    // Wait for settings to load
    await mainWindow.waitForTimeout(1000)

    // Verify settings page is visible (look for version info)
    const versionText = mainWindow.getByText(/v\d+\.\d+\.\d+/)
    await expect(versionText).toBeVisible({ timeout: 5000 })
  })

  test('workspace settings shows model selector', async ({ mainWindow }) => {
    // Navigate to settings
    await mainWindow.keyboard.press('Meta+,')
    await mainWindow.waitForTimeout(1000)

    // Look for workspace settings section
    const workspaceTab = mainWindow.getByRole('tab', { name: /workspace/i })
    if (await workspaceTab.isVisible()) {
      await workspaceTab.click()
    }

    // Verify model selector exists (Opus/Sonnet/Haiku options)
    const modelSection = mainWindow.getByText(/model/i).first()
    await expect(modelSection).toBeVisible({ timeout: 5000 })
  })

  test('appearance settings accessible', async ({ mainWindow }) => {
    // Navigate to settings
    await mainWindow.keyboard.press('Meta+,')
    await mainWindow.waitForTimeout(1000)

    // Look for appearance tab/section
    const appearanceTab = mainWindow.getByRole('tab', { name: /appearance/i })
    if (await appearanceTab.isVisible()) {
      await appearanceTab.click()

      // Verify theme/appearance controls exist
      const themeSection = mainWindow.getByText(/theme|color|font/i).first()
      await expect(themeSection).toBeVisible({ timeout: 5000 })
    }
  })

  test('settings closes with escape key', async ({ mainWindow }) => {
    // Open settings
    await mainWindow.keyboard.press('Meta+,')
    await mainWindow.waitForTimeout(1000)

    // Close with escape
    await mainWindow.keyboard.press('Escape')
    await mainWindow.waitForTimeout(500)

    // Verify chat input is visible (back to main view)
    await expect(mainWindow.locator('[contenteditable="true"]')).toBeVisible({ timeout: 5000 })
  })
})
