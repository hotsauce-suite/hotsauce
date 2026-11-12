import { resolveRelative } from '@hearth/format'
import { api } from '../api/client'
import { isBoardFile, isExternalHref } from './paths'

/**
 * Loadable URLs for the images in one open document. An `<img src>` can't carry the dev header
 * or a bearer token, so repo images are fetched through the API client and shown as object URLs.
 * The document view owns one of these and calls `release()` when it unmounts, so the blobs don't
 * outlive the doc. After a release it starts afresh, which keeps it usable under StrictMode's
 * mount, unmount, mount.
 */
export class ImageUrls {
  readonly #space: string
  readonly #docPath: string
  readonly #byPath = new Map<string, Promise<string>>()
  readonly #created = new Set<string>()

  constructor(space: string, docPath: string) {
    this.#space = space
    this.#docPath = docPath
  }

  /** `src` as written in the doc: relative to it, or an external URL (returned as is). */
  resolve(src: string): Promise<string> {
    if (isExternalHref(src)) return Promise.resolve(src)
    const repoPath = resolveRelative(this.#docPath, src)
    let url = this.#byPath.get(repoPath)
    if (!url && isBoardFile(repoPath)) {
      // A whiteboard embedded in a doc shows as a picture of the board.
      url = import('../apps/boards/boardPreview').then((m) =>
        m.boardPreviewUrl(this.#space, repoPath),
      )
      url.catch(() => this.#byPath.delete(repoPath))
      this.#byPath.set(repoPath, url)
    }
    if (!url) {
      url = api.raw(this.#space, repoPath).then(async (blob) => {
        if (isSvg(blob, repoPath)) return svgDataUrl(blob)
        const objectUrl = URL.createObjectURL(safeImageBlob(blob))
        this.#created.add(objectUrl)
        return objectUrl
      })
      // A failed load is retried the next time the image renders.
      url.catch(() => this.#byPath.delete(repoPath))
      this.#byPath.set(repoPath, url)
    }
    return url
  }

  release(): void {
    for (const url of this.#created) URL.revokeObjectURL(url)
    this.#created.clear()
    this.#byPath.clear()
  }
}

// A blob URL is a document in Hearth's own origin when opened in a tab ("Open image in new tab"),
// and the repo's `/raw` sandbox header doesn't come with it. So only raster images become blob
// URLs; an SVG (which can carry script) becomes a data: URL, which browsers refuse to open as a
// top-level page and give an opaque origin anywhere else; anything else can't render as a page.
const RASTER = /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/i

function isSvg(blob: Blob, path: string): boolean {
  return /svg/i.test(blob.type) || /\.svgz?$/i.test(path)
}

/** The blob as is when it's a raster image; otherwise re-typed so it can't render as a page. */
export function safeImageBlob(blob: Blob): Blob {
  return RASTER.test(blob.type) ? blob : new Blob([blob], { type: 'application/octet-stream' })
}

async function svgDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:image/svg+xml;base64,${btoa(binary)}`
}
