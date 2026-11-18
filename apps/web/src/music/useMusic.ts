import { useSyncExternalStore } from 'react'
import { type MusicState, music } from './player'

/** The background music's state, kept current. */
export function useMusic(): MusicState {
  const player = music()
  return useSyncExternalStore(player.subscribe, player.getState, player.getState)
}
