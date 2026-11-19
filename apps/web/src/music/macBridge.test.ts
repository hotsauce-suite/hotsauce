import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectMacMusic, MAC_MUSIC_HANDLER, runMacMusicCommand } from './macBridge'
import { type AudioLike, createMusicPlayer, type MusicPlayer } from './player'

// The music in the Mac app (docs/PLAN-background-music.md, M9 to M11).

function player(): MusicPlayer {
  const audio: AudioLike = {
    src: '',
    loop: false,
    volume: 1,
    preload: '',
    paused: true,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
  }
  return createMusicPlayer({
    storage: null,
    createAudio: () => audio,
    mediaDevices: null,
    events: null,
    setTimer: (fn) => {
      fn()
      return 0
    },
    clearTimer: () => {},
  })
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

type W = {
  webkit?: unknown
  hotsauceMusic?: { command(c: unknown): boolean; hold(r: unknown, on: unknown): void }
}

afterEach(() => {
  delete (window as W).webkit
  delete (window as W).hotsauceMusic
})

describe('the music in the Mac app', () => {
  it('M9: does nothing outside the Mac app', () => {
    const off = connectMacMusic(player())
    expect((window as W).hotsauceMusic).toBeUndefined()
    off()
  })

  it('M9: the app plays, pauses and picks a track, and hears every change', async () => {
    const posted: unknown[] = []
    ;(window as W).webkit = {
      messageHandlers: { [MAC_MUSIC_HANDLER]: { postMessage: (m: unknown) => posted.push(m) } },
    }
    const p = player()
    const off = connectMacMusic(p)
    expect(posted.at(-1)).toMatchObject({ on: false, playing: false, track: 'piano' })
    expect((posted.at(-1) as { tracks: unknown[] }).tracks).toHaveLength(4)

    const bridge = (window as W).hotsauceMusic
    expect(bridge?.command('toggle')).toBe(true)
    await settle()
    expect(posted.at(-1)).toMatchObject({ on: true, playing: true })

    expect(bridge?.command('track:rain')).toBe(true)
    await settle()
    expect(posted.at(-1)).toMatchObject({ track: 'rain', on: true })

    expect(bridge?.command('stop')).toBe(true)
    await settle()
    expect(posted.at(-1)).toMatchObject({ on: false, playing: false })

    // A track picked while off turns it on.
    bridge?.command('track:lofi')
    await settle()
    expect(posted.at(-1)).toMatchObject({ track: 'lofi', on: true, playing: true })

    off()
    expect((window as W).hotsauceMusic).toBeUndefined()
  })

  it('M9: refuses commands and tracks it does not know', () => {
    const p = player()
    expect(runMacMusicCommand(p, 'louder')).toBe(false)
    expect(runMacMusicCommand(p, 'track:metal')).toBe(false)
    expect(runMacMusicCommand(p, 42)).toBe(false)
    expect(p.getState().on).toBe(false)
  })

  it('M10: the app holds the music while it dictates or records a call', async () => {
    ;(window as W).webkit = { messageHandlers: { [MAC_MUSIC_HANDLER]: { postMessage: () => {} } } }
    const p = player()
    const off = connectMacMusic(p)
    const bridge = (window as W).hotsauceMusic
    bridge?.command('play')
    await settle()
    bridge?.hold('dictate', true)
    expect(p.getState()).toMatchObject({ held: true, playing: false })
    bridge?.hold('meeting', true)
    bridge?.hold('dictate', false)
    await settle()
    expect(p.getState()).toMatchObject({ held: true, playing: false })
    bridge?.hold('meeting', false)
    await settle()
    expect(p.getState()).toMatchObject({ held: false, playing: true })
    // Anything else is ignored.
    bridge?.hold('party', true)
    bridge?.hold('dictate', 'yes')
    expect(p.getState().held).toBe(false)
    off()
  })

  it('M11: opened quietly (at login), it stays silent until asked', async () => {
    const p = createMusicPlayer({
      storage: {
        getItem: () => JSON.stringify({ on: true, track: 'piano', volume: 0.3, asked: true }),
        setItem: () => {},
      },
      createAudio: () => {
        throw new Error('no audio until asked')
      },
      mediaDevices: null,
      events: new EventTarget(),
      setTimer: () => 0,
      clearTimer: () => {},
    })
    p.start()
    await settle()
    expect(p.getState()).toMatchObject({ on: true, playing: false, waiting: true })
  })
})
