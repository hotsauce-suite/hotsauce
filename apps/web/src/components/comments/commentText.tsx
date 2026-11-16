import { findMentions } from '@hotsauce/format'
import type { ReactNode } from 'react'
import type { Comment, CommentMember } from '../../api/comments'

const URL_RE = /https?:\/\/[^\s<>"']+/g
/** Punctuation that ends a sentence, not a link. */
const TRAILING = /[.,;:!?)\]}]+$/

function linkify(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(TRAILING, '')
    const at = match.index
    if (at > last) out.push(text.slice(last, at))
    out.push(
      <a
        key={`${key}-${at}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-ember-strong underline underline-offset-2"
      >
        {url}
      </a>,
    )
    last = at + url.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/**
 * A comment's words as written: plain text with its line breaks, links that open, and the
 * members it names marked. Only the people the server resolved are marked, so what reads as a
 * mention is exactly who was told.
 */
export function CommentText({
  comment,
  members,
}: {
  comment: Pick<Comment, 'text' | 'mentions'>
  members: readonly CommentMember[]
}) {
  const named = new Set(comment.mentions.map((m) => m.email.toLowerCase()))
  const matches =
    named.size > 0
      ? findMentions(comment.text, members).filter((m) => named.has(m.email.toLowerCase()))
      : []
  const out: ReactNode[] = []
  let last = 0
  for (const match of matches) {
    if (match.from > last) out.push(...linkify(comment.text.slice(last, match.from), `t${last}`))
    out.push(
      <span
        key={`m${match.from}`}
        data-testid="comment-mention"
        className="rounded bg-ember-wash px-1 font-medium text-ember-strong"
      >
        {comment.text.slice(match.from, match.to)}
      </span>,
    )
    last = match.to
  }
  if (last < comment.text.length) out.push(...linkify(comment.text.slice(last), `t${last}`))
  return (
    <p
      data-testid="comment-text"
      className="text-sm leading-relaxed break-words whitespace-pre-wrap text-ink"
    >
      {out}
    </p>
  )
}

/** When a comment was written: the time today, the day this year, the full date before that. */
export function commentWhen(iso: string, now = new Date()): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (at.toDateString() === now.toDateString()) return time
  const day = at.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
  return `${day}, ${time}`
}
