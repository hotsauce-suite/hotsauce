// The background music in the Mac app (docs/PLAN-background-music.md, M9 to M11). The app's
// window shows this page, so the page keeps the one player; the app drives it from its menu bar
// and its Music menu, and holds it while the app itself dictates or records a call (recordings
// the page never sees). The page tells the app what the player is doing, for the menus' labels.

import type { MusicPlayer, MusicState } from './player'
import { TRACKS } from './tracks'

/** What the app may ask (apps/dictate-mac MusicBridge.swift). */
export type MacMusicCommand = 'toggle' | 'play' | 'stop' | `track:${string}`

/** What the page tells the app on every change: enough for its menus, nothing else. */
export interface MacMusicState {
  on: boolean
  playing: boolean
  held: boolean
  /** On, but silent until the member clicks or asks: the menus offer Play. */
  waiting: boolean
  track: string
  tracks: { id: string; label: string }[]
}

export const MAC_MUSIC_HANDLER = 'hotsauceMusic'

interface Handler {
  postMessage(message: unknown): unknown
}

function macHandler(): Handler | undefined {
  return (window as { webkit?: { messageHandlers?: Record<string, Handler> } }).webkit
    ?.messageHandlers?.[MAC_MUSIC_HANDLER]
}

export function macMusicState(s: MusicState): MacMusicState {
  return {
    on: s.on,
    playing: s.playing,
    held: s.held,
    waiting: s.waiting,
    track: s.track,
    tracks: TRACKS.map((t) => ({ id: t.id, label: t.label })),
  }
}

/** Runs one of the app's commands; false for one it doesn't know. */
export function runMacMusicCommand(player: MusicPlayer, command: unknown): boolean {
  const { on, playing, waiting } = player.getState()
  // On but silent, waiting for a click: the menu shows Play, so Play it is.
  if (command === 'toggle') {
    if (on && waiting && !playing) player.play()
    else player.toggle()
  } else if (command === 'play') player.play()
  else if (command === 'stop') player.stop()
  else if (typeof command === 'string' && command.startsWith('track:')) {
    const id = command.slice('track:'.length)
    if (!TRACKS.some((t) => t.id === id)) return false
    player.setTrack(id)
    // Picking a track asks for music: off, or waiting for a click, it starts.
    if (!on || waiting) player.play()
  } else return false
  return true
}

/**
 * Inside the Mac app (its `hotsauceMusic` handler is there): gives the app `window.hotsauceMusic`
 * to call, and posts the player's state to it now and on every change. Elsewhere, does nothing.
 */
export function connectMacMusic(player: MusicPlayer): () => void {
  const handler = macHandler()
  if (!handler) return () => {}
  const w = window as { hotsauceMusic?: unknown }
  w.hotsauceMusic = Object.freeze({
    command: (c: unknown) => runMacMusicCommand(player, c),
    hold: (reason: unknown, on: unknown) => {
      if ((reason === 'dictate' || reason === 'meeting') && typeof on === 'boolean')
        player.holdFor(reason, on)
    },
  })
  let last = ''
  const post = () => {
    const state = macMusicState(player.getState())
    const text = JSON.stringify(state)
    if (text === last) return
    last = text
    try {
      handler.postMessage(state)
    } catch {
      // An app too old for the handler's reply: the menus just don't update.
    }
  }
  post()
  const off = player.subscribe(post)
  return () => {
    off()
    delete w.hotsauceMusic
  }
}
