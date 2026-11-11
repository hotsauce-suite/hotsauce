import { describe, expect, it, vi } from 'vitest'
import { type AnalyserContext, audioArrived, CaptureError, captureAudio } from './capture'

// ------------------------------------------------------------------- fake media (jsdom has none)

class FakeTrack extends EventTarget {
  stopped = false
  constructor(readonly kind: 'audio' | 'video') {
    super()
  }
  stop() {
    this.stopped = true
  }
  end() {
    this.dispatchEvent(new Event('ended'))
  }
}

class FakeStream {
  constructor(public tracks: FakeTrack[]) {}
  getTracks = () => this.tracks
  getAudioTracks = () => this.tracks.filter((t) => t.kind === 'audio')
  getVideoTracks = () => this.tracks.filter((t) => t.kind === 'video')
  removeTrack = (track: FakeTrack) => {
    this.tracks = this.tracks.filter((t) => t !== track)
  }
}

const asStream = (s: FakeStream) => s as unknown as MediaStream

// jsdom's DOMException isn't an Error subclass, so anything that isn't a stream is a rejection.
function fakeMedia(opts: { display?: FakeStream | DOMException; mic?: FakeStream | DOMException }) {
  const result = (value: FakeStream | DOMException | undefined) =>
    value === undefined || value instanceof FakeStream
      ? Promise.resolve(asStream(value ?? new FakeStream([new FakeTrack('audio')])))
      : Promise.reject(value)
  return {
    getDisplayMedia: vi.fn((_constraints?: DisplayMediaStreamOptions) => result(opts.display)),
    getUserMedia: vi.fn((_constraints?: MediaStreamConstraints) => result(opts.mic)),
  }
}

async function failure(promise: Promise<unknown>): Promise<CaptureError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof CaptureError) return err
    throw err
  }
  throw new Error('expected capture to fail')
}

describe('captureAudio', () => {
  it('Meet tab mode: asks for the tab with the contract constraints, stops video, adds the mic', async () => {
    const video = new FakeTrack('video')
    const tabAudio = new FakeTrack('audio')
    const media = fakeMedia({ display: new FakeStream([video, tabAudio]) })
    const capture = await captureAudio('meet-tab', null, media)

    expect(media.getDisplayMedia).toHaveBeenCalledWith({
      video: true,
      audio: true,
      selfBrowserSurface: 'exclude',
      systemAudio: 'exclude',
    })
    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(video.stopped).toBe(true)
    expect(capture.streams.them?.getVideoTracks()).toEqual([])
    expect(capture.streams.them?.getAudioTracks()).toEqual([tabAudio])
    expect(capture.streams.me).toBeDefined()
  })

  it('Meet tab mode takes the tab from the Hearth extension and skips the picker', async () => {
    const tabAudio = new FakeTrack('audio')
    const media = fakeMedia({})
    const fromExtension = asStream(new FakeStream([tabAudio]))
    const capture = await captureAudio('meet-tab', null, media, async () => fromExtension)
    expect(media.getDisplayMedia).not.toHaveBeenCalled()
    expect(capture.streams.them).toBe(fromExtension)
    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: true })
  })

  it('falls back to the picker when the extension has nothing, or fails', async () => {
    for (const tabSource of [async () => null, () => Promise.reject(new Error('stuck'))]) {
      const tabAudio = new FakeTrack('audio')
      const media = fakeMedia({ display: new FakeStream([tabAudio]) })
      const capture = await captureAudio('meet-tab', null, media, tabSource)
      expect(media.getDisplayMedia).toHaveBeenCalledTimes(1)
      expect(capture.streams.them?.getAudioTracks()).toEqual([tabAudio])
    }
  })

  it('Mic-only mode never opens the share picker', async () => {
    const media = fakeMedia({})
    const capture = await captureAudio('mic-only', null, media)
    expect(media.getDisplayMedia).not.toHaveBeenCalled()
    expect(Object.keys(capture.streams)).toEqual(['me'])
  })

  it('refuses a share without tab audio and says to tick the box', async () => {
    const video = new FakeTrack('video')
    const err = await failure(
      captureAudio('meet-tab', null, fakeMedia({ display: new FakeStream([video]) })),
    )
    expect(err.reason).toBe('no-tab-audio')
    expect(err.message).toContain('Share tab audio')
    expect(video.stopped).toBe(true)
  })

  it('reports a refused picker or microphone as denied, and releases the tab when the mic fails', async () => {
    const denied = new DOMException('no', 'NotAllowedError')
    expect(
      (await failure(captureAudio('meet-tab', null, fakeMedia({ display: denied })))).reason,
    ).toBe('denied')
    const tabAudio = new FakeTrack('audio')
    const err = await failure(
      captureAudio(
        'meet-tab',
        null,
        fakeMedia({ display: new FakeStream([tabAudio]), mic: denied }),
      ),
    )
    expect(err.reason).toBe('denied')
    expect(tabAudio.stopped).toBe(true)
    const busy = new DOMException('busy', 'NotReadableError')
    expect((await failure(captureAudio('mic-only', null, fakeMedia({ mic: busy })))).reason).toBe(
      'no-mic',
    )
  })

  it('says tab sharing is unsupported where getDisplayMedia is missing', async () => {
    const media = { getUserMedia: vi.fn() }
    const err = await failure(captureAudio('meet-tab', null, media))
    expect(err.reason).toBe('unsupported')
    expect(media.getUserMedia).not.toHaveBeenCalled()
  })

  it('tells listeners when a track ends on its own, but not after stop()', async () => {
    const tabAudio = new FakeTrack('audio')
    const capture = await captureAudio(
      'meet-tab',
      null,
      fakeMedia({ display: new FakeStream([tabAudio]) }),
    )
    const ended = vi.fn()
    capture.onEnded(ended)
    tabAudio.end()
    expect(ended).toHaveBeenCalledWith('them')
    capture.stop()
    tabAudio.end()
    expect(ended).toHaveBeenCalledTimes(1)
    expect(tabAudio.stopped).toBe(true)
  })
})

// ------------------------------------------------------------------- audioArrived

/** An AudioContext stand-in whose analyser returns `frames` in turn (then the last one). */
function stubContext(frames: number[][]) {
  let calls = 0
  const state = { closed: false, disconnected: false, polls: 0 }
  const analyser = {
    fftSize: 0,
    getFloatTimeDomainData(out: Float32Array) {
      const frame = frames[Math.min(calls, frames.length - 1)] ?? []
      calls += 1
      state.polls = calls
      out.fill(0)
      out.set(frame.slice(0, out.length))
    },
  } as unknown as AnalyserNode
  const context: AnalyserContext = {
    createMediaStreamSource: () => ({
      connect: () => {},
      disconnect: () => {
        state.disconnected = true
      },
    }),
    createAnalyser: () => analyser,
    resume: async () => {},
    close: async () => {
      state.closed = true
    },
  }
  return { context, state }
}

const stream = asStream(new FakeStream([new FakeTrack('audio')]))

describe('audioArrived', () => {
  it('resolves true once a non-silent sample arrives, and cleans up', async () => {
    const { context, state } = stubContext([
      [0, 0],
      [0, 0],
      [0, 0.002, -0.01, 0],
    ])
    const arrived = await audioArrived(stream, { createContext: () => context, intervalMs: 1 })
    expect(arrived).toBe(true)
    expect(state.polls).toBe(3)
    expect(state.closed).toBe(true)
    expect(state.disconnected).toBe(true)
  })

  it('resolves false when only digital silence arrives before the timeout', async () => {
    const { context, state } = stubContext([[0, 0, 0]])
    const arrived = await audioArrived(stream, {
      createContext: () => context,
      intervalMs: 5,
      timeoutMs: 60,
    })
    expect(arrived).toBe(false)
    expect(state.polls).toBeGreaterThan(1)
    expect(state.closed).toBe(true)
  })

  it('ignores a noise floor below the threshold', async () => {
    const { context } = stubContext([[0.0001, -0.0002, 0.0001]])
    const arrived = await audioArrived(stream, {
      createContext: () => context,
      intervalMs: 5,
      timeoutMs: 40,
    })
    expect(arrived).toBe(false)
  })

  it('gives up after 3 seconds by default', async () => {
    vi.useFakeTimers()
    try {
      const { context } = stubContext([[0]])
      const result = audioArrived(stream, { createContext: () => context })
      await vi.advanceTimersByTimeAsync(2900)
      let settled = false
      void result.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(200)
      expect(await result).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
