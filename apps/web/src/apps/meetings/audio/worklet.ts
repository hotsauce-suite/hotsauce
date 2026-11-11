// AudioWorklet processor: one per track, turning the track's audio into 100 ms frames of
// 16 kHz mono PCM16 LE, posted to the main thread as transferable ArrayBuffers.
// Loaded with `audioWorklet.addModule(url)`; recorder.ts gets the URL from `?worker&url`.

import { PCM_PROCESSOR, PcmFramer } from './pcm'

// The AudioWorkletGlobalScope's globals; TypeScript's DOM lib doesn't describe them.
declare const sampleRate: number
declare function registerProcessor(name: string, ctor: new () => unknown): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}

class PcmFrameProcessor extends AudioWorkletProcessor {
  private readonly framer = new PcmFramer(sampleRate)

  process(inputs: Float32Array[][]): boolean {
    // The node is set to one explicit mono channel, so the engine has already down-mixed.
    const channel = inputs[0]?.[0]
    if (!channel) return true
    for (const frame of this.framer.push(channel)) {
      this.port.postMessage(frame.buffer, [frame.buffer])
    }
    return true
  }
}

registerProcessor(PCM_PROCESSOR, PcmFrameProcessor)
