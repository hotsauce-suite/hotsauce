// Client for `/api/dictation` (ARCHITECTURE §9.2): Hearth Dictate's devices and word lists.

import { request } from './client'

export interface DictationDevice {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
}

export interface DictationWords {
  mine: string[]
  team: string[]
}

export type WordScope = 'mine' | 'team'

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
