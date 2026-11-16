// Comments (docs/PLAN-comments.md): a conversation under a team item. One comment is one file,
// `.hearth/comments/<item id>/<comment id>.md` in the team space, keyed to the item's `id` so a
// move or rename needs no work. The body is the comment.

import { z } from 'zod'
import { isId } from './ids.js'
import { SPACE_LAYOUT } from './space.js'

export const COMMENTS_FOLDER = `${SPACE_LAYOUT.meta}/comments`
export const MAX_COMMENT = 10_000
export const MAX_COMMENT_QUOTE = 1_000
export const MAX_COMMENTS_PER_ITEM = 2_000

/**
 * An item's `id` names its comment folder. Hotsauce's own ids are ULIDs; a file written elsewhere
 * can carry any string, so only a plain name is accepted (never a path).
 */
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export const isCommentableId = (id: string) => ITEM_ID.test(id)
export const commentFolder = (itemId: string) => `${COMMENTS_FOLDER}/${itemId}/`
export const commentPath = (itemId: string, commentId: string) =>
  `${COMMENTS_FOLDER}/${itemId}/${commentId}.md`

/** `path` is a comment's file. */
export function isCommentPath(path: string): boolean {
  return commentRefOf(path) !== null
}

/** The item and comment a path names, or null when it isn't a comment's file. */
export function commentRefOf(path: string): { item: string; id: string } | null {
  if (!path.startsWith(`${COMMENTS_FOLDER}/`)) return null
  const [item, file, ...rest] = path.slice(COMMENTS_FOLDER.length + 1).split('/')
  if (!item || !file || rest.length > 0 || !file.endsWith('.md')) return null
  const id = file.slice(0, -'.md'.length)
  return isCommentableId(item) && isId(id) ? { item, id } : null
}

/** A comment's frontmatter. Unknown keys pass through. */
export const CommentFrontmatter = z.looseObject({
  id: z.string().refine(isId),
  type: z.literal('comment'),
  /** The `id` of the item it is under. */
  item: z.string().refine(isCommentableId),
  /** The author's email, and their name when they wrote it. */
  author: z.string().min(1),
  name: z.string().default(''),
  created: z.string(),
  edited: z.string().optional(),
  /** Lowercase emails of the members the text names, as the server resolved them. */
  mentions: z.array(z.string()).default([]),
  /** The passage of the doc the comment is about. */
  quote: z.string().optional(),
  /** The agent channel it was written through ("via Claude"). */
  via: z.string().optional(),
})
export type CommentFrontmatter = z.infer<typeof CommentFrontmatter>

export interface MentionMember {
  email: string
  name: string
  handle: string
}

export interface MentionMatch {
  /** Offsets of `@Name` in the text. */
  from: number
  to: number
  email: string
}

/** A character that can't sit right before a mention's `@` (it would be an email or a word). */
const BEFORE = /[\p{L}\p{N}._%+-]/u
const AFTER = /[\p{L}\p{N}_]/u

/**
 * Where `text` names a member: `@` then their full name, their handle, the local part of their
 * email, or their first name, whichever is longest. A name two members share names neither, so
 * a mention never reaches the wrong person; anything else stays plain text.
 */
export function findMentions(text: string, members: readonly MentionMember[]): MentionMatch[] {
  const keys = new Map<string, string | null>()
  const add = (key: string, email: string) => {
    const k = key.trim().toLowerCase()
    if (!k) return
    const had = keys.get(k)
    keys.set(k, had === undefined || had === email ? email : null)
  }
  // Full names and handles first, so a first name never shadows someone's whole name.
  for (const m of members) {
    add(m.name, m.email)
    add(m.handle, m.email)
    add(m.email.split('@')[0] ?? '', m.email)
  }
  const strong = new Set(keys.keys())
  for (const m of members) {
    const first = m.name.trim().split(/\s+/)[0] ?? ''
    if (!strong.has(first.toLowerCase())) add(first, m.email)
  }
  const candidates = [...keys.entries()]
    .filter((e): e is [string, string] => e[1] !== null)
    .sort((a, b) => b[0].length - a[0].length)

  const lower = text.toLowerCase()
  const out: MentionMatch[] = []
  for (let at = lower.indexOf('@'); at !== -1; at = lower.indexOf('@', at + 1)) {
    if (at > 0 && BEFORE.test(text[at - 1] ?? '')) continue
    for (const [key, email] of candidates) {
      if (!lower.startsWith(key, at + 1)) continue
      const to = at + 1 + key.length
      if (to < text.length && AFTER.test(text[to] ?? '')) continue
      out.push({ from: at, to, email })
      at = to - 1
      break
    }
  }
  return out
}

/** The members `text` names, each once, in the order they are first named. */
export function mentionedEmails(text: string, members: readonly MentionMember[]): string[] {
  return [...new Set(findMentions(text, members).map((m) => m.email.toLowerCase()))]
}
