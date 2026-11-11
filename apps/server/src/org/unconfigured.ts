import type { ClipTranscriber } from '../clips/transcriber.js'
import type { DictationTranscriber } from '../dictation/transcriber.js'
import { HearthError } from '../errors.js'
import type { LLM } from '../meetings/llm/types.js'
import type { Transcriber } from '../meetings/transcriber/types.js'

/**
 * Stand-ins for a provider whose key hasn't been added yet (LLM_PROVIDER / ASR_PROVIDER = none).
 * Each refuses with `not_configured`, whose message tells an admin where to add the key, so the
 * feature says so instead of the server refusing to start.
 */
export const ANTHROPIC_MISSING =
  'AI features are off: an admin can add an Anthropic API key in Settings → Organization'
export const DEEPGRAM_MISSING =
  'Transcription is off: an admin can add a Deepgram API key in Settings → Organization'

export class UnconfiguredLLM implements LLM {
  async complete(): Promise<never> {
    throw new HearthError('not_configured', ANTHROPIC_MISSING)
  }
}

export class UnconfiguredTranscriber implements Transcriber {
  async start(): Promise<never> {
    throw new HearthError('not_configured', DEEPGRAM_MISSING)
  }
}

export class UnconfiguredDictationTranscriber implements DictationTranscriber {
  async transcribe(): Promise<never> {
    throw new HearthError('not_configured', DEEPGRAM_MISSING)
  }
}

export class UnconfiguredClipTranscriber implements ClipTranscriber {
  async transcribe(): Promise<never> {
    throw new HearthError('not_configured', DEEPGRAM_MISSING)
  }
}
