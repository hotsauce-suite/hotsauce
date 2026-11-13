import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HearthApiError } from '../../../api/client'
import type { Clip } from '../../../api/clips'
import { elapsedMs, RecordingSession, type SessionDeps } from './session'

class FakeTrack extends EventTarget {
  stopped = false
  constructor(
    readonly kind: 'audio' | 'video',
    readonly settings: Record<string, unknown> = {},
  ) {
    super()
  }
  stop() {
    this.stopped = true
  }
  getSettings() {
    return this.settings
  }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getTracks() {
    return this.tracks
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video')
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio')
  }
}

class FakeRecorder extends EventTarget {
  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  timeslice = 0
  constructor(
    readonly stream: FakeStream,
    readonly options: MediaRecorderOptions,
  ) {
    super()
  }
  start(timeslice: number) {
    this.state = 'recording'
    this.timeslice = timeslice
    this.dispatchEvent(new Event('start'))
  }
  pause() {
    this.state = 'paused'
  }
  resume() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    this.emit('last')
    this.dispatchEvent(new Event('stop'))
  }
  emit(text: string) {
    const event = new Event('dataavailable') as Event & { data: Blob }
    Object.defineProperty(event, 'data', { value: new Blob([text]) })
    this.dispatchEvent(event)
  }
}

const clip = (status: Clip['status'] = 'recording') =>
  ({ id: '01CLIP', status, title: 'Recording' }) as Clip
const flush = () => new Promise((r) => setTimeout(r, 0))

let now: number
/** The screen's recorder (made first), and the camera's when there is one. */
let recorder: FakeRecorder
let cameraRecorder: FakeRecorder | undefined
let display: FakeStream
let camera: FakeStream
let mic: FakeStream
let pip: { closed: boolean; close: () => void; addEventListener: () => void }
let api: SessionDeps['api'] & Record<string, ReturnType<typeof vi.fn>>
let deps: SessionDeps

beforeEach(() => {
  vi.stubGlobal('MediaStream', FakeStream)
  now = 1000
  cameraRecorder = undefined
  display = new FakeStream([
    new FakeTrack('video', { displaySurface: 'monitor' }),
    new FakeTrack('audio'),
  ])
  camera = new FakeStream([new FakeTrack('video')])
  mic = new FakeStream([new FakeTrack('audio')])
  pip = {
    closed: false,
    close() {
      this.closed = true
    },
    addEventListener() {},
  }
  api = {
    create: vi.fn(async () => clip()),
    putChunk: vi.fn(async () => {}),
    finish: vi.fn(async () => clip('processing')),
    remove: vi.fn(async () => {}),
  }
  deps = {
    api,
    format: { mimeType: 'video/webm;codecs=vp9,opus', container: 'webm' },
    cameraFormat: { mimeType: 'video/webm;codecs=vp9', container: 'webm' },
    requestDisplay: vi.fn(async () => display as unknown as MediaStream),
    openPip: vi.fn(async () => pip as unknown as Window),
    createRecorder: (stream, options) => {
      const made = new FakeRecorder(stream as unknown as FakeStream, options)
      if (
        made.stream.getVideoTracks()[0] === camera.tracks[0] &&
        made.options.mimeType === 'video/webm;codecs=vp9'
      ) {
        cameraRecorder = made
      } else {
        recorder = made
      }
      return made as unknown as MediaRecorder
    },
    mix: (sources) => ({
      track: (sources.flatMap((s) => s?.getAudioTracks() ?? [])[0] ?? null) as MediaStreamTrack,
      close: vi.fn(),
    }),
    now: () => now,
    sleep: async () => {},
  }
})

afterEach(() => vi.unstubAllGlobals())

const opts = (mode: 'screen_camera' | 'screen' | 'camera' = 'screen_camera') => ({
  mode,
  title: 'Recording',
  camera: camera as unknown as MediaStream,
  mic: mic as unknown as MediaStream,
})

describe('RecordingSession', () => {
  it('asks for the screen before the bubble, counts down, records and uploads chunks', async () => {
    const order: string[] = []
    deps.requestDisplay = vi.fn(async () => {
      order.push('display')
      return display as unknown as MediaStream
    })
    deps.openPip = vi.fn(async () => {
      order.push('pip')
      return pip as unknown as Window
    })
    const session = new RecordingSession(deps)
    const countdowns: Array<number | null> = []
    session.subscribe(() => countdowns.push(session.state.countdown))
    await session.start(opts())
    expect(order).toEqual(['display', 'pip'])
    expect(countdowns.filter((n) => n !== null)).toEqual([3, 2, 1])
    expect(session.state).toMatchObject({ phase: 'recording', surface: 'monitor' })
    expect(session.state.pipWindow).toBe(pip)
    expect(api.create).toHaveBeenCalledWith({
      mode: 'screen_camera',
      container: 'webm',
      title: 'Recording',
    })
    expect(recorder.timeslice).toBe(3000)
    expect(recorder.options.mimeType).toBe('video/webm;codecs=vp9,opus')
    // The screen's video and one audio track.
    expect(recorder.stream.getVideoTracks()[0]).toBe(display.tracks[0])
    expect(recorder.stream.getAudioTracks()).toHaveLength(1)

    recorder.emit('a')
    recorder.emit('b')
    await flush()
    expect(vi.mocked(api.putChunk).mock.calls.map((c) => c[1])).toEqual([0, 1])
  })

  it('records the camera on its own track, chunk-uploaded beside the screen', async () => {
    const session = new RecordingSession(deps)
    await session.start(opts())
    expect(session.state.cameraTrack).toBe(true)
    expect(cameraRecorder?.stream.getTracks()).toEqual([camera.tracks[0]])
    expect(cameraRecorder?.options).toMatchObject({
      mimeType: 'video/webm;codecs=vp9',
      videoBitsPerSecond: 1_000_000,
    })
    expect(cameraRecorder?.timeslice).toBe(3000)
    cameraRecorder?.emit('c0')
    recorder.emit('s0')
    await flush()
    const calls = vi.mocked(api.putChunk).mock.calls.map((c) => [c[1], c[3]])
    expect(calls).toEqual(
      expect.arrayContaining([
        [0, 'camera'],
        [0, 'screen'],
      ]),
    )
    // Pause and resume hold both.
    session.pause()
    expect([recorder.state, cameraRecorder?.state]).toEqual(['paused', 'paused'])
    session.resume()
    expect([recorder.state, cameraRecorder?.state]).toEqual(['recording', 'recording'])
  })

  it('records no camera track for screen only, or without a camera format', async () => {
    let session = new RecordingSession(deps)
    await session.start(opts('screen'))
    expect(cameraRecorder).toBeUndefined()
    expect(session.state.cameraTrack).toBe(false)
    session.cancel()
    session = new RecordingSession({ ...deps, cameraFormat: null })
    await session.start(opts())
    expect(cameraRecorder).toBeUndefined()
    await session.stop()
    expect(vi.mocked(api.finish).mock.calls.at(-1)?.[1]).not.toHaveProperty('camera')
  })

  it('records the screen alone when the camera recorder can’t start', async () => {
    const make = deps.createRecorder
    deps.createRecorder = (stream, options) => {
      const made = make(stream, options)
      if (options.mimeType === 'video/webm;codecs=vp9') {
        ;(made as unknown as FakeRecorder).start = () => {
          throw new DOMException('format refused', 'NotSupportedError')
        }
      }
      return made
    }
    const session = new RecordingSession(deps)
    await session.start(opts())
    expect(session.state).toMatchObject({ phase: 'recording', cameraTrack: false })
    await session.stop()
    expect(vi.mocked(api.finish).mock.calls[0]?.[1]).not.toHaveProperty('camera')
  })

  it('finishes without the camera when the server refused its upload', async () => {
    api.putChunk = vi.fn(async (_id, _seq, _data, track) => {
      if (track === 'camera') throw new HearthApiError('too_large', 'nope', 413)
    })
    const session = new RecordingSession(deps)
    await session.start(opts())
    await session.stop()
    expect(session.state.phase).toBe('finished')
    // Said, not silent: the page warns the camera won't be in the video.
    expect(session.state.cameraLost).toBe(true)
    expect(vi.mocked(api.finish).mock.calls[0]?.[1]).toEqual({
      chunks: 1,
      screenSurface: 'monitor',
    })
  })

  it('says when the shared screen stops sending a picture', async () => {
    const session = new RecordingSession(deps)
    await session.start(opts())
    display.tracks[0]?.dispatchEvent(new Event('mute'))
    expect(session.state.screenMuted).toBe(true)
    display.tracks[0]?.dispatchEvent(new Event('unmute'))
    expect(session.state.screenMuted).toBe(false)
  })

  it('times only the recorded stretches across a pause', async () => {
    const session = new RecordingSession(deps)
    await session.start(opts())
    now += 5000
    session.pause()
    expect(recorder.state).toBe('paused')
    now += 60_000
    expect(elapsedMs(session.state, now)).toBe(5000)
    session.resume()
    now += 2000
    expect(elapsedMs(session.state, now)).toBe(7000)
  })

  it('stop waits for the last chunk, finishes the clip, and releases the screen and bubble', async () => {
    const session = new RecordingSession(deps)
    await session.start(opts())
    recorder.emit('a')
    await session.stop()
    expect(api.finish).toHaveBeenCalledWith('01CLIP', {
      chunks: 2,
      screenSurface: 'monitor',
      camera: { chunks: 1, container: 'webm', offsetMs: 0 },
    })
    expect(session.state.phase).toBe('finished')
    expect(display.tracks.every((t) => t.stopped)).toBe(true)
    expect(pip.closed).toBe(true)
    // The camera and mic belong to the page's preview; the session leaves them alone.
    expect(camera.tracks[0]?.stopped).toBe(false)
  })

  it('stops when Chrome’s own Stop sharing ends the screen', async () => {
    const session = new RecordingSession(deps)
    await session.start(opts('screen'))
    display.tracks[0]?.dispatchEvent(new Event('ended'))
    await vi.waitFor(() => expect(session.state.phase).toBe('finished'))
  })

  it('records the camera itself in camera mode, without the picker or a bubble', async () => {
    const session = new RecordingSession(deps)
    await session.start(opts('camera'))
    expect(deps.requestDisplay).not.toHaveBeenCalled()
    expect(deps.openPip).not.toHaveBeenCalled()
    expect(recorder.stream.getVideoTracks()[0]).toBe(camera.tracks[0])
  })

  it('goes back to the start, deleting the clip, when the share is cancelled', async () => {
    deps.requestDisplay = vi.fn(async () => {
      throw new DOMException('Permission denied', 'NotAllowedError')
    })
    const session = new RecordingSession(deps)
    await session.start(opts())
    await flush()
    expect(session.state).toMatchObject({ phase: 'idle', error: null })
    expect(api.remove).toHaveBeenCalledWith('01CLIP')
    expect(pip.closed).toBe(true)
  })

  it('cancel throws the recording away; restart starts again with the same choices', async () => {
    const session = new RecordingSession(deps)
    await session.start(opts())
    recorder.emit('a')
    session.cancel()
    expect(session.state.phase).toBe('idle')
    expect(api.remove).toHaveBeenCalledWith('01CLIP')
    expect(display.tracks[0]?.stopped).toBe(true)
    await session.restart()
    expect(api.create).toHaveBeenCalledTimes(2)
    expect(session.state.phase).toBe('recording')
  })

  it('keeps the error and offers a retry when the connection fails while finishing', async () => {
    const offline = new HearthApiError('network', 'Could not reach the Hearth server', 0)
    api.finish = vi
      .fn()
      .mockRejectedValueOnce(offline)
      .mockRejectedValueOnce(offline)
      .mockRejectedValueOnce(offline)
      .mockRejectedValueOnce(offline)
      .mockRejectedValueOnce(offline)
      .mockResolvedValueOnce(clip('processing'))
    const session = new RecordingSession(deps)
    await session.start(opts())
    await session.stop()
    expect(session.state).toMatchObject({
      phase: 'finishing',
      error: 'Could not reach the Hearth server',
    })
    // Navigating away mid-save, or a stray Discard in the bubble, doesn't delete it.
    session.cancel()
    expect(session.state.phase).toBe('finishing')
    expect(api.remove).not.toHaveBeenCalled()
    await session.retryFinish()
    expect(session.state.phase).toBe('finished')
  })

  it('discards, saying why, when the save can’t succeed: the server refuses it', async () => {
    api.finish = vi
      .fn()
      .mockRejectedValue(new HearthApiError('conflict', 'Chunks 0 haven’t arrived', 409))
    const session = new RecordingSession(deps)
    await session.start(opts())
    await session.stop()
    expect(session.state.phase).toBe('idle')
    expect(session.state.error).toContain('Chunks 0 haven’t arrived')
    expect(api.remove).toHaveBeenCalledWith('01CLIP')
  })

  it('discards when nothing was recorded', async () => {
    const session = new RecordingSession(deps)
    await session.start(opts())
    recorder.stop = function (this: FakeRecorder) {
      this.state = 'inactive'
      this.dispatchEvent(new Event('stop'))
    }
    await session.stop()
    expect(session.state).toMatchObject({
      phase: 'idle',
      error: expect.stringContaining('Nothing was recorded'),
    })
    expect(api.finish).not.toHaveBeenCalled()
  })

  it('an old attempt’s upload no longer reaches the state after a restart', async () => {
    let fail: (err: Error) => void = () => {}
    api.putChunk = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)))
    const session = new RecordingSession(deps)
    await session.start(opts())
    recorder.emit('a')
    await session.restart()
    fail(new HearthApiError('not_found', 'No such clip', 404))
    await flush()
    expect(session.state.upload.fatal).toBeNull()
  })
})
