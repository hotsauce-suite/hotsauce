// Hearth Files (ARCHITECTURE §18): one pointer file per stored file, `files/<id>.md`. The bytes
// live in object storage under `key`; the frontmatter says what they are and where they sit;
// the body is the text pulled out of them, so search reads it like any other file. Pure.

import { z } from 'zod'
import { patchFrontmatter } from './frontmatter.js'
import { isId, newId } from './ids.js'

export const FILES_FOLDER = 'files'
/** Folders made with "New folder" that hold nothing yet, so they survive a reload. */
export const FILES_FOLDERS_PATH = '.hearth/files/folders.json'
/** Text kept from one file; the rest is cut (search still finds the start of a long PDF). */
export const MAX_FILE_TEXT_CHARS = 200_000
export const MAX_FILE_NAME_CHARS = 200
export const MAX_FOLDER_DEPTH = 10

/** `files/<id>.md`. */
export function filePointerPath(id: string): string {
  return `${FILES_FOLDER}/${id}.md`
}

/** The id of a pointer file, or null when the path isn't `files/<id>.md`. */
export function fileIdOf(path: string): string | null {
  const match = /^files\/([0-9A-Z]{26})\.md$/.exec(path)
  return match?.[1] && isId(match[1]) ? match[1] : null
}

/** Where a file's bytes go in the object store. */
export function fileStoreKey(id: string): string {
  return `files/${id}`
}

function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => v ?? undefined, schema.optional())
}

export const FileFrontmatter = z.looseObject({
  id: z.string().min(1),
  type: z.literal('file'),
  /** The file's name, extension included. */
  title: z.preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string().min(1)),
  folder: z.preprocess((v) => (typeof v === 'string' ? cleanFolder(v) : ''), z.string()),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mime: z.string().min(1),
  key: z.string().min(1),
  created: z.string(),
  created_by: z.string(),
  updated: optional(z.string()),
  /** A share link's token: any signed-in member who has it may open this one file. */
  share: optional(z.string().regex(/^[A-Za-z0-9_-]{16,64}$/)),
  text: z.preprocess(
    (v) => (v === 'extracted' || v === 'failed' ? v : 'none'),
    z.enum(['extracted', 'none', 'failed']),
  ),
})
export type FileFrontmatter = z.infer<typeof FileFrontmatter>

export interface NewFilePointer {
  id?: string
  name: string
  folder: string
  size: number
  sha256: string
  mime: string
  createdBy: string
  created?: string
  text: string | null
  textStatus: 'extracted' | 'none' | 'failed'
}

/** A pointer file's path and text. */
export function newFilePointer(p: NewFilePointer): { id: string; path: string; text: string } {
  const id = p.id ?? newId()
  const now = p.created ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const fields: Record<string, unknown> = {
    id,
    type: 'file',
    title: cleanFileName(p.name),
    folder: cleanFolder(p.folder),
    size: p.size,
    sha256: p.sha256,
    mime: p.mime,
    key: fileStoreKey(id),
    created: now,
    created_by: p.createdBy.toLowerCase(),
    updated: now,
    text: p.textStatus,
  }
  return { id, path: filePointerPath(id), text: patchFrontmatter(fileBodyText(p.text), fields) }
}

/** The pointer body for extracted text: cut to the limit, a blank line first, a final newline. */
export function fileBodyText(text: string | null): string {
  const t = (text ?? '').replace(/\r\n?/g, '\n').replaceAll(String.fromCharCode(0), '').trim()
  if (!t) return '\n'
  const cut = t.length > MAX_FILE_TEXT_CHARS ? t.slice(0, MAX_FILE_TEXT_CHARS) : t
  return `\n${cut}\n`
}

/** A name with no path separators, control characters or surrounding space; never empty. */
export function cleanFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  const cleaned = withoutControls(base).replace(/\s+/g, ' ').trim().slice(0, MAX_FILE_NAME_CHARS)
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'Untitled' : cleaned
}

/** `" a / b//c "` → `"a/b/c"`; empty, `.` and `..` segments dropped; at most 10 deep. */
export function cleanFolder(folder: string): string {
  return folder
    .split(/[/\\]/)
    .map((s) => withoutControls(s).replace(/\s+/g, ' ').trim().slice(0, MAX_FILE_NAME_CHARS))
    .filter((s) => s !== '' && s !== '.' && s !== '..')
    .slice(0, MAX_FOLDER_DEPTH)
    .join('/')
}

/** `"a/b/c"` → `["a", "a/b", "a/b/c"]`. */
export function folderAncestors(folder: string): string[] {
  const parts = cleanFolder(folder).split('/').filter(Boolean)
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
}

/** True when `folder` is `parent` or inside it (`""` contains everything). */
export function isInFolder(folder: string, parent: string): boolean {
  return parent === '' || folder === parent || folder.startsWith(`${parent}/`)
}

const BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
}

/** The file's extension, lowercase, without the dot; '' when it has none. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** A type from the name, else the browser's claim if it's well formed, else octet-stream. */
export function fileMimeType(name: string, claimed?: string): string {
  const byExt = BY_EXT[fileExtension(name)]
  if (byExt) return byExt
  if (claimed && /^[a-z]+\/[a-z0-9.+-]+$/i.test(claimed)) return claimed.toLowerCase()
  return 'application/octet-stream'
}

export type PreviewKind = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'none'

const INLINE_IMAGES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
])
const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json'])

/**
 * How the browser shows a file. Only known-safe image types render; SVG, HTML and anything
 * unknown never do (they could run script). Parameters (`;charset=...`) and case are ignored.
 */
export function previewKind(mime: string): PreviewKind {
  const essence = (mime.split(';')[0] ?? '').trim().toLowerCase()
  if (INLINE_IMAGES.has(essence)) return 'image'
  if (essence === 'application/pdf') return 'pdf'
  if (essence.startsWith('video/')) return 'video'
  if (essence.startsWith('audio/')) return 'audio'
  if (TEXT_TYPES.has(essence)) return 'text'
  return 'none'
}

/** The text without ASCII control characters (tabs and newlines included). */
function withoutControls(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.charCodeAt(0)
    if (c >= 0x20 && c !== 0x7f) out += ch
  }
  return out
}
