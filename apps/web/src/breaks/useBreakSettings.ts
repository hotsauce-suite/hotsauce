import { useSyncExternalStore } from 'react'
import { type BreaksSettingsState, breakSettings, subscribeBreakSettings } from './settings'

/** The member's screen-break settings, kept current. */
export function useBreakSettings(): BreaksSettingsState {
  return useSyncExternalStore(subscribeBreakSettings, breakSettings, breakSettings)
}
