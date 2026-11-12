// Uploads in progress, kept outside React so they carry on while the member moves around.

import { useSyncExternalStore } from 'react'
import { type DriveFile, uploadFile } from '../../api/files'
import { filesBus } from './bus'

export interface UploadItem {
  key: number
  name: string
  total: number
  sent: number
  status: 'uploading' | 'done' | 'failed' | 'cancelled'
  error?: string
  file?: DriveFile
  cancel: () => void
}

let items: UploadItem[] = []
let nextKey = 1
const listeners = new Set<() => void>()

function set(next: UploadItem[]): void {
  items = next
  for (const l of listeners) l()
}

function patch(key: number, p: Partial<UploadItem>): void {
  set(items.map((i) => (i.key === key ? { ...i, ...p } : i)))
}

/** Starts uploading each file into `target`; resolves with the ones that finished. */
export async function startUploads(
  files: Iterable<File>,
  target: { space: string; folder: string },
): Promise<DriveFile[]> {
  const jobs = [...files].map(async (file) => {
    const key = nextKey++
    const controller = new AbortController()
    set([
      ...items,
      {
        key,
        name: file.name,
        total: file.size,
        sent: 0,
        status: 'uploading',
        cancel: () => controller.abort(),
      },
    ])
    try {
      const stored = await uploadFile(file, target, {
        signal: controller.signal,
        onProgress: (p) => patch(key, { sent: p.sent }),
      })
      patch(key, { status: 'done', sent: file.size, file: stored })
      filesBus.emit({ type: 'changed' })
      return stored
    } catch (err) {
      const cancelled = controller.signal.aborted
      patch(key, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? 'Cancelled' : err instanceof Error ? err.message : 'Upload failed',
      })
      return null
    }
  })
  return (await Promise.all(jobs)).filter((f): f is DriveFile => f !== null)
}

/** Clears finished, failed and cancelled uploads from the tray. */
export function clearFinishedUploads(): void {
  set(items.filter((i) => i.status === 'uploading'))
}

export function useUploads(): UploadItem[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => items,
  )
}
