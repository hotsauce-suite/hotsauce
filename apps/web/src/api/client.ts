import { product } from '../brand/product'
import type {
  ApiErrorBody,
  Commit,
  CommitResult,
  ConflictDetail,
  ConflictSummary,
  Entry,
  FileContent,
  Health,
  Me,
  PublicBrand,
  PutFileBody,
  RecentItem,
  SearchResult,
  StarItem,
} from './types'

export class HearthApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details: unknown

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message)
    this.name = 'HearthApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}

type HeaderProvider = () => Promise<Record<string, string>> | Record<string, string>

let authHeaders: HeaderProvider = () => ({})
let onUnauthorized: (() => void) | null = null

/** The auth layer registers how to sign requests (dev header or Clerk bearer token). */
export function setAuthHeaders(provider: HeaderProvider): void {
  authHeaders = provider
}

export function getAuthHeaders(): Promise<Record<string, string>> {
  return Promise.resolve(authHeaders())
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler
}

const CODE_BY_STATUS: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'too_large',
  503: 'unavailable',
}

export type Query = Record<string, string | number | undefined>

export function apiUrl(path: string, query?: Query): string {
  const url = new URL(path, window.location.origin)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

function isErrorBody(body: unknown): body is ApiErrorBody {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false
  const error = (body as { error: unknown }).error
  return typeof error === 'object' && error !== null && 'code' in error && 'message' in error
}

function isConflictResult(body: unknown): body is Extract<CommitResult, { status: 'conflict' }> {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { status?: unknown }).status === 'conflict' &&
    typeof (body as { conflictRef?: unknown }).conflictRef === 'string'
  )
}

/** Maps a non-2xx response to a HearthApiError, preferring the server's `{ error: { code, message } }`. */
export async function toApiError(res: Response): Promise<HearthApiError> {
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // Not JSON (proxy error page, empty body): fall back to the status.
  }
  if (isErrorBody(body)) {
    return new HearthApiError(body.error.code, body.error.message, res.status, body.error.details)
  }
  const code = CODE_BY_STATUS[res.status] ?? (res.status >= 500 ? 'server_error' : 'http_error')
  return new HearthApiError(code, res.statusText || `Request failed (${res.status})`, res.status)
}

interface RequestOptions {
  method?: string
  query?: Query
  json?: unknown
  form?: FormData
  /** Raw bytes (a recording's chunk), sent as application/octet-stream unless `contentType` says. */
  body?: Blob
  /** PUT/restore/resolve answer 409 with a CommitResult body; return it instead of throwing. */
  conflictIsResult?: boolean
  keepalive?: boolean
  /** Extra headers, e.g. the setup wizard's token. */
  headers?: Record<string, string>
  /** The content type for `body`; default application/octet-stream. */
  contentType?: string
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { ...(await authHeaders()), ...opts.headers }
  const init: RequestInit = { method: opts.method ?? 'GET', headers }
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(opts.json)
  } else if (opts.form) {
    init.body = opts.form
  } else if (opts.body) {
    headers['content-type'] = opts.contentType ?? 'application/octet-stream'
    init.body = opts.body
  }
  if (opts.keepalive) init.keepalive = true
  try {
    return await fetch(apiUrl(path, opts.query), init)
  } catch (err) {
    throw new HearthApiError('network', `Could not reach the ${product()} server`, 0, err)
  }
}

/** One authenticated call whose answer is a file, not JSON. */
export async function requestBlob(path: string, opts: RequestOptions = {}): Promise<Blob> {
  const res = await send(path, opts)
  if (res.ok) return res.blob()
  if (res.status === 401) onUnauthorized?.()
  throw await toApiError(res)
}

/** One authenticated JSON call; the per-app clients (meetings.ts, calendar.ts) build on it. */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(path, opts)
  if (res.ok) {
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }
  if (res.status === 409 && opts.conflictIsResult) {
    const body: unknown = await res
      .clone()
      .json()
      .catch(() => null)
    if (isConflictResult(body)) return body as T
  }
  if (res.status === 401) onUnauthorized?.()
  throw await toApiError(res)
}

const spaceBase = (space: string) => `/api/spaces/${encodeURIComponent(space)}`

export const api = {
  health: () => request<Health>('/api/health'),
  brand: () => request<PublicBrand>('/api/org/brand'),
  me: () => request<Me>('/api/me'),
  desktopTicket: () => request<{ ticket: string }>('/api/desktop/ticket', { method: 'POST' }),

  tree: (space: string, dir: string) =>
    request<Entry[]>(`${spaceBase(space)}/tree`, { query: { dir } }),

  readFile: (space: string, path: string, ref?: string) =>
    request<FileContent>(`${spaceBase(space)}/file`, { query: { path, ref } }),

  putFile: (space: string, body: PutFileBody, opts: { keepalive?: boolean } = {}) =>
    request<CommitResult>(`${spaceBase(space)}/file`, {
      method: 'PUT',
      json: body,
      conflictIsResult: true,
      keepalive: opts.keepalive ?? false,
    }),

  deleteFile: (space: string, path: string) =>
    request<{ oid: string }>(`${spaceBase(space)}/file`, { method: 'DELETE', json: { path } }),

  move: (space: string, from: string, to: string) =>
    request<{ oid: string }>(`${spaceBase(space)}/move`, { method: 'POST', json: { from, to } }),

  shareToTeam: (space: string, path: string, toFolder: string) =>
    request<{ teamPath: string }>(`${spaceBase(space)}/share-to-team`, {
      method: 'POST',
      json: { path, toFolder },
    }),

  createFolder: (space: string, path: string) =>
    request<{ oid: string }>(`${spaceBase(space)}/folder`, { method: 'POST', json: { path } }),

  history: (space: string, path: string, limit?: number) =>
    request<Commit[]>(`${spaceBase(space)}/history`, { query: { path, limit } }),

  show: (space: string, oid: string, path: string) =>
    request<{ content: string }>(`${spaceBase(space)}/show`, { query: { oid, path } }),

  diff: (space: string, from: string, to: string, path: string) =>
    request<{ diff: string }>(`${spaceBase(space)}/diff`, { query: { from, to, path } }),

  restore: (space: string, oid: string, path: string) =>
    request<CommitResult>(`${spaceBase(space)}/restore`, {
      method: 'POST',
      json: { oid, path },
      conflictIsResult: true,
    }),

  conflicts: (space: string) => request<ConflictSummary[]>(`${spaceBase(space)}/conflicts`),

  conflict: (space: string, ref: string) =>
    request<ConflictDetail>(`${spaceBase(space)}/conflict`, { query: { ref } }),

  resolveConflict: (space: string, ref: string, content: string) =>
    request<CommitResult>(`${spaceBase(space)}/conflict/resolve`, {
      method: 'POST',
      json: { ref, content },
      conflictIsResult: true,
    }),

  uploadAsset: (space: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<{ path: string }>(`${spaceBase(space)}/assets`, { method: 'POST', form })
  },

  raw: async (space: string, path: string): Promise<Blob> => {
    const res = await send(`${spaceBase(space)}/raw`, { query: { path } })
    if (!res.ok) throw await toApiError(res)
    return res.blob()
  },

  search: (q: string, spaces: string[]) =>
    request<SearchResult[]>('/api/search', { query: { q, spaces: spaces.join(',') } }),

  recents: () => request<RecentItem[]>('/api/recents'),
  addRecent: (space: string, path: string) =>
    request<{ ok: boolean }>('/api/recents', { method: 'POST', json: { space, path } }),

  stars: () => request<StarItem[]>('/api/stars'),
  setStar: (space: string, path: string, starred: boolean) =>
    request<{ ok: boolean }>('/api/stars', { method: 'POST', json: { space, path, starred } }),
}
