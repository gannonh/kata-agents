import { useCallback, useEffect, useState } from 'react'

const TOOL_ACTIVITY_EXPANSION_CHANGED_EVENT = 'kata:tool-activity-expansion-changed'

/**
 * Reads and updates the app-wide default for tool activity expansion.
 * The Electron event keeps separate windows in sync, while the custom event
 * keeps mounted chat views in the same renderer compatible with playgrounds
 * and older preload bundles.
 */
export function useToolActivityExpansion() {
  const [expandToolActivityByDefault, setExpandToolActivityByDefaultState] = useState(false)

  useEffect(() => {
    let cancelled = false

    const applyChange = (next: unknown) => {
      if (typeof next === 'boolean') {
        setExpandToolActivityByDefaultState(next)
      }
    }

    const handleDomChange = (event: Event) => {
      applyChange((event as CustomEvent<boolean>).detail)
    }

    window.addEventListener(TOOL_ACTIVITY_EXPANSION_CHANGED_EVENT, handleDomChange)
    const unsubscribe = window.electronAPI?.onExpandToolActivityByDefaultChange?.(applyChange)

    const loadPreference = window.electronAPI?.getExpandToolActivityByDefault
    if (loadPreference) {
      void loadPreference()
        .then((enabled) => {
          if (!cancelled) {
            setExpandToolActivityByDefaultState(enabled)
          }
        })
        .catch((error) => {
          console.error('Failed to load tool activity expansion preference:', error)
        })
    }

    return () => {
      cancelled = true
      unsubscribe?.()
      window.removeEventListener(TOOL_ACTIVITY_EXPANSION_CHANGED_EVENT, handleDomChange)
    }
  }, [])

  const setExpandToolActivityByDefault = useCallback(async (enabled: boolean) => {
    try {
      // Update the local UI only after persistence succeeds so a rejected save
      // cannot leave the toggle showing a value that will be lost on reload.
      await window.electronAPI?.setExpandToolActivityByDefault(enabled)
      setExpandToolActivityByDefaultState(enabled)
      window.dispatchEvent(new CustomEvent(TOOL_ACTIVITY_EXPANSION_CHANGED_EVENT, { detail: enabled }))
    } catch (error) {
      console.error('Failed to save tool activity expansion preference:', error)
    }
  }, [])

  return {
    expandToolActivityByDefault,
    setExpandToolActivityByDefault,
  }
}
