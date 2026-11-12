// Clients for read-only links and published pages (ARCHITECTURE §20).

import { getAuthHeaders, HearthApiError, request, toApiError } from './client'

export interface ShareState {
  token: string | null
  /** `/s/<token>` while the link is on. */
  url: string | null
}

export type SharedKind = 'doc' | 'meeting' | 'note' | 'page'

/** What a read-only link shows: never the space or the path. */
export interface SharedItem {
  kind: SharedKind
  title: string
  markdown: string
  html?: string
  updated: string | null
  updatedBy: string | null
}

export interface PageSummary {
  space: string
  id: string
  title: string
  created: string | null
  createdBy: string | null
  updated: string | null
  updatedBy: string | null
  shared: boolean
}

export interface PageVersion {
  oid: string
  date: string
  author: string
}

export interface PageView extends PageSummary {
  html: string
  version: string | null
  versions: PageVersion[]
  share: ShareState
}

/**
 * The shared item behind a link, with this browser's session if it has one. A 401 here means the
 * organization keeps links to signed-in people; it is not the session running out, so it never
 * signs anyone out (unlike `request`).
 */
async function sharedFetch(path: string): Promise<Response> {
  let res: Response
  try {
    res = await fetch(path, { headers: await getAuthHeaders() })
  } catch (err) {
    throw new HearthApiError('network', 'Could not reach the server', 0, err)
  }
  if (!res.ok) throw await toApiError(res)
  return res
}

export const sharesApi = {
  state: (space: string, path: string) =>
    request<ShareState>('/api/shares', { query: { space, path } }),
  set: (space: string, path: string, on: boolean) =>
    request<ShareState>('/api/shares', { method: 'POST', json: { space, path, on } }),
  /** Whether links open for anyone, signed out too (Settings → Organization). */
  sharing: () => request<{ publicShareLinks: boolean }>('/api/sharing'),
  setSharing: (publicShareLinks: boolean) =>
    request<{ publicShareLinks: boolean }>('/api/sharing', {
      method: 'PUT',
      json: { publicShareLinks },
    }),
  open: async (token: string): Promise<SharedItem> =>
    (await sharedFetch(`/api/shared/${encodeURIComponent(token)}`)).json() as Promise<SharedItem>,
  /** An image the shared doc shows, as a blob URL (an <img> can't send the session header). */
  image: async (token: string, src: string): Promise<string> => {
    const res = await sharedFetch(
      `/api/shared/${encodeURIComponent(token)}/asset?src=${encodeURIComponent(src)}`,
    )
    return URL.createObjectURL(await res.blob())
  },
}

export const pagesApi = {
  list: () => request<{ pages: PageSummary[] }>('/api/pages'),
  get: (space: string, id: string, version?: string) =>
    request<PageView>(`/api/pages/${encodeURIComponent(space)}/${encodeURIComponent(id)}`, {
      query: { version },
    }),
  remove: (space: string, id: string) =>
    request<void>(`/api/pages/${encodeURIComponent(space)}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
}

/** The link as the person will paste it. */
export const absoluteShareUrl = (url: string) => new URL(url, window.location.origin).toString()
