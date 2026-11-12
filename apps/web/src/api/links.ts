// Client for Saved links (ARCHITECTURE §23): `/api/links`.

import { request } from './client'

export type LinkStatus = 'fetching' | 'ready' | 'failed'
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

/** "5 min read", from a word count. */
export function readingTime(words: number | null): string {
  if (!words) return ''
  return `${Math.max(1, Math.round(words / 230))} min read`
}
