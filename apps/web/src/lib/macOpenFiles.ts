// Files dropped on the Mac app's icon (docs/PLAN-pdf-tools.md R10). The app has no sign-in of its
// own, so it hands the files to the signed-in page in its window:
// `window.hotsauceMac.openFiles([{name, base64}])`. The page uploads them to the member's Personal
// files and says where to go: a PDF opens in PDF tools (several open together on Pages), anything
// else shows Personal files.

import type { DriveFile } from '../api/files'

/** Above any PDF someone drops; the page holds a few copies while it uploads. */
export const MAX_DROPPED_BYTES = 100 * 1024 * 1024
export const MAX_DROPPED_FILES = 20

export type OpenFilesAnswer =
  | { ok: true; opened: number; path: string }
  | { ok: false; error: string }

export interface OpenFilesDeps {
  personalSpace: () => Promise<string | null>
  upload: (
    file: Blob & { name: string },
    target: { space: string; folder: string },
  ) => Promise<DriveFile>
}

function decode(base64: string): Uint8Array | null {
  let binary: string
  try {
    binary = atob(base64)
  } catch {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** A safe file name, whatever the app sent. */
export function droppedName(name: unknown): string {
  const base = (typeof name === 'string' ? name : '').replace(/[\\/]/g, ' ').trim().slice(0, 200)
  return base || 'Dropped file'
}

const isPdfBytes = (b: Uint8Array) =>
  b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46

/** Uploads what the app sent and answers with the page to open. */
export async function openDroppedFiles(
  deps: OpenFilesDeps,
  files: unknown,
): Promise<OpenFilesAnswer> {
  const space = await deps.personalSpace().catch(() => null)
  if (!space) return { ok: false, error: 'Sign in to Hotsauce to add files.' }
  if (!Array.isArray(files) || files.length === 0)
    return { ok: false, error: 'No files came through.' }
  if (files.length > MAX_DROPPED_FILES) {
    return { ok: false, error: `Drop up to ${MAX_DROPPED_FILES} files at a time.` }
  }
  const items: Array<{ name: string; bytes: Uint8Array; pdf: boolean }> = []
  for (const f of files) {
    const raw = (f as { name?: unknown; base64?: unknown }) ?? {}
    if (typeof raw.base64 !== 'string' || raw.base64.length > MAX_DROPPED_BYTES * 1.4) {
      return {
        ok: false,
        error: 'One of those files is too large to add from here. Use Upload in Files.',
      }
    }
    const bytes = decode(raw.base64)
    if (!bytes || bytes.length > MAX_DROPPED_BYTES) {
      return { ok: false, error: 'One of those files couldn’t be read.' }
    }
    const name = droppedName(raw.name)
    const pdf = isPdfBytes(bytes) && /\.pdf$/i.test(name)
    items.push({ name, bytes, pdf })
  }
  try {
    const stored: Array<{ file: DriveFile; pdf: boolean }> = []
    for (const item of items) {
      const blob = Object.assign(
        new Blob([item.bytes as BlobPart], { type: item.pdf ? 'application/pdf' : '' }),
        { name: item.name },
      )
      stored.push({ file: await deps.upload(blob, { space, folder: '' }), pdf: item.pdf })
    }
    const pdfs = stored.filter((s) => s.pdf).map((s) => s.file)
    const [first, ...rest] = pdfs
    let path = `/files?space=${encodeURIComponent(space)}`
    if (first) {
      const more = rest.length ? `&with=${rest.map((f) => f.id).join(',')}` : ''
      path = `${first.url}?tools=pages${more}`
    }
    return { ok: true, opened: stored.length, path }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error && err.message ? err.message : 'Couldn’t add those files.',
    }
  }
}

interface MacHooks {
  openFiles?: (files: unknown) => Promise<OpenFilesAnswer>
}

/** Puts the function where the Mac app looks for it; the returned function takes it away. */
export function installMacOpenFiles(
  deps: () => OpenFilesDeps,
  go: (path: string) => void,
): () => void {
  const w = window as { hotsauceMac?: MacHooks }
  const hooks = w.hotsauceMac ?? {}
  w.hotsauceMac = hooks
  const fn = async (files: unknown) => {
    const answer = await openDroppedFiles(deps(), files)
    if (answer.ok) go(answer.path)
    return answer
  }
  hooks.openFiles = fn
  return () => {
    if (hooks.openFiles === fn) delete hooks.openFiles
  }
}
