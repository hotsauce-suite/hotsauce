// Client for `/api/files` (ARCHITECTURE §18.2): Hearth Files.

import type { PreviewKind } from '@hearth/format'
import { HearthApiError, request } from './client'

export interface DriveFile {
  id: string
  space: string
  path: string
  name: string
  folder: string
  size: number
  mime: string
  sha256: string
  preview: PreviewKind
  createdAt: string
  createdBy: string
  updatedAt: string
  textStatus: 'extracted' | 'none' | 'failed'
  shareToken: string | null
  blobOid: string
  /** Where Hearth opens it. */
  url: string
  /** Short-lived URLs for the bytes (shown in the browser, or downloaded). */
  contentUrl: string
  downloadUrl: string
  shareUrl: string | null
}

/** What someone opening a share link sees: the file only, not where it lives. */
export interface SharedFile {
  id: string
  name: string
  size: number
  mime: string
  preview: PreviewKind
  createdAt: string
  createdBy: string
  updatedAt: string
  contentUrl: string
  downloadUrl: string
}

export interface FolderListing {
  space: string
  folder: string
  folders: string[]
  files: DriveFile[]
}

export interface FilesConfig {
  available: boolean
  chunkBytes: number
  maxBytes: number
}

const BASE = '/api/files'
const item = (space: string, id: string) =>
  `${BASE}/item/${encodeURIComponent(space)}/${encodeURIComponent(id)}`

export const filesApi = {
  config: () => request<FilesConfig>(`${BASE}/config`),
  list: (space: string, folder = '', q?: string) =>
    request<FolderListing>(BASE, { query: { space, folder, q: q?.trim() || undefined } }),
  recent: async () => (await request<{ files: DriveFile[] }>(`${BASE}/recent`)).files ?? [],
  get: (space: string, id: string) => request<DriveFile>(item(space, id)),
  text: (space: string, id: string) =>
    request<DriveFile & { text: string }>(item(space, id), { query: { text: 1 } }),
  shared: (token: string) => request<SharedFile>(`${BASE}/shared/${encodeURIComponent(token)}`),
  update: (space: string, id: string, patch: { name?: string; folder?: string }) =>
    request<DriveFile>(item(space, id), { method: 'PATCH', json: patch }),
  share: (space: string, id: string, on: boolean) =>
    request<DriveFile>(`${item(space, id)}/share`, { method: 'POST', json: { on } }),
  move: (space: string, id: string, to: string) =>
    request<DriveFile>(`${item(space, id)}/move`, { method: 'POST', json: { to } }),
  remove: (space: string, id: string) => request<void>(item(space, id), { method: 'DELETE' }),
  createFolder: (space: string, folder: string) =>
    request<{ folder: string }>(`${BASE}/folders`, { method: 'POST', json: { space, folder } }),
  renameFolder: (space: string, from: string, to: string) =>
    request<{ folder: string }>(`${BASE}/folders`, { method: 'PATCH', json: { space, from, to } }),
  removeFolder: (space: string, folder: string) =>
    request<void>(`${BASE}/folders`, { method: 'DELETE', json: { space, folder } }),
}

export interface UploadProgress {
  sent: number
  total: number
}

/**
 * Uploads one file in chunks (8 MB, as the server says), two at a time, retrying a chunk up to
 * three times. Resolves with the stored file; `signal` cancels and discards the upload.
 */
export async function uploadFile(
  file: Blob & { name: string },
  target: { space: string; folder: string },
  opts: { onProgress?: (p: UploadProgress) => void; signal?: AbortSignal } = {},
): Promise<DriveFile> {
  const started = await request<{ id: string; chunkBytes: number; chunks: number }>(
    `${BASE}/uploads`,
    {
      method: 'POST',
      json: { ...target, name: file.name, size: file.size, mime: file.type || undefined },
    },
  )
  const url = `${BASE}/uploads/${started.id}`
  let sent = 0
  opts.onProgress?.({ sent, total: file.size })
  const queue = Array.from({ length: started.chunks }, (_, i) => i)
  const worker = async () => {
    for (let seq = queue.shift(); seq !== undefined; seq = queue.shift()) {
      if (opts.signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
      const part = file.slice(seq * started.chunkBytes, (seq + 1) * started.chunkBytes)
      for (let attempt = 1; ; attempt++) {
        try {
          await request<void>(`${url}/chunks/${seq}`, { method: 'PUT', body: part })
          break
        } catch (err) {
          const retryable = err instanceof HearthApiError && (err.status === 0 || err.status >= 500)
          if (!retryable || attempt >= 3) throw err
          await new Promise((r) => setTimeout(r, 500 * attempt))
        }
      }
      sent += part.size
      opts.onProgress?.({ sent, total: file.size })
    }
  }
  try {
    await Promise.all([worker(), worker()])
    if (opts.signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    // Finishing a big file can take a while; a retry joins the same work on the server.
    for (let attempt = 1; ; attempt++) {
      try {
        return await request<DriveFile>(`${url}/complete`, { method: 'POST', json: {} })
      } catch (err) {
        const retryable = err instanceof HearthApiError && (err.status === 0 || err.status >= 500)
        if (!retryable || attempt >= 4) throw err
        await new Promise((r) => setTimeout(r, 1000 * attempt))
      }
    }
  } catch (err) {
    void request<void>(url, { method: 'DELETE' }).catch(() => {})
    throw err
  }
}

/** "1.2 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`
}
