// Client for Saved links (ARCHITECTURE §23): `/api/links`.

import { request } from './client'

/** `waiting`: an AI tool saved it; the page is fetched only when the member asks. */
export type LinkStatus = 'waiting' | 'fetching' | 'ready' | 'failed'
export type LinkListView = 'unread' | 'archive' | 'all'
export type LinkSource = 'web' | 'extension' | 'share' | 'shortcut' | 'mcp'

export interface LinkView {
  space: string
  path: string
  id: string
  blobOid: string
  url: string
  title: string
  site: string
  description: string
  summary: string
  tags: string[]
  archived: boolean
  saved: string
  savedBy: string
  fetched: string | null
  fetchError: string | null
  words: number | null
  source: LinkSource | null
  status: LinkStatus
  /** Your own place in the copy; null before you open it. */
  reading: ReadingPlace | null
}

/** Where you are in a saved link (docs/PLAN-links-reading-position.md). */
export interface ReadingPlace {
  /** The block of the copy at the top of the screen, from 0. */
  anchor: number
  /** How far through the copy the bottom of the screen is, 0 to 100. */
  percent: number
  /** The most of the copy ever reached, 0 to 100. */
  furthest: number
  updated: string
}

export interface LinkWithBody extends LinkView {
  body: string
}

export interface SaveLinkInput {
  url?: string
  text?: string
  title?: string
  tags?: string[]
  space?: string
  source?: LinkSource
  /** The page as the member's browser shows it (the Chrome extension's "Save page"). */
  page?: { html: string }
}

const enc = encodeURIComponent
const at = (space: string, id: string) => `/api/links/${enc(space)}/${enc(id)}`

export const linksApi = {
  list: (q: { view?: LinkListView; tag?: string; q?: string } = {}) =>
    request<{ links: LinkView[] }>('/api/links', {
      query: { view: q.view, tag: q.tag, q: q.q?.trim() || undefined },
    }),
  tags: () => request<Array<{ name: string; count: number }>>('/api/links/tags'),
  save: (input: SaveLinkInput) =>
    request<LinkView & { existing: boolean }>('/api/links', { method: 'POST', json: input }),
  get: (space: string, id: string) => request<LinkWithBody>(at(space, id)),
  update: (
    space: string,
    id: string,
    patch: { title?: string; tags?: string[]; archived?: boolean },
  ) => request<LinkView>(at(space, id), { method: 'PATCH', json: patch }),
  setReading: (
    space: string,
    id: string,
    place: { anchor: number; percent: number },
    opts: { keepalive?: boolean } = {},
  ) =>
    request<void>(`${at(space, id)}/reading`, {
      method: 'PUT',
      json: place,
      keepalive: opts.keepalive ?? false,
    }),
  refetch: (space: string, id: string) =>
    request<LinkView>(`${at(space, id)}/refetch`, { method: 'POST' }),
  move: (space: string, id: string, toSpace: string) =>
    request<LinkView>(`${at(space, id)}/move`, { method: 'POST', json: { toSpace } }),
  remove: (space: string, id: string) => request<void>(at(space, id), { method: 'DELETE' }),
}

/**
 * The address to link to, or null. The server only saves http(s) links, but a file edited by hand
 * could hold anything, so pages check again before making it a link.
 */
export function webUrl(url: string): string | null {
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : null
}

/** At or past this much of the copy, a link reads as "Read". */
export const READ_TO_END = 95

/** "40% read", "Read", or '' for a link not started. */
export function readProgress(reading: ReadingPlace | null): string {
  const furthest = reading?.furthest ?? 0
  if (furthest <= 0) return ''
  if (furthest >= READ_TO_END) return 'Read'
  return `${Math.max(1, Math.floor(furthest))}% read`
}

/** "5 min read", from a word count. */
export function readingTime(words: number | null): string {
  if (!words) return ''
  return `${Math.max(1, Math.round(words / 230))} min read`
}
