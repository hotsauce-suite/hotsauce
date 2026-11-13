import type { Config } from '../../config.js'
import { LocalAudioStore } from './local.js'
import { R2AudioStore } from './r2.js'
import type { AudioStore } from './types.js'

export { LocalAudioStore } from './local.js'
export { contentDisposition, R2AudioStore } from './r2.js'
export type { AudioStore } from './types.js'
export { pcmSeconds, WAV_HEADER_BYTES, wavHeader, wavStream } from './wav.js'

/** The configured store, or null when kept audio isn't offered (AUDIO_STORE=none). */
export function createAudioStore(config: Config): AudioStore | null {
  switch (config.AUDIO_STORE) {
    case 'none':
      return null
    case 'local':
      return new LocalAudioStore(config.DATA_DIR)
    case 'r2':
      // superRefine in config.ts guarantees a bucket with AUDIO_STORE=r2.
      if (!config.OBJECT_STORE) return null
      return new R2AudioStore(config.OBJECT_STORE)
  }
}
