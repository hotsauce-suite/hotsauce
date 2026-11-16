// Highlights and notes in saved links (docs/PLAN-links-highlights.md): a `highlights` list in the
// link file's frontmatter, so they travel with the link and are kept in its history.
// Everything here is pure.

import { z } from 'zod'
import { newId } from './ids.js'

/** The most highlights one link keeps. */
export const MAX_HIGHLIGHTS = 500
/** The longest highlighted passage, in characters. */
export const MAX_HIGHLIGHT_QUOTE = 2000
/** The longest note on a highlight, in characters. */
export const MAX_HIGHLIGHT_NOTE = 5000
/** Characters kept on each side of a passage to find it again. */
export const HIGHLIGHT_CONTEXT = 32

export const LinkHighlight = z.looseObject({
  id: z.string().min(1),
  /** The member who made it, lower case. */
  by: z.string().min(1),
  at: z.string().min(1),
  quote: z.string().min(1),
  prefix: z.preprocess((v) => (typeof v === 'string' ? v : undefined), z.string().optional()),
  suffix: z.preprocess((v) => (typeof v === 'string' ? v : undefined), z.string().optional()),
  /** The top-level block of the readable copy it starts in, from 0. */
  block: z.preprocess(
    (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined),
    z.number().optional(),
  ),
  note: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() ? v : undefined),
    z.string().optional(),
  ),
  edited: z.preprocess((v) => (typeof v === 'string' ? v : undefined), z.string().optional()),
})
export type LinkHighlight = z.infer<typeof LinkHighlight>

/** The highlights in a link's frontmatter that parse, in the file's order (oldest first). */
export function highlightsOf(data: Record<string, unknown> | null | undefined): LinkHighlight[] {
  const raw = data?.highlights
  if (!Array.isArray(raw)) return []
  const out: LinkHighlight[] = []
  for (const entry of raw) {
    const parsed = LinkHighlight.safeParse(entry)
    if (parsed.success) out.push({ ...parsed.data, by: parsed.data.by.toLowerCase() })
  }
  return out
}

/** The raw `highlights` list, every entry kept (even ones Hotsauce can't read). */
function rawList(data: Record<string, unknown>): unknown[] {
  return Array.isArray(data.highlights) ? [...data.highlights] : []
}

function idOf(entry: unknown): string | null {
  return entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string'
    ? (entry as { id: string }).id
    : null
}

/** One line, at most `max` characters; the passage's own line breaks become spaces. */
function clip(s: string, max: number): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max)
}

/** The note as written (line breaks kept), trimmed; empty is no note. */
function cleanNote(note: string | undefined): string | undefined {
  const s = (note ?? '').replace(/\r\n?/g, '\n').trim().slice(0, MAX_HIGHLIGHT_NOTE)
  return s || undefined
}

export interface NewHighlight {
  quote: string
  prefix?: string | undefined
  suffix?: string | undefined
  block?: number | undefined
  note?: string | undefined
  by: string
  at: string
  id?: string | undefined
}

export class HighlightError extends Error {
  constructor(
    readonly code: 'empty' | 'full' | 'not_found' | 'not_yours',
    message: string,
  ) {
    super(message)
    this.name = 'HighlightError'
  }
}

/** The new `highlights` value with one added at the end, and the highlight. */
export function addHighlight(
  data: Record<string, unknown>,
  input: NewHighlight,
): { highlights: unknown[]; highlight: LinkHighlight } {
  const quote = clip(input.quote, Number.MAX_SAFE_INTEGER)
  if (!quote) throw new HighlightError('empty', 'Select some words to highlight')
  if (quote.length > MAX_HIGHLIGHT_QUOTE) {
    throw new HighlightError(
      'empty',
      `Highlight up to ${MAX_HIGHLIGHT_QUOTE.toLocaleString('en')} characters at a time`,
    )
  }
  const list = rawList(data)
  if (list.length >= MAX_HIGHLIGHTS) {
    throw new HighlightError('full', `A link keeps at most ${MAX_HIGHLIGHTS} highlights`)
  }
  const prefix = (input.prefix ?? '').replace(/\s+/g, ' ').slice(-HIGHLIGHT_CONTEXT)
  const suffix = (input.suffix ?? '').replace(/\s+/g, ' ').slice(0, HIGHLIGHT_CONTEXT)
  const block =
    input.block !== undefined && Number.isInteger(input.block) && input.block >= 0
      ? input.block
      : undefined
  const note = cleanNote(input.note)
  const entry: Record<string, unknown> = {
    id: input.id ?? newId(),
    by: input.by.toLowerCase(),
    at: input.at,
    quote,
  }
  if (prefix) entry.prefix = prefix
  if (suffix) entry.suffix = suffix
  if (block !== undefined) entry.block = block
  if (note) entry.note = note
  return { highlights: [...list, entry], highlight: LinkHighlight.parse(entry) }
}

function findOwn(list: unknown[], id: string, by: string): number {
  const i = list.findIndex((e) => idOf(e) === id)
  if (i < 0) throw new HighlightError('not_found', 'That highlight isn’t there any more')
  const parsed = LinkHighlight.safeParse(list[i])
  if (!parsed.success || parsed.data.by.toLowerCase() !== by.toLowerCase()) {
    throw new HighlightError('not_yours', 'Only the person who made a highlight can change it')
  }
  return i
}

/** The new `highlights` value with a highlight's note changed (empty removes it). */
export function setHighlightNote(
  data: Record<string, unknown>,
  id: string,
  by: string,
  note: string,
  at: string,
): { highlights: unknown[]; highlight: LinkHighlight } {
  const list = rawList(data)
  const i = findOwn(list, id, by)
  const entry = { ...(list[i] as Record<string, unknown>) }
  const clean = cleanNote(note)
  if (clean === (typeof entry.note === 'string' ? entry.note : undefined)) {
    return { highlights: list, highlight: LinkHighlight.parse(entry) }
  }
  if (clean) entry.note = clean
  else delete entry.note
  entry.edited = at
  list[i] = entry
  return { highlights: list, highlight: LinkHighlight.parse(entry) }
}

/** The new `highlights` value without one (undefined when none are left, to drop the key). */
export function removeHighlight(
  data: Record<string, unknown>,
  id: string,
  by: string,
): unknown[] | undefined {
  const list = rawList(data)
  const i = findOwn(list, id, by)
  list.splice(i, 1)
  return list.length > 0 ? list : undefined
}

/** What search reads from a link's highlights: each passage and note on its own line. */
export function highlightsSearchText(highlights: readonly LinkHighlight[]): string {
  return highlights
    .flatMap((h) => [h.quote, h.note ?? ''])
    .filter(Boolean)
    .join('\n')
}

/** Highlights in the order they appear in the page: by block, then when they were made. */
export function inPageOrder(highlights: readonly LinkHighlight[]): LinkHighlight[] {
  return [...highlights].sort(
    (a, b) =>
      (a.block ?? Number.MAX_SAFE_INTEGER) - (b.block ?? Number.MAX_SAFE_INTEGER) ||
      a.at.localeCompare(b.at),
  )
}

export interface HighlightsDocInput {
  title: string
  url: string
  /** The saved copy in the app, e.g. https://…/links/team/<id>. */
  appUrl: string
  highlights: readonly LinkHighlight[]
  /** The member copying; their own highlights carry no name. */
  me: string
  /** A teammate's name from their email. */
  nameOf: (email: string) => string
}

/** "Copy highlights to a Doc": the doc's title and Markdown body. */
export function highlightsDoc(input: HighlightsDocInput): { title: string; markdown: string } {
  const name = input.title.replace(/\s+/g, ' ').trim() || 'a saved page'
  const title = `Highlights: ${name}`
  const safeUrl = /^https?:\/\/[^\s<>]+$/i.test(input.url) ? input.url : ''
  const lines: string[] = [`# ${escapeHeading(title)}`, '']
  const from = [
    safeUrl ? `[the original page](<${safeUrl}>)` : '',
    `[the saved copy](<${input.appUrl}>)`,
  ].filter(Boolean)
  lines.push(`From ${from.join(' and ')}.`, '')
  const me = input.me.toLowerCase()
  for (const h of inPageOrder(input.highlights)) {
    lines.push(...quoteLines(h.quote))
    if (h.by !== me) lines.push('>', `> — ${escapeQuote(input.nameOf(h.by))}`)
    lines.push('')
    // A note is the member's own Markdown; a teammate's is quoted as plain text.
    if (h.note) lines.push(...(h.by === me ? [h.note] : quoteNote(h.note)), '')
  }
  return { title, markdown: `${lines.join('\n').replace(/\n+$/, '')}\n` }
}

function quoteNote(note: string): string[] {
  return note.split('\n').map((l) => escapeQuote(l).replace(/^(\s*)([-+=]|\d+\.)/, '$1\\$2'))
}

function quoteLines(quote: string): string[] {
  return quote.split('\n').map((l) => `> ${escapeQuote(l)}`)
}

/** A passage is the page's words, not Markdown: characters that would start syntax are escaped. */
function escapeQuote(s: string): string {
  return s.replace(/([\\`*_[\]<>#|~])/g, '\\$1')
}

function escapeHeading(s: string): string {
  return s.replace(/([\\`*_[\]<>#|~])/g, '\\$1')
}

/**
 * Where a highlight's passage is in `text` (the page's words as the reader shows them): the
 * start and end offsets, or null when the words aren't there any more. When the passage occurs
 * more than once, the one whose surroundings best match `prefix` and `suffix` wins, then the one
 * nearest `near` (an offset, e.g. the start of its block).
 */
export function findQuote(
  text: string,
  h: { quote: string; prefix?: string | undefined; suffix?: string | undefined },
  near?: number,
): { start: number; end: number } | null {
  return findQuoteIn(prepareText(text), h, near)
}

/** A text made ready for many `findQuoteIn` calls: white space collapsed once. */
export interface PreparedText {
  norm: string
  map: number[]
}

export function prepareText(text: string): PreparedText {
  return normalizeWithMap(text)
}

/** `findQuote` on a text prepared once, for placing many highlights in one page. */
export function findQuoteIn(
  prepared: PreparedText,
  h: { quote: string; prefix?: string | undefined; suffix?: string | undefined },
  near?: number,
): { start: number; end: number } | null {
  const { norm, map } = prepared
  const quote = h.quote.replace(/\s+/g, ' ').trim()
  if (!quote) return null
  const prefix = (h.prefix ?? '').replace(/\s+/g, ' ')
  const suffix = (h.suffix ?? '').replace(/\s+/g, ' ')
  let best: { at: number; score: number; distance: number } | null = null
  for (let at = norm.indexOf(quote); at >= 0; at = norm.indexOf(quote, at + 1)) {
    const score =
      commonSuffix(norm.slice(Math.max(0, at - prefix.length), at), prefix) +
      commonPrefix(norm.slice(at + quote.length, at + quote.length + suffix.length), suffix)
    const distance = near === undefined ? 0 : Math.abs((map[at] ?? 0) - near)
    if (!best || score > best.score || (score === best.score && distance < best.distance)) {
      best = { at, score, distance }
    }
  }
  if (!best) return null
  const start = map[best.at] ?? 0
  const lastChar = map[best.at + quote.length - 1] ?? start
  return { start, end: lastChar + 1 }
}

/** `text` with each run of white space as one space, and each kept character's offset in `text`. */
function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = ''
  const map: number[] = []
  let inSpace = false
  const space = /\s/
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (space.test(ch)) {
      if (!inSpace && norm.length > 0) {
        norm += ' '
        map.push(i)
      }
      inSpace = true
      continue
    }
    inSpace = false
    norm += ch
    map.push(i)
  }
  return { norm, map }
}

function commonSuffix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

function commonPrefix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}
