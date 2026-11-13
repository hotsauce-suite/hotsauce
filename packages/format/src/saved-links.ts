// Saved links (ARCHITECTURE §23): a read-later list. One link per Markdown file,
// `links/<id>.md`: the page's address and details in frontmatter, its readable copy as the body.
// Everything here is pure.

import { z } from 'zod'
import { patchFrontmatter } from './frontmatter.js'
import { isId, newId } from './ids.js'
import { cleanLabels } from './notes.js'

export const LINKS_FOLDER = 'links'
/** The longest address Hearth keeps. */
export const MAX_LINK_URL = 2000
/** The longest readable copy Hearth keeps, in characters. */
export const MAX_LINK_BODY = 200_000

export const LINK_SOURCES = ['web', 'extension', 'share', 'shortcut', 'mcp'] as const
export type LinkSource = (typeof LINK_SOURCES)[number]

/** `links/<id>.md`. */
export function linkPath(id: string): string {
  return `${LINKS_FOLDER}/${id}.md`
}

/** The id of a link file, or null when the path isn't `links/<id>.md`. */
export function linkIdOf(path: string): string | null {
  const match = /^links\/([0-9A-Z]{26})\.md$/.exec(path)
  return match?.[1] && isId(match[1]) ? match[1] : null
}

function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => v ?? undefined, schema.optional())
}

/** Unknown keys pass through untouched; an unknown source reads as absent. */
export const LinkFrontmatter = z.looseObject({
  id: z.string().min(1),
  type: z.literal('link'),
  url: z.string().min(1),
  title: optional(z.string()),
  /** The site's name, e.g. "The Verge", else its host. */
  site: optional(z.string()),
  description: optional(z.string()),
  /** Claude's one-sentence summary. */
  summary: optional(z.string()),
  tags: optional(z.array(z.string())),
  /** True once the member marked it Done. */
  archived: optional(z.boolean()),
  saved: z.string(),
  saved_by: z.string(),
  /** ISO instant of the last good fetch. */
  fetched: optional(z.string()),
  /** Why the last fetch failed, in words for the member. */
  fetch_error: optional(z.string()),
  words: optional(z.number()),
  /** True once the member set the tags themselves; Claude then leaves them alone. */
  tags_set: optional(z.boolean()),
  source: z.preprocess(
    (v) =>
      typeof v === 'string' && (LINK_SOURCES as readonly string[]).includes(v) ? v : undefined,
    z.enum(LINK_SOURCES).optional(),
  ),
})
export type LinkFrontmatter = z.infer<typeof LinkFrontmatter>

export interface NewLink {
  url: string
  title?: string | undefined
  tags?: string[] | undefined
  source?: LinkSource | undefined
  savedBy: string
  /** ISO instant; default now. */
  saved?: string | undefined
  id?: string | undefined
}

/** A new link file's text and path, before its page is fetched. */
export function newLinkFile(link: NewLink): { id: string; path: string; text: string } {
  const id = link.id ?? newId()
  const saved = link.saved ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const tags = cleanTags(link.tags ?? [])
  const fields: Record<string, unknown> = {
    id,
    type: 'link',
    url: link.url,
    title: oneLine(link.title ?? '') || undefined,
    site: siteOf(link.url) || undefined,
    tags: tags.length > 0 ? tags : undefined,
    tags_set: tags.length > 0 || undefined,
    saved,
    saved_by: link.savedBy.toLowerCase(),
    source: link.source,
  }
  return { id, path: linkPath(id), text: patchFrontmatter('\n', fields) }
}

/** One line, spaces collapsed. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Tags: one line each, lower case, at most 40 characters, de-duplicated, at most 20. */
export function cleanTags(tags: readonly string[]): string[] {
  return cleanLabels(
    tags.map((t) => oneLine(t).toLowerCase().replace(/^#+/, '').slice(0, 40).trim()),
  ).slice(0, 20)
}

/** The host without `www.`, or '' when the address doesn't parse. */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Why `raw` can't be saved, or null when it can. */
export function linkUrlProblem(raw: string): string | null {
  const s = raw.trim()
  if (!s) return 'Paste a link to save'
  if (s.length > MAX_LINK_URL) return 'That link is too long to save'
  let url: URL
  try {
    url = new URL(s)
  } catch {
    return 'That isn’t a web link'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Only web links (http or https) can be saved'
  }
  if (url.username || url.password) {
    return 'Links with a user name or password in them can’t be saved'
  }
  if (!url.hostname) return 'That isn’t a web link'
  return null
}

/**
 * The first web link in a shared text ("Look at this https://…"), or the text itself when it is a
 * bare address without its `https://`. Null when there is none.
 */
export function findLinkUrl(text: string): string | null {
  const s = text.trim()
  const m = /\bhttps?:\/\/[^\s<>"']+/i.exec(s)
  if (m) return m[0].replace(/[).,;:!?\]}'"]+$/, '')
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s) && /\.[a-z]{2,}(\/|$)/i.test(s)) {
    return `https://${s}`
  }
  return null
}

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|igshid|ref_src)$/i

/**
 * The address compared to find a link saved twice: no `#hash`, no tracking parameters, host in
 * lower case without `www.`, no trailing slash on the path. Only for comparing: the member's
 * address is stored as given.
 */
export function normalizeLinkUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return raw.trim()
  }
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING.test(key)) url.searchParams.delete(key)
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const port = url.port ? `:${url.port}` : ''
  const path = url.pathname.replace(/\/+$/, '')
  const query = url.searchParams.toString()
  return `${url.protocol}//${host}${port}${path}${query ? `?${query}` : ''}`
}

/** The readable copy from a file body: without the leading blank lines or trailing space. */
export function linkTextOf(body: string): string {
  return body.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '')
}

/** The file body for a readable copy: a blank line after the frontmatter, a final newline. */
export function linkBodyText(text: string): string {
  const trimmed = linkTextOf(text).slice(0, MAX_LINK_BODY)
  return trimmed ? `\n${trimmed}\n` : '\n'
}

/** Words in a readable copy, for "5 min read". */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
}
