import { describe, expect, it, vi } from 'vitest'
import {
  type AudioLike,
  createMusicPlayer,
  DEFAULT_PREFS,
  MUSIC_KEY,
  type PlayerDeps,
  readPrefs,
} from './player'

// Background music (docs/PLAN-background-music.md, M1 to M4).

class FakeAudio implements AudioLike {
  src = ''
  loop = false
  /** Like an iPhone: the page can't change the volume. */
  fixed = false
  private v = 1
  get volume() {
    return this.v
  }
  set volume(x: number) {
    if (!this.fixed) this.v = x
  }
  preload = ''
  paused = true
  /** The browser refuses to start sound until a click (after a reload). */
  blocked = false
  /** The next play() fails this way instead. */
  failWith: string | null = null
  play = vi.fn(async () => {
    if (this.failWith) {
      const name = this.failWith
      this.failWith = null
      throw new DOMException('failed', name)
    }
    if (this.blocked) throw new DOMException('needs a click', 'NotAllowedError')
    this.paused = false
  })
  pause = vi.fn(() => {
    this.paused = true
  })
}

class FakeTrack {
  readyState: 'live' | 'ended' = 'live'
  stop() {
    this.readyState = 'ended'
  }
}

function fakeStream() {
  const tracks = [new FakeTrack(), new FakeTrack()]
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, tracks }
}

function setup(stored?: unknown, opts: { fixed?: boolean } = {}) {
  const store = new Map<string, string>()
  if (stored !== undefined) store.set(MUSIC_KEY, JSON.stringify(stored))
  const audios: FakeAudio[] = []
  let blocked = false
  const timers: Array<() => void> = []
  const events = new EventTarget()
  const captured = fakeStream()
  const mediaDevices = {
    getUserMedia: vi.fn(async () => captured.stream),
  } as unknown as MediaDevices
  const deps: PlayerDeps = {
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    createAudio: () => {
      const a = new FakeAudio()
      a.blocked = blocked
      a.fixed = opts.fixed === true
      audios.push(a)
      return a
    },
    mediaDevices,
    events,
    setTimer: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearTimer: () => {},
  }
  const player = createMusicPlayer(deps)
  /** Runs every pending timer (fades, the recording check) until none are left. */
  const flushTimers = () => {
    for (let i = 0; i < 200 && timers.length > 0; i++) timers.shift()?.()
  }
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
    flushTimers()
  }
  return {
    player,
    store,
    audios,
    events,
    mediaDevices,
    captured,
    settle,
    flushTimers,
    block: (v: boolean) => {
      blocked = v
      for (const a of audios) a.blocked = v
    },
    saved: () => JSON.parse(store.get(MUSIC_KEY) ?? 'null'),
  }
}

describe('background music', () => {
  it('M1: is off by default and creates no audio until play', async () => {
    const t = setup()
    t.player.start()
    await t.settle()
    expect(t.player.getState()).toMatchObject({ on: false, playing: false, waiting: false })
    expect(t.audios).toHaveLength(0)
  })

  it('M2: plays, fades in to the chosen volume, pauses and remembers the choice', async () => {
    const t = setup()
    t.player.start()
    t.player.play()
    await t.settle()
    const a = t.audios[0] as FakeAudio
    expect(a.src).toBe('/music/soft-piano.mp3')
    expect(a.loop).toBe(true)
    expect(t.player.getState().playing).toBe(true)
    expect(a.volume).toBeCloseTo(DEFAULT_PREFS.volume)
    expect(t.saved()).toMatchObject({ on: true, asked: true })

    t.player.setVolume(0.8)
    expect(a.volume).toBeCloseTo(0.8)
    t.player.setTrack('rain')
    await t.settle()
    expect(a.src).toBe('/music/rain.mp3')
    expect(t.player.getState().playing).toBe(true)
    expect(t.saved()).toMatchObject({ track: 'rain', volume: 0.8 })

    t.player.stop()
    await t.settle()
    expect(a.paused).toBe(true)
    expect(t.player.getState()).toMatchObject({ on: false, playing: false })
    expect(t.saved().on).toBe(false)
  })

  it('M2: a bad stored value falls back to the defaults', () => {
    const store = (v: string) => ({ getItem: () => v, setItem: () => {} })
    expect(readPrefs(store('{nope'))).toEqual(DEFAULT_PREFS)
    expect(readPrefs(store(JSON.stringify({ on: 'yes', track: 'metal', volume: 9 })))).toEqual({
      ...DEFAULT_PREFS,
      volume: 1,
    })
    expect(readPrefs(null)).toEqual(DEFAULT_PREFS)
  })

  it('M3: left on, it waits for the first click after a reload, then plays', async () => {
    const t = setup({ on: true, track: 'lofi', volume: 0.5, asked: true })
    t.block(true)
    t.player.start()
    await t.settle()
    expect(t.audios).toHaveLength(0)
    expect(t.player.getState()).toMatchObject({ on: true, waiting: true, playing: false })

    // The click unblocks sound, as a browser does.
    t.block(false)
    t.events.dispatchEvent(new Event('pointerdown'))
    await t.settle()
    expect(t.audios[0]?.src).toBe('/music/lo-fi.mp3')
    expect(t.player.getState()).toMatchObject({ playing: true, waiting: false })
  })

  it('M3: a refused start waits instead of failing', async () => {
    const t = setup()
    t.block(true)
    t.player.start()
    t.player.play()
    await t.settle()
    expect(t.player.getState()).toMatchObject({ on: true, playing: false, waiting: true })
  })

  it('M4: holds while a capture is open and resumes when every track ends', async () => {
    const t = setup()
    t.player.start()
    t.player.play()
    await t.settle()
    const a = t.audios[0] as FakeAudio

    await t.mediaDevices.getUserMedia({ audio: true })
    await t.settle()
    expect(t.player.getState()).toMatchObject({ held: true, playing: false, on: true })
    expect(a.paused).toBe(true)

    // One track stopped is not the end of the recording.
    t.captured.tracks[0]?.stop()
    t.flushTimers()
    expect(t.player.getState().held).toBe(true)

    t.captured.tracks[1]?.stop()
    await t.settle()
    await t.settle()
    expect(t.player.getState()).toMatchObject({ held: false, playing: true })
    expect(a.paused).toBe(false)
  })

  it('M4: turned off during a recording, it stays off afterwards', async () => {
    const t = setup()
    t.player.start()
    t.player.play()
    await t.settle()
    await t.mediaDevices.getUserMedia({ audio: true })
    await t.settle()
    t.player.stop()
    for (const tr of t.captured.tracks) tr.stop()
    await t.settle()
    await t.settle()
    expect(t.player.getState()).toMatchObject({ on: false, playing: false, held: false })
  })

  it('M4: a capture while the music is off is passed through untouched', async () => {
    const t = setup()
    t.player.start()
    const s = await t.mediaDevices.getUserMedia({ audio: true })
    expect(s).toBe(t.captured.stream)
    expect(t.audios).toHaveLength(0)
  })

  it('M5: No thanks marks the offer answered without turning anything on', () => {
    const t = setup()
    t.player.decline()
    expect(t.player.getState()).toMatchObject({ asked: true, on: false })
    expect(t.saved()).toMatchObject({ asked: true, on: false })
  })

  it('M3: on a phone, a tap (click or touchend, not only pointerdown) starts it after a reload', async () => {
    const t = setup({ on: true, track: 'rain', volume: 0.5, asked: true })
    t.block(true)
    t.player.start()
    t.block(false)
    t.events.dispatchEvent(new Event('touchend'))
    await t.settle()
    expect(t.player.getState().playing).toBe(true)
  })

  it('M3: a resume the browser refuses after a recording waits for the next click', async () => {
    const t = setup()
    t.player.start()
    t.player.play()
    await t.settle()
    await t.mediaDevices.getUserMedia({ audio: true })
    await t.settle()
    t.block(true)
    for (const tr of t.captured.tracks) tr.stop()
    await t.settle()
    await t.settle()
    expect(t.player.getState()).toMatchObject({ playing: false, waiting: true })
    t.block(false)
    t.events.dispatchEvent(new Event('click'))
    await t.settle()
    expect(t.player.getState()).toMatchObject({ playing: true, waiting: false })
  })

  it('M3: a play cut short by a track change is not mistaken for needing a click', async () => {
    const t = setup()
    t.player.start()
    t.player.play()
    await t.settle()
    const a = t.audios[0] as FakeAudio
    a.failWith = 'AbortError'
    t.player.setTrack('lofi')
    await t.settle()
    await t.settle()
    expect(t.player.getState()).toMatchObject({ waiting: false, playing: true, failed: false })
    expect(a.src).toBe('/music/lo-fi.mp3')
  })

  it('M2: a track that fails to load says so instead of waiting for a click', async () => {
    const t = setup()
    t.player.start()
    t.player.play()
    await t.settle()
    t.player.stop()
    await t.settle()
    ;(t.audios[0] as FakeAudio).failWith = 'NotSupportedError'
    t.player.play()
    await t.settle()
    expect(t.player.getState()).toMatchObject({ failed: true, waiting: false, playing: false })
  })

  it('M4: a recording silences the music at once, without a fade', async () => {
    const t = setup()
    t.player.start()
    t.player.play()
    await t.settle()
    const a = t.audios[0] as FakeAudio
    await t.mediaDevices.getUserMedia({ audio: true })
    // No timers run: it is already silent.
    expect(a.paused).toBe(true)
    expect(a.volume).toBe(0)
  })

  it('M2: a device that ignores the page volume (iPhone) says so', async () => {
    const t = setup(undefined, { fixed: true })
    t.player.start()
    t.player.play()
    await t.settle()
    expect(t.player.getState()).toMatchObject({ playing: true, fixedVolume: true })
  })
})
