// Client for `/api/clips` (ARCHITECTURE §10.2): Hearth Clips.

import { request } from './client'

export type ClipMode = 'screen_camera' | 'screen' | 'camera'
export type ClipContainer = 'mp4' | 'webm'

export interface Clip {
  id: string
  title: string
  summary: string | null
  mode: ClipMode
  status: 'recording' | 'processing' | 'ready' | 'failed'
  error: string | null
  durationMs: number | null
  sizeBytes: number | null
  width: number | null
  height: number | null
  mimeType: string
  owner: { name: string; email: string }
  isOwner: boolean
  createdAt: string
  updatedAt: string
  transcriptStatus: 'pending' | 'processing' | 'ready' | 'failed' | 'none'
  transcriptError: string | null
  /** Signed, short-lived; null until the clip is ready. */
  videoUrl: string | null
  thumbUrl: string | null
  downloadUrl: string | null
}

/** One transcript line; seconds from the start of the video. */
export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

const BASE = '/api/clips'
const clip = (id: string) => `${BASE}/${encodeURIComponent(id)}`

export const clipsApi = {
  config: () => request<{ available: boolean }>(`${BASE}/config`),
  list: (scope: 'mine' | 'team', q?: string) =>
    request<{ clips: Clip[] }>(BASE, { query: { scope, q: q?.trim() || undefined } }),
  get: (id: string) => request<{ clip: Clip; transcript: TranscriptSegment[] }>(clip(id)),
  create: (body: { mode: ClipMode; container: ClipContainer; title?: string }) =>
    request<Clip>(BASE, { method: 'POST', json: body }),
  putChunk: (id: string, seq: number, data: Blob) =>
    request<void>(`${clip(id)}/chunks/${seq}`, { method: 'PUT', body: data }),
  finish: (id: string, chunks: number) =>
    request<Clip>(`${clip(id)}/finish`, { method: 'POST', json: { chunks } }),
  rename: (id: string, title: string) =>
    request<Clip>(clip(id), { method: 'PATCH', json: { title } }),
  remove: (id: string) => request<void>(clip(id), { method: 'DELETE' }),
  retryTranscript: (id: string) =>
    request<Clip>(`${clip(id)}/transcript/retry`, { method: 'POST' }),
}
