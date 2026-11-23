// Download a Doc as Word or PDF (docs/PLAN-doc-download.md). Everything heavy (the writers,
// remark, docx, pdfmake) is loaded here on first use, so the Docs chunk doesn't grow.

import { fileName } from './inputs'

export type DownloadFormat = 'docx' | 'pdf'

export interface DownloadSource {
  space: string
  path: string
  /** The text as it is in the editor now. */
  markdown: string
  title: string
  personalSpace: string | null
}

const TYPES: Record<DownloadFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
}

/** The file's bytes and name. */
export async function buildDownload(
  source: DownloadSource,
  format: DownloadFormat,
): Promise<{ blob: Blob; name: string }> {
  const { prepareDownload } = await import('./prepare')
  const { model, inputs } = await prepareDownload(source)
  const blob =
    format === 'docx'
      ? await (await import('./toDocx')).toDocx(model, inputs)
      : await (await import('./toPdf')).toPdf(model, inputs)
  return { blob: new Blob([blob], { type: TYPES[format] }), name: fileName(source.title, format) }
}

interface SaveHandler {
  postMessage: (body: unknown) => void
}

/** The Mac app's save window (apps/dictate-mac SuiteWindow, `hotsauceSaveFile`). */
function macSave(): SaveHandler | null {
  const w = window as { webkit?: { messageHandlers?: Record<string, SaveHandler | undefined> } }
  return w.webkit?.messageHandlers?.hotsauceSaveFile ?? null
}

export async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

/** Hands the file over: the Mac app's save window there, the browser's download elsewhere. */
export async function saveFile(blob: Blob, name: string): Promise<void> {
  const mac = macSave()
  if (mac) {
    mac.postMessage({ name, base64: await base64Of(blob) })
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
  // Give the browser a moment to start the download before the bytes go.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export async function downloadDoc(source: DownloadSource, format: DownloadFormat): Promise<string> {
  const { blob, name } = await buildDownload(source, format)
  await saveFile(blob, name)
  return name
}

/** Builds and saves the file, saying how it went in the app's notice line. */
export async function downloadWithNotice(
  source: DownloadSource,
  format: DownloadFormat,
  notify: (message: string) => void,
): Promise<void> {
  const label = format === 'docx' ? 'Word' : 'PDF'
  // The file makers load on first use, and the brand's fonts and images come from the server.
  if (!navigator.onLine) return notify(`Making a ${label} file needs a connection.`)
  notify(`Making the ${label} file…`)
  try {
    const name = await downloadDoc(source, format)
    // The Mac app says where the file went itself.
    if (!macSave()) notify(`Downloaded ${name}.`)
  } catch {
    notify(`Couldn’t make the ${label} file. Try again in a moment.`)
  }
}

/**
 * What the Mac app's File → Export… (⌘⇧E) calls on the open doc. Null when no doc is open, so the
 * menu can say so.
 */
export interface MacDocExport {
  title: () => string
  build: (format: DownloadFormat) => Promise<{ name: string; base64: string }>
}

declare global {
  interface Window {
    hotsauceDocExport?: MacDocExport | undefined
  }
}

/** Offers the open doc to the Mac app's Export… menu until the returned function is called. */
export function offerToMacExport(get: () => DownloadSource): () => void {
  const offer: MacDocExport = {
    title: () => get().title,
    build: async (format) => {
      const { blob, name } = await buildDownload(get(), format)
      return { name, base64: await base64Of(blob) }
    },
  }
  window.hotsauceDocExport = offer
  return () => {
    if (window.hotsauceDocExport === offer) window.hotsauceDocExport = undefined
  }
}
