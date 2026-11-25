// Client for `/api/dictation` (ARCHITECTURE §9.2): Hotsauce Dictate's devices and word lists.

import type { SoundTheme } from '../lib/dictateSounds'
import { request } from './client'

export interface DictationDevice {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  /** The Mac app version the device last reported; null until it does (older apps never do). */
  appVersion?: string | null
  /** A Mac, or a phone connected for the Android app's widgets (docs/PLAN-android.md R5). */
  kind?: 'mac' | 'phone'
}

export interface DictationWords {
  mine: string[]
  team: string[]
  /** Each word's "also heard as" spellings, by list (docs/PLAN-dictate-punctuation-and-fixes.md). */
  heardAs?: { mine: Record<string, string[]>; team: Record<string, string[]> }
}

export type WordScope = 'mine' | 'team'

/** How a member's dictations are cleaned up (docs/PLAN-dictate-models.md). */
export type CleanupChoice = 'fast' | 'careful' | 'off'

/** Where the Mac app hears the member: online, or on the Mac alone. */
export type SpeechChoice = 'online' | 'device'

/** The key that ends a dictation and sends it (docs/PLAN-dictate-send-and-sounds.md). */
export type SendKey = 'space' | 'return' | 'tab' | 'off'

/** The member's cleanup choice and the plain names of the models in use. */
export interface DictationSettings {
  speech: SpeechChoice
  cleanup: CleanupChoice
  sendKey: SendKey
  sounds: SoundTheme
  /** False when the server has no AI key: nothing is cleaned, whatever the choice. */
  cleanupAvailable: boolean
  models: { speech: string; offline: string; fast: string; careful: string }
}

export const dictationApi = {
  devices: () => request<DictationDevice[]>('/api/dictation/devices'),
  /** A new device token. It is shown once: the server keeps only its hash. */
  connect: (name: string) =>
    request<DictationDevice & { token: string }>('/api/dictation/devices', {
      method: 'POST',
      json: { name },
    }),
  revoke: (id: string) =>
    request<void>(`/api/dictation/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  words: () => request<DictationWords>('/api/dictation/words'),
  settings: () => request<DictationSettings>('/api/dictation/settings'),
  setChoice: (
    choice:
      | { cleanup: CleanupChoice }
      | { speech: SpeechChoice }
      | { sendKey: SendKey }
      | { sounds: SoundTheme },
  ) => request<DictationSettings>('/api/dictation/settings', { method: 'PUT', json: choice }),
  /** Speech in, cleaned-up text out (the browser's recording; nothing is kept on the server). */
  transcribe: (audio: Blob) =>
    request<{ text: string }>('/api/dictation/transcribe', {
      method: 'POST',
      query: { mode: 'clean', app_name: 'Check-ins' },
      body: audio,
      contentType: (audio.type || 'audio/webm').split(';')[0] ?? 'audio/webm',
    }),
  setHeardAs: (scope: WordScope, word: string, heard: string[]) =>
    request<{ scope: WordScope; word: string; heard: string[] }>('/api/dictation/words/heard-as', {
      method: 'PUT',
      json: { scope, word, heard },
    }),
  setWords: (scope: WordScope, words: string[]) =>
    request<{ scope: WordScope; words: string[] }>('/api/dictation/words', {
      method: 'PUT',
      json: { scope, words },
    }),
}

/** The link the Mac app opens to connect itself; also the code to paste when it isn't installed. */
export function connectLink(token: string, server: string): string {
  const params = new URLSearchParams({ token, server })
  return `hearth-dictate://connect?${params.toString()}`
}
