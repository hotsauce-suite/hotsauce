// Captured streams → one AudioWorklet per track → 100 ms PCM16 frames for the socket.

import type { Track } from '../../../api/types'
import type { Capture } from './capture'
import { frameRecorder } from './mac'
import { PCM_PROCESSOR, TARGET_RATE } from './pcm'
import workletUrl from './worklet.ts?worker&url'

export interface Recorder {
  /** While paused, frames are dropped here and never reach the server. */
  setPaused: (paused: boolean) => void
  stop: () => Promise<void>
}

/**
 * A 16 kHz context where the browser resamples media streams itself (Chrome does, with a
 * proper filter); otherwise the device rate, and the worklet resamples.
 */
async function openContext(
  streams: MediaStream[],
): Promise<{ context: AudioContext; sources: MediaStreamAudioSourceNode[] }> {
  try {
    const context = new AudioContext({ sampleRate: TARGET_RATE })
    try {
      return { context, sources: streams.map((s) => context.createMediaStreamSource(s)) }
    } catch {
      await context.close()
    }
  } catch {
    // This browser can't make a 16 kHz context at all.
  }
  const context = new AudioContext()
  return { context, sources: streams.map((s) => context.createMediaStreamSource(s)) }
}

export async function startRecorder(
  capture: Capture,
  onFrame: (track: Track, pcm: Uint8Array) => void,
): Promise<Recorder> {
  if (capture.frames) return frameRecorder(capture.frames, onFrame)
  const tracks = Object.entries(capture.streams) as Array<[Track, MediaStream]>
  const { context, sources } = await openContext(tracks.map(([, stream]) => stream))
  await context.audioWorklet.addModule(workletUrl)
  await context.resume()

  // A worklet node only runs while something pulls on it: route it into a muted gain.
  const sink = context.createGain()
  sink.gain.value = 0
  sink.connect(context.destination)

  let paused = false
  const nodes = tracks.map(([track], i) => {
    const node = new AudioWorkletNode(context, PCM_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    })
    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!paused) onFrame(track, new Uint8Array(event.data))
    }
    sources[i]?.connect(node)
    node.connect(sink)
    return node
  })

  return {
    setPaused: (next) => {
      paused = next
    },
    stop: async () => {
      for (const node of nodes) {
        node.port.onmessage = null
        node.disconnect()
      }
      for (const source of sources) source.disconnect()
      await context.close().catch(() => {})
    },
  }
}
