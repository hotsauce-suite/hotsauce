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
      return new R2AudioStore({
        // superRefine in config.ts guarantees these with AUDIO_STORE=r2.
        accountId: config.R2_ACCOUNT_ID ?? '',
        accessKeyId: config.R2_ACCESS_KEY_ID ?? '',
        secretAccessKey: config.R2_SECRET_ACCESS_KEY ?? '',
        bucket: config.R2_BUCKET ?? '',
      })
  }
}
