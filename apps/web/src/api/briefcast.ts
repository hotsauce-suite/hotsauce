// Client for `/api/briefcast` (docs/plans/2026-11-12-briefcast.md): the member's morning briefings.

import { request, requestBlob } from './client'
import { memberTimeZone } from './tasks'

export interface EpisodeSummary {
  /** The member's local date, `YYYY-MM-DD`. */
  date: string
  title: string
  /** ISO instant it was made. */
  generated: string
  seconds: number | null
  audio: boolean
}

export interface Episode extends EpisodeSummary {
  /** What the voice reads, in paragraphs. */
  script: string
  /** It had audio, deleted after 30 days. */
  audioExpired: boolean
  model: string
  voice: string
  counts: { events: number; meetings: number; tasks: number; docs: number }
}

export interface BriefcastOverview {
  episodes: EpisodeSummary[]
  latest: Episode | null
  feedUrl: string | null
  /** False when no voice is set up: episodes are scripts only. */
  voice: boolean
  /** Local hour by which each weekday's episode is ready. */
  readyHour: number
}

export type CastStatus = 'written' | 'unchanged' | 'empty'

const BASE = '/api/briefcast'

export const briefcastApi = {
  /** Also tells the server the member's zone, so the morning episode is ready in their morning. */
  get: () => request<BriefcastOverview>(`${BASE}?tz=${encodeURIComponent(memberTimeZone())}`),
  episode: (date: string) => request<Episode>(`${BASE}/episodes/${date}`),
  /** The MP3, fetched with the member's credentials (an <audio> element can't send them). */
  audio: (date: string, version: string) =>
    requestBlob(`${BASE}/episodes/${date}/audio?v=${encodeURIComponent(version)}`),
  refresh: () =>
    request<{ status: CastStatus; episode: Episode | null }>(`${BASE}/refresh`, {
      method: 'POST',
      json: { tz: memberTimeZone() },
    }),
  makeFeed: () => request<{ feedUrl: string }>(`${BASE}/feed`, { method: 'POST' }),
  removeFeed: () => request<void>(`${BASE}/feed`, { method: 'DELETE' }),
}
