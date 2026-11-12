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
  if (isTaskFile(path)) return taskUrl(space, path)
  if (isNoteFile(path)) return noteUrl(space, path)
  if (isBoardFile(path)) return boardUrl(space, path)
  if (isDriveFile(path)) return driveFileUrl(space, path)
  const form = formFileUrl(space, path)
  if (form) return form
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

/** A task's file, `tasks/<id>.md` (ARCHITECTURE §12.1). */
export function isTaskFile(path: string): boolean {
  return /^tasks\/[^/]+\.md$/i.test(path)
}

/** The app URL for a task: its list with the detail panel open. */
export function taskUrl(space: string, path: string): string {
  const id = basename(path).replace(/\.md$/i, '')
  return `/tasks/item/${encodeURIComponent(space)}/${encodeURIComponent(id)}`
}

/** A note's file, `notes/<id>.md` (ARCHITECTURE §14.1). */
export function isNoteFile(path: string): boolean {
  return /^notes\/[^/]+\.md$/i.test(path)
}

/** The app URL for a note: the board with that note open. */
export function noteUrl(space: string, path: string): string {
  const id = basename(path).replace(/\.md$/i, '')
  return `/notes/item/${encodeURIComponent(space)}/${encodeURIComponent(id)}`
}

/** A Hearth Files pointer, `files/<id>.md` (ARCHITECTURE §18.1). */
/** A form opens in Forms, an answer on its form's Answers tab (ARCHITECTURE §21); else null. */
export function formFileUrl(space: string, path: string): string | null {
  const m = /^forms\/([0-9A-Z]{26})(?:\/([0-9A-Z]{26}))?\.md$/.exec(path)
  if (!m) return null
  const base = `/forms/${encodeURIComponent(space)}/${m[1]}`
  return m[2] ? `${base}/answers?answer=${m[2]}` : base
}

export function isDriveFile(path: string): boolean {
  return /^files\/[0-9A-Z]{26}\.md$/.test(path)
}

/** Where Hearth Files opens the file a pointer stands for. */
export function driveFileUrl(space: string, path: string): string {
  const id = basename(path).replace(/\.md$/i, '')
  return `/files/${encodeURIComponent(space)}/${encodeURIComponent(id)}`
}

/** The app URL for a meeting note (or any file opened from Hearth Meetings). */
export function meetingUrl(space: string, path: string): string {
  return `/meetings/${encodeURIComponent(space)}/${encodePath(path)}`
}

/** The files Docs can import (lib/importDoc.ts), for the file picker. */
export const IMPORT_ACCEPT = '.md,.markdown,.txt,.docx,.html,.htm'

/** A whiteboard's file, `boards/<id>.md` (ARCHITECTURE §15.1). */
export function isBoardFile(path: string): boolean {
  return /^boards\/[0-9A-Z]{26}\.md$/.test(path)
}

/** The app URL for a whiteboard. */
export function boardUrl(space: string, path: string): string {
  const id = basename(path).replace(/\.md$/i, '')
  return `/boards/${encodeURIComponent(space)}/${encodeURIComponent(id)}`
}
