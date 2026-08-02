import { useCallback, useEffect, useState } from 'react'

const TOOL_ACTIVITY_EXPANSION_CHANGED_EVENT = 'kata:tool-activity-expansion-changed'

/**
 * Reads and updates the app-wide default for tool activity expansion.
 * The custom event keeps mounted chat views in the same renderer in sync
 * when the setting changes from Appearance settings.
 */
export function useToolActivityExpansion() {
  const [expandToolActivityByDefault, setExpandToolActivityByDefaultState] = useState(false)

  useEffect(() => {
    let cancelled = false

    const handleChange = (event: Event) => {
      const next = (event as CustomEvent<boolean>).detail
      if (typeof next === 'boolean') {
        setExpandToolActivityByDefaultState(next)
      }
    }

    window.addEventListener(TOOL_ACTIVITY_EXPANSION_CHANGED_EVENT, handleChange)

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
      window.removeEventListener(TOOL_ACTIVITY_EXPANSION_CHANGED_EVENT, handleChange)
    }
  }, [])

  const setExpandToolActivityByDefault = useCallback(async (enabled: boolean) => {
    setExpandToolActivityByDefaultState(enabled)

    try {
      await window.electronAPI?.setExpandToolActivityByDefault(enabled)
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
