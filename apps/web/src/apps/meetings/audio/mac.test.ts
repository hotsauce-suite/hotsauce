import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Capture, CaptureError, captureAudio, type FrameSource } from './capture'
import {
  captureMac,
  frameRecorder,
  framesArrived,
  MAC_AUDIO_EVENT,
  macBridge,
  pcmPeak,
  supportsMacCapture,
} from './mac'

type Reply = unknown
function fakeBridge(reply: Reply | (() => Promise<Reply>) = { ok: true, session: 's1' }) {
  return {
    postMessage: vi.fn(async (message: unknown) => {
      if ((message as { type: string }).type === 'stop') return null
      return typeof reply === 'function' ? (reply as () => Promise<Reply>)() : reply
    }),
  }
}

function pcm(...samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  samples.forEach((s, i) => {
    view.setInt16(i * 2, s, true)
  })
  return bytes
}

function framesOf(capture: Capture): FrameSource {
  if (!capture.frames) throw new Error('expected frames')
  return capture.frames
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

function send(detail: unknown) {
  window.dispatchEvent(new CustomEvent(MAC_AUDIO_EVENT, { detail }))
}

type W = { hearthMac?: unknown; webkit?: unknown }

afterEach(() => {
  delete (window as W).hearthMac
  delete (window as W).webkit
})

describe('availability', () => {
  it('is offered only when the app says it can record the whole Mac and its bridge exists', () => {
    expect(supportsMacCapture()).toBe(false)
    const bridge = fakeBridge()
    ;(window as W).webkit = { messageHandlers: { hearthMeetingAudio: bridge } }
    expect(supportsMacCapture()).toBe(false)
    ;(window as W).hearthMac = { meetingAudio: 1 }
    expect(supportsMacCapture()).toBe(true)
    expect(macBridge()).toBe(bridge)
  })
})

describe('captureMac', () => {
  it('starts the app, lists both tracks, and delivers its frames byte for byte', async () => {
    const bridge = fakeBridge()
    const capture = await captureMac(bridge)
    expect(bridge.postMessage).toHaveBeenCalledWith({ type: 'start' })
    expect(capture.mode).toBe('mac')
    expect(capture.streams).toEqual({})
    expect(capture.frames?.tracks).toEqual(['me', 'them'])

    const got: Array<[string, number[]]> = []
    capture.frames?.onFrame((track, bytes) => got.push([track, [...bytes]]))
    send({ session: 's1', type: 'frames', me: b64(pcm(1, -2)), them: b64(pcm(300)) })
    // Another capture's events are not ours.
    send({ session: 'old', type: 'frames', me: b64(pcm(9)) })
    expect(got).toEqual([
      ['me', [...pcm(1, -2)]],
      ['them', [...pcm(300)]],
    ])
    capture.stop()
  })

  it('reports a track the app lost', async () => {
    const capture = await captureMac(fakeBridge())
    const ended = vi.fn()
    capture.onEnded(ended)
    send({ session: 's1', type: 'ended', track: 'them' })
    send({ session: 's1', type: 'ended', track: 'nope' })
    expect(ended).toHaveBeenCalledTimes(1)
    expect(ended).toHaveBeenCalledWith('them')
    capture.stop()
  })

  it('passes on that the call ended, for this session only', async () => {
    const capture = await captureMac(fakeBridge())
    const callEnded = vi.fn()
    capture.onCallEnded?.(callEnded)
    send({ session: 'old', type: 'call-ended' })
    expect(callEnded).not.toHaveBeenCalled()
    send({ session: 's1', type: 'call-ended' })
    expect(callEnded).toHaveBeenCalledTimes(1)
    capture.stop()
    send({ session: 's1', type: 'call-ended' })
    expect(callEnded).toHaveBeenCalledTimes(1)
  })

  it('stop tells the app to stop, once, and ignores later events', async () => {
    const bridge = fakeBridge()
    const capture = await captureMac(bridge)
    const frame = vi.fn()
    capture.frames?.onFrame(frame)
    capture.stop()
    capture.stop()
    send({ session: 's1', type: 'frames', me: b64(pcm(5)) })
    expect(frame).not.toHaveBeenCalled()
    expect(bridge.postMessage).toHaveBeenCalledTimes(2)
    expect(bridge.postMessage).toHaveBeenLastCalledWith({ type: 'stop', session: 's1' })
  })

  it("the app's refusal is a CaptureError with its reason and message", async () => {
    const err = await captureMac(
      fakeBridge({ ok: false, reason: 'denied', message: 'Allow the microphone for Hearth.' }),
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CaptureError)
    expect(err).toMatchObject({ reason: 'denied', message: 'Allow the microphone for Hearth.' })

    const odd = await captureMac(fakeBridge({ ok: false, reason: 'weird' })).catch((e) => e)
    expect(odd).toMatchObject({ reason: 'unsupported' })
    const thrown = await captureMac(fakeBridge(() => Promise.reject(new Error('gone')))).catch(
      (e) => e,
    )
    expect(thrown).toMatchObject({ reason: 'unsupported' })
  })

  it('without the app, it is unsupported', async () => {
    await expect(captureMac(null)).rejects.toMatchObject({ reason: 'unsupported' })
  })

  it("captureAudio('mac') goes through the app's bridge", async () => {
    const bridge = fakeBridge()
    ;(window as W).hearthMac = { meetingAudio: 1 }
    ;(window as W).webkit = { messageHandlers: { hearthMeetingAudio: bridge } }
    const capture = await captureAudio('mac')
    expect(capture.mode).toBe('mac')
    expect(bridge.postMessage).toHaveBeenCalledWith({ type: 'start' })
    capture.stop()
  })
})

describe('frames → recorder', () => {
  it('passes frames through and drops them while paused, nothing after stop', async () => {
    const bridge = fakeBridge()
    const capture = await captureMac(bridge)
    const sent: Array<[string, number]> = []
    const recorder = frameRecorder(framesOf(capture), (track, bytes) =>
      sent.push([track, bytes.length]),
    )
    send({ session: 's1', type: 'frames', me: b64(pcm(1, 2)) })
    recorder.setPaused(true)
    send({ session: 's1', type: 'frames', them: b64(pcm(1)) })
    recorder.setPaused(false)
    send({ session: 's1', type: 'frames', them: b64(pcm(1, 2, 3)) })
    await recorder.stop()
    send({ session: 's1', type: 'frames', me: b64(pcm(1)) })
    // Pause and resume reach the app, so it lets go of the mic and the Mac's audio meanwhile.
    expect(bridge.postMessage).toHaveBeenCalledWith({ type: 'pause', session: 's1' })
    expect(bridge.postMessage).toHaveBeenCalledWith({ type: 'resume', session: 's1' })
    expect(sent).toEqual([
      ['me', 4],
      ['them', 6],
    ])
    capture.stop()
  })
})

describe('is sound arriving', () => {
  it('peak of PCM16', () => {
    expect(pcmPeak(pcm(0, 0))).toBe(0)
    expect(pcmPeak(pcm(-16384, 100))).toBe(0.5)
  })

  it('a non-silent frame on the track is ok; silence or another track times out', async () => {
    vi.useFakeTimers()
    try {
      const capture = await captureMac(fakeBridge())
      const them = framesArrived(framesOf(capture), 'them', { timeoutMs: 3000 })
      const me = framesArrived(framesOf(capture), 'me', { timeoutMs: 3000 })
      send({ session: 's1', type: 'frames', me: b64(pcm(0, 0)), them: b64(pcm(0, 2000)) })
      await expect(them).resolves.toBe(true)
      vi.advanceTimersByTime(3000)
      await expect(me).resolves.toBe(false)
      capture.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
