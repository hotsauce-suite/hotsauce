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
  /** How many highlights it has, everyone's. */
  highlightCount: number
}

/** A highlighted passage and its note (docs/PLAN-links-highlights.md). */
export interface LinkHighlight {
  id: string
  /** Who made it, lower case email. */
  by: string
  at: string
  quote: string
  prefix?: string
  suffix?: string
  /** The top-level block of the copy it starts in. */
  block?: number
  note?: string
  edited?: string
  /** The maker's name. */
  name: string
}

export interface HighlightInput {
  quote: string
  prefix?: string
  suffix?: string
  block?: number
  note?: string
}

/** A highlight with the link it is in, for the Highlights tab. */
export interface HighlightView extends LinkHighlight {
  link: { space: string; id: string; title: string; site: string; url: string }
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
  highlights: LinkHighlight[]
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
  highlights: (q: { q?: string } = {}) =>
    request<{ highlights: HighlightView[] }>('/api/links/highlights', {
      query: { q: q.q?.trim() || undefined },
    }),
  addHighlight: (space: string, id: string, input: HighlightInput) =>
    request<LinkHighlight>(`${at(space, id)}/highlights`, { method: 'POST', json: input }),
  noteHighlight: (space: string, id: string, hid: string, note: string) =>
    request<LinkHighlight>(`${at(space, id)}/highlights/${enc(hid)}`, {
      method: 'PATCH',
      json: { note },
    }),
  removeHighlight: (space: string, id: string, hid: string) =>
    request<void>(`${at(space, id)}/highlights/${enc(hid)}`, { method: 'DELETE' }),
  copyHighlights: (space: string, id: string) =>
    request<{ space: string; path: string; title: string }>(`${at(space, id)}/highlights/doc`, {
      method: 'POST',
    }),
}

/** "3 highlights", "1 highlight", or ''. */
export function highlightLabel(n: number): string {
  return n > 0 ? `${n} highlight${n === 1 ? '' : 's'}` : ''
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
