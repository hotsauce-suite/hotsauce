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
  /** The camera bubble being put into the video; until `ready` the video is the screen alone. */
  compositeStatus: 'none' | 'pending' | 'processing' | 'ready' | 'failed'
  screenSurface: string | null
  screenLabel: string | null
  speakers: ClipSpeaker[]
  aiSummary: string | null
  /** A `- [ ] …` checklist; empty when none were found; null until asked for. */
  aiActions: string | null
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
  /** Speaker number from diarization; absent in older clips. */
  speaker?: number
}

export interface ClipSpeaker {
  id: number
  name: string
  /** The owner named them. */
  named: boolean
}

/** What Stop tells the server about the recording. */
export interface FinishBody {
  chunks: number
  camera?: { chunks: number; container: ClipContainer; offsetMs: number }
  screenSurface?: string
  screenLabel?: string
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
  putChunk: (id: string, seq: number, data: Blob, track: 'screen' | 'camera' = 'screen') =>
    request<void>(`${clip(id)}/chunks/${seq}`, {
      method: 'PUT',
      body: data,
      ...(track === 'camera' ? { query: { track } } : {}),
    }),
  finish: (id: string, body: FinishBody) =>
    request<Clip>(`${clip(id)}/finish`, { method: 'POST', json: body }),
  setSpeakers: (id: string, speakers: Record<string, string>) =>
    request<Clip>(clip(id), { method: 'PATCH', json: { speakers } }),
  generate: (id: string, kind: 'summary' | 'actions') =>
    request<Clip>(`${clip(id)}/ai`, { method: 'POST', json: { kind } }),
  send: (id: string, to: 'doc' | 'meeting', transcript: boolean) =>
    request<{ space: string; path: string }>(`${clip(id)}/send`, {
      method: 'POST',
      json: { to, transcript },
    }),
  rename: (id: string, title: string) =>
    request<Clip>(clip(id), { method: 'PATCH', json: { title } }),
  remove: (id: string) => request<void>(clip(id), { method: 'DELETE' }),
  retryTranscript: (id: string) =>
    request<Clip>(`${clip(id)}/transcript/retry`, { method: 'POST' }),
}
