// Hearth Notes (ARCHITECTURE §14): a Keep-style board. One note per Markdown file,
// `notes/<id>.md`, its card settings in frontmatter and its text as the body. A checklist is a
// body made only of `- [ ]` / `- [x]` lines. Everything here is pure.

import { z } from 'zod'
import { patchFrontmatter } from './frontmatter.js'
import { isId, newId } from './ids.js'

export const NOTES_FOLDER = 'notes'

/** Keep's twelve card colors; absent is the default (no color). */
export const NOTE_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'darkblue',
  'purple',
  'pink',
  'brown',
  'gray',
] as const
export type NoteColor = (typeof NOTE_COLORS)[number]

/** `notes/<id>.md`. */
export function notePath(id: string): string {
  return `${NOTES_FOLDER}/${id}.md`
}

/** The id of a note file, or null when the path isn't `notes/<id>.md`. */
export function noteIdOf(path: string): string | null {
  const match = /^notes\/([0-9A-Z]{26})\.md$/.exec(path)
  return match?.[1] && isId(match[1]) ? match[1] : null
}

export const NoteSource = z.looseObject({
  kind: z.enum(['manual', 'import', 'mcp']),
  /** For `import`: where from (`keep`), and its name there. */
  from: z.string().optional(),
  ref: z.string().optional(),
})
export type NoteSource = z.infer<typeof NoteSource>

function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => v ?? undefined, schema.optional())
}

/** Unknown keys pass through untouched. An unknown color reads as the default. */
export const NoteFrontmatter = z.looseObject({
  id: z.string().min(1),
  type: z.literal('note'),
  title: optional(z.string()),
  color: z.preprocess(
    (v) =>
      typeof v === 'string' && (NOTE_COLORS as readonly string[]).includes(v) ? v : undefined,
    z.enum(NOTE_COLORS).optional(),
  ),
  pinned: optional(z.boolean()),
  archived: optional(z.boolean()),
  /** ISO instant it went to the trash. */
  trashed: optional(z.string()),
  labels: optional(z.array(z.string())),
  created: z.string(),
  created_by: z.string(),
  updated: optional(z.string()),
  /** Manual position on the board; higher first. Absent sorts by `created`. */
  order: optional(z.number()),
  source: optional(NoteSource),
})
export type NoteFrontmatter = z.infer<typeof NoteFrontmatter>

export interface NewNote {
  title?: string | undefined
  body?: string | undefined
  color?: NoteColor | undefined
  pinned?: boolean | undefined
  archived?: boolean | undefined
  labels?: string[] | undefined
  order?: number | undefined
  source?: NoteSource | undefined
  createdBy: string
  /** ISO instants; default now. */
  created?: string | undefined
  updated?: string | undefined
  id?: string | undefined
}

/** A note file's text and path. Empty optional fields are left out. */
export function newNoteFile(note: NewNote): { id: string; path: string; text: string } {
  const id = note.id ?? newId()
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const created = note.created ?? now
  const labels = cleanLabels(note.labels ?? [])
  const fields: Record<string, unknown> = {
    id,
    type: 'note',
    title: noteTitle(note.title ?? '') || undefined,
    color: note.color,
    pinned: note.pinned || undefined,
    archived: note.archived || undefined,
    labels: labels.length > 0 ? labels : undefined,
    created,
    created_by: note.createdBy.toLowerCase(),
    updated: note.updated ?? created,
    order: note.order,
    source: note.source,
  }
  return { id, path: notePath(id), text: patchFrontmatter(noteBodyText(note.body ?? ''), fields) }
}

/** A title is one line. */
export function noteTitle(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Labels trimmed, de-duplicated (case-insensitively, first spelling wins), empty ones dropped. */
export function cleanLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of labels) {
    const l = raw.replace(/\s+/g, ' ').trim()
    if (!l || seen.has(l.toLowerCase())) continue
    seen.add(l.toLowerCase())
    out.push(l)
  }
  return out
}

/** The note's text from a file body: without the blank line after the frontmatter or trailing space. */
export function noteTextOf(body: string): string {
  return body.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '')
}

/** The file body for a note's text: a blank line after the frontmatter, a final newline. */
export function noteBodyText(text: string): string {
  const trimmed = noteTextOf(text)
  return trimmed ? `\n${trimmed}\n` : '\n'
}

// ---------------------------------------------------------------------------------------------
// Checklists

export interface ChecklistItem {
  text: string
  checked: boolean
}

const ITEM = /^\s*[-*+]\s+\[( |x|X)\]\s?(.*)$/

/** The items of a checklist note, or null when the text isn't only checklist lines (or is empty). */
export function parseChecklist(text: string): ChecklistItem[] | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0) return null
  const items: ChecklistItem[] = []
  for (const line of lines) {
    const m = ITEM.exec(line)
    if (!m) return null
    items.push({ checked: m[1] !== ' ', text: (m[2] ?? '').trim() })
  }
  return items
}

export function isChecklist(text: string): boolean {
  return parseChecklist(text) !== null
}

/** A checklist's text: one `- [ ]` line per item, an item's text kept to one line. */
export function checklistText(items: readonly ChecklistItem[]): string {
  return items
    .map((i) => `- [${i.checked ? 'x' : ' '}] ${i.text.replace(/\s+/g, ' ').trim()}`.trimEnd())
    .join('\n')
}

/** Text to a checklist: each non-blank line an unchecked item (list markers dropped). */
export function textToChecklist(text: string): ChecklistItem[] {
  const already = parseChecklist(text)
  if (already) return already
  return text
    .split(/\r?\n/)
    .map((l) => {
      const m = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\[([ xX])\]\s+)?(.*)$/.exec(l)
      return { text: (m?.[2] ?? l).trim(), checked: m?.[1] !== undefined && m[1] !== ' ' }
    })
    .filter((i) => i.text !== '')
}

/** A checklist to plain text: one item per line, ticks dropped. */
export function checklistToText(items: readonly ChecklistItem[]): string {
  return items.map((i) => i.text).join('\n')
}

/** Ticks or unticks the item at `index` (0-based among items); other lines keep their text. */
export function toggleChecklistItem(text: string, index: number, checked: boolean): string {
  const lines = text.split('\n')
  let n = -1
  return lines
    .map((line) => {
      if (!ITEM.test(line)) return line
      n++
      if (n !== index) return line
      return line.replace(/\[( |x|X)\]/, checked ? '[x]' : '[ ]')
    })
    .join('\n')
}

/** A card's preview: the first lines of the text, at most `max` characters. */
export function notePreview(text: string, max = 400): string {
  const t = noteTextOf(text)
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t
}

// ---------------------------------------------------------------------------------------------
// Google Keep import (a Takeout export: one JSON file per note in `Takeout/Keep/`)

/** The parts of a Keep Takeout note this import reads. Anything else is ignored. */
export const KeepNote = z.looseObject({
  title: z.string().optional(),
  textContent: z.string().optional(),
  listContent: z
    .array(z.looseObject({ text: z.string().optional(), isChecked: z.boolean().optional() }))
    .optional(),
  color: z.string().optional(),
  isPinned: z.boolean().optional(),
  isArchived: z.boolean().optional(),
  isTrashed: z.boolean().optional(),
  labels: z.array(z.looseObject({ name: z.string() })).optional(),
  attachments: z.array(z.unknown()).optional(),
  annotations: z
    .array(z.looseObject({ url: z.string().optional(), title: z.string().optional() }))
    .optional(),
  createdTimestampUsec: z.union([z.number(), z.string()]).optional(),
  userEditedTimestampUsec: z.union([z.number(), z.string()]).optional(),
})
export type KeepNote = z.infer<typeof KeepNote>

const KEEP_COLORS: Record<string, NoteColor> = {
  RED: 'red',
  ORANGE: 'orange',
  YELLOW: 'yellow',
  GREEN: 'green',
  TEAL: 'teal',
  BLUE: 'blue',
  CERULEAN: 'darkblue',
  DARK_BLUE: 'darkblue',
  PURPLE: 'purple',
  PINK: 'pink',
  BROWN: 'brown',
  GRAY: 'gray',
  GREY: 'gray',
}

/** A Keep color name (`RED`, `CERULEAN`...) to ours; the default and anything unknown is none. */
export function keepColor(name: string | undefined): NoteColor | undefined {
  return name ? KEEP_COLORS[name.toUpperCase()] : undefined
}

function usecToIso(v: number | string | undefined): string | undefined {
  const n = typeof v === 'string' ? Number(v) : v
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined
  const d = new Date(Math.floor(n / 1000))
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * A Keep note as a new Hearth note, or null when it should be skipped (trashed in Keep, or with
 * nothing in it). `ref` identifies it for idempotent re-imports (the Takeout file name).
 */
export function mapKeepNote(keep: KeepNote, ref: string): Omit<NewNote, 'createdBy'> | null {
  if (keep.isTrashed) return null
  let body: string
  if (keep.listContent && keep.listContent.length > 0) {
    body = checklistText(
      keep.listContent
        .map((i) => ({ text: (i.text ?? '').replace(/\s+/g, ' ').trim(), checked: !!i.isChecked }))
        .filter((i) => i.text !== ''),
    )
  } else {
    body = (keep.textContent ?? '').replace(/\r\n/g, '\n')
  }
  const extras: string[] = []
  for (const a of keep.annotations ?? []) {
    if (a.url) extras.push(a.title ? `[${a.title}](${a.url})` : a.url)
  }
  const attachments = keep.attachments?.length ?? 0
  if (attachments > 0) {
    extras.push(`_Had ${attachments} attachment${attachments === 1 ? '' : 's'} in Google Keep._`)
  }
  const title = noteTitle(keep.title ?? '')
  const text = noteTextOf(body)
  if (!title && !text && extras.length === 0) return null
  const fullBody = [text, extras.join('\n')].filter((s) => s !== '').join('\n\n')
  const created = usecToIso(keep.createdTimestampUsec)
  const updated = usecToIso(keep.userEditedTimestampUsec) ?? created
  return {
    title: title || undefined,
    body: fullBody,
    color: keepColor(keep.color),
    pinned: keep.isPinned || undefined,
    archived: keep.isArchived || undefined,
    labels: cleanLabels((keep.labels ?? []).map((l) => l.name)),
    created,
    updated,
    source: { kind: 'import', from: 'keep', ref },
  }
}
