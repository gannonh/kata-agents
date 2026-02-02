/**
 * Tests for user preferences management
 *
 * These tests verify:
 * - MessageDisplayPreferences interface behavior
 * - Nested object merging in updatePreferences
 * - Default values and edge cases
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We need to mock the CONFIG_DIR before importing preferences
// Create a temp directory for test isolation
const TEST_CONFIG_DIR = join(tmpdir(), `kata-test-${Date.now()}`);

// Mock the paths module
import { mock } from 'bun:test';

// Store original env
const originalEnv = process.env.KATA_CONFIG_DIR;

beforeEach(() => {
  // Set up test config directory
  process.env.KATA_CONFIG_DIR = TEST_CONFIG_DIR;
  if (!existsSync(TEST_CONFIG_DIR)) {
    mkdirSync(TEST_CONFIG_DIR, { recursive: true });
  }
});

afterEach(() => {
  // Clean up test directory
  if (existsSync(TEST_CONFIG_DIR)) {
    rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  }
  // Restore original env
  if (originalEnv) {
    process.env.KATA_CONFIG_DIR = originalEnv;
  } else {
    delete process.env.KATA_CONFIG_DIR;
  }
});

// ============================================================================
// MessageDisplayPreferences Type Tests
// ============================================================================

describe('MessageDisplayPreferences', () => {
  it('should allow expandContent to be true', () => {
    const prefs = { expandContent: true };
    expect(prefs.expandContent).toBe(true);
  });

  it('should allow expandContent to be false', () => {
    const prefs = { expandContent: false };
    expect(prefs.expandContent).toBe(false);
  });

  it('should allow expandContent to be undefined', () => {
    const prefs: { expandContent?: boolean } = {};
    expect(prefs.expandContent).toBeUndefined();
  });
});

// ============================================================================
// updatePreferences Merging Tests
// ============================================================================

describe('updatePreferences messageDisplay merging', () => {
  // Import fresh for each test to avoid state issues
  const getPreferencesModule = async () => {
    // Dynamic import to get fresh module
    const mod = await import('../preferences.ts');
    return mod;
  };

  it('should set messageDisplay when none exists', async () => {
    const { updatePreferences, loadPreferences } = await getPreferencesModule();

    // Verify initial state is empty
    const initial = loadPreferences();
    expect(initial.messageDisplay).toBeUndefined();

    // Update with messageDisplay
    const result = updatePreferences({
      messageDisplay: { expandContent: true },
    });

    expect(result.messageDisplay).toBeDefined();
    expect(result.messageDisplay?.expandContent).toBe(true);
  });

  it('should merge messageDisplay with existing preferences', async () => {
    const { updatePreferences, loadPreferences, savePreferences } = await getPreferencesModule();

    // Set up existing preferences
    savePreferences({
      name: 'Test User',
      messageDisplay: { expandContent: false },
    });

    // Update only expandContent
    const result = updatePreferences({
      messageDisplay: { expandContent: true },
    });

    // Should preserve name and update expandContent
    expect(result.name).toBe('Test User');
    expect(result.messageDisplay?.expandContent).toBe(true);
  });

  it('should preserve messageDisplay when updating other fields', async () => {
    const { updatePreferences, savePreferences } = await getPreferencesModule();

    // Set up existing preferences with messageDisplay
    savePreferences({
      messageDisplay: { expandContent: true },
    });

    // Update a different field
    const result = updatePreferences({
      name: 'New Name',
    });

    // messageDisplay should be preserved
    expect(result.name).toBe('New Name');
    expect(result.messageDisplay?.expandContent).toBe(true);
  });

  it('should handle messageDisplay with expandContent false', async () => {
    const { updatePreferences } = await getPreferencesModule();

    const result = updatePreferences({
      messageDisplay: { expandContent: false },
    });

    expect(result.messageDisplay?.expandContent).toBe(false);
  });

  it('should merge diffViewer and messageDisplay independently', async () => {
    const { updatePreferences, savePreferences } = await getPreferencesModule();

    // Set up both preferences
    savePreferences({
      diffViewer: { diffStyle: 'split' },
      messageDisplay: { expandContent: true },
    });

    // Update only diffViewer
    const result = updatePreferences({
      diffViewer: { disableBackground: true },
    });

    // Both should be preserved with merge
    expect(result.diffViewer?.diffStyle).toBe('split');
    expect(result.diffViewer?.disableBackground).toBe(true);
    expect(result.messageDisplay?.expandContent).toBe(true);
  });
});

// ============================================================================
// Default Value Behavior Tests
// ============================================================================

describe('messageDisplay default behavior', () => {
  it('should treat undefined expandContent as expanded (true) in UI', () => {
    // This test documents the expected UI behavior:
    // When expandContent is undefined, UI should default to expanded (true)
    const prefs: { expandContent?: boolean } = {};

    // UI logic: expandContent ?? true (default to expanded)
    const effectiveExpandContent = prefs.expandContent ?? true;
    expect(effectiveExpandContent).toBe(true);
  });

  it('should respect explicit false value', () => {
    const prefs = { expandContent: false };

    // UI logic should not override explicit false
    const effectiveExpandContent = prefs.expandContent ?? true;
    expect(effectiveExpandContent).toBe(false);
  });

  it('should respect explicit true value', () => {
    const prefs = { expandContent: true };

    const effectiveExpandContent = prefs.expandContent ?? true;
    expect(effectiveExpandContent).toBe(true);
  });
});
