export const DOCS_ROOT = 'docs'

export function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function joinPath(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join('/')
}

export function isMarkdown(path: string): boolean {
  return /\.md$/i.test(path)
}

/** File name without the `.md` extension, as shown in the tree. */
export function displayName(path: string): string {
  return basename(path).replace(/\.md$/i, '')
}

export function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')
}

/** What a file under `meetings/` is (ARCHITECTURE §7.1), or null for anything else. */
export function meetingFileKind(path: string): 'meeting' | 'transcript' | null {
  if (!path.startsWith('meetings/') || !/\.md$/i.test(path)) return null
  return /\.transcript\.md$/i.test(path) ? 'transcript' : 'meeting'
}

/**
 * Where a search result or recent opens: a meeting note on its meeting page (with its transcript
 * and chat), a transcript on its note's page, anything else in Docs.
 */
export function fileUrl(space: string, path: string): string {
  const kind = meetingFileKind(path)
  if (kind === 'meeting') return meetingUrl(space, path)
  if (kind === 'transcript') return meetingUrl(space, path.replace(/\.transcript\.md$/i, '.md'))
  return docUrl(space, path)
}

/** Schemes a link in a doc may open; `javascript:`, `data:` and the rest never do. */
const OPENABLE = /^(https?:|mailto:)/i

/**
 * Opens an external link in a new tab when its scheme is safe, and says whether it did. A
 * `javascript:` link opened this way would run in a blank page that shares Hearth's origin.
 */
export function openExternal(href: string): boolean {
  const target = href.trim()
  const url = target.startsWith('//') ? `https:${target}` : target
  if (!OPENABLE.test(url)) return false
  window.open(url, '_blank', 'noopener,noreferrer')
  return true
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

/** The app URL for a document. */
export function docUrl(space: string, path: string): string {
  return `/docs/${encodeURIComponent(space)}/${encodePath(path)}`
}

/** The app URL for a meeting note (or any file opened from Hearth Meetings). */
export function meetingUrl(space: string, path: string): string {
  return `/meetings/${encodeURIComponent(space)}/${encodePath(path)}`
}
