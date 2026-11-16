// Comments (ARCHITECTURE §27; docs/PLAN-comments.md): one conversation under a team doc, meeting
// note or task. Each comment is a file in the team space, written only here; every read comes
// from the index. A mention pushes the member named, once.

import {
  CommentFrontmatter,
  commentFolder,
  commentPath,
  ensureId,
  extractTitle,
  FrontmatterError,
  isCommentableId,
  isId,
  MAX_COMMENT,
  MAX_COMMENT_QUOTE,
  MAX_COMMENTS_PER_ITEM,
  type MentionMember,
  mentionedEmails,
  parseFrontmatter,
  taskIdOf,
} from '@hotsauce/format'
import { ulid } from 'ulid'
import { stringify as toYaml } from 'yaml'
import type { Principal } from '../auth/index.js'
import { HotsauceError } from '../errors.js'
import { type Change, formatCommitMessage, type GitStore, withVia } from '../git/index.js'
import { type FileKind, type FileRow, type Index, kindOf } from '../index/index.js'
import type { PushSender } from '../meetings/reminders/sender.js'
import type { ReminderStore } from '../meetings/reminders/store.js'
import { TEAM_SPACE } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'

const WRITE_ATTEMPTS = 3
/** A mention is still worth having a day later, unlike a meeting reminder. */
const MENTION_PUSH_TTL_SECONDS = 24 * 60 * 60

/** What a conversation can sit under so far; the other kinds follow one release each (plan, slice 5). */
export const COMMENTABLE_KINDS: readonly FileKind[] = ['docs', 'other', 'meeting', 'task']

export function isCommentable(path: string): boolean {
  return path.toLowerCase().endsWith('.md') && COMMENTABLE_KINDS.includes(kindOf(path))
}

export interface CommentView {
  id: string
  /** The `id` of the item it is under. */
  item: string
  author: string
  name: string
  created: string
  edited: string | null
  text: string
  quote: string | null
  mentions: Array<{ email: string; name: string }>
  /** The agent channel it was written through, when there was one. */
  via: string | null
  mine: boolean
  canEdit: boolean
  canDelete: boolean
}

export interface CommentsView {
  /** False for an item that takes no comments (a personal item, a kind not covered yet). */
  canComment: boolean
  comments: CommentView[]
}

export interface CommentsDeps {
  git: Pick<GitStore, 'readFile' | 'commit'>
  index: Pick<Index, 'getFile' | 'listFiles' | 'bodies' | 'fileById'>
  syncer: Pick<Syncer, 'afterHeadChanged'>
  /** Members: who can be mentioned. */
  people: (principal: Principal) => MentionMember[]
  /** Each member's name as their browser last said it; an email's local part reads worse. */
  names: () => Promise<Record<string, { name: string }>>
  /** Null: this server sends no push. */
  push: {
    store: Pick<ReminderStore, 'subscribers' | 'unsubscribe' | 'markSent'>
    sender: PushSender
  } | null
  now?: () => Date
  log?: (message: string) => void
}

interface Row {
  fm: CommentFrontmatter
  body: string
}

export class Comments {
  readonly #d: CommentsDeps
  readonly #now: () => Date
  readonly #log: (m: string) => void
  /** Pushes on their way, so a test (or a shutdown) can wait for them. */
  #pending: Promise<void> = Promise.resolve()

  constructor(deps: CommentsDeps) {
    this.#d = deps
    this.#now = deps.now ?? (() => new Date())
    this.#log = deps.log ?? console.warn
  }

  /** Resolves when every push started so far has been handed to the push service. */
  idle(): Promise<void> {
    return this.#pending
  }

  // ── reading ───────────────────────────────────────────────────────────

  /** The conversation under an item, oldest first, from the index alone. */
  async list(principal: Principal, item: { space: string; path: string }): Promise<CommentsView> {
    if (item.space !== TEAM_SPACE || !isCommentable(item.path)) {
      return { canComment: false, comments: [] }
    }
    const row = this.#d.index.getFile(TEAM_SPACE, item.path)
    const itemId = row ? itemIdOf(row) : null
    if (!itemId) return { canComment: true, comments: [] }
    const members = await this.members(principal)
    return {
      canComment: true,
      comments: this.#rows(itemId).map((r) => this.#view(r, principal, members)),
    }
  }

  /** Who can be mentioned: every member, by name. */
  async members(principal: Principal): Promise<MentionMember[]> {
    const known = await this.#d.names()
    return this.#d
      .people(principal)
      .map((p) => ({ ...p, name: known[p.email.toLowerCase()]?.name || p.name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  // ── writing ───────────────────────────────────────────────────────────

  async add(
    principal: Principal,
    input: { space: string; path: string; text: string; quote?: string | undefined },
    via?: string,
  ): Promise<CommentView> {
    this.#assertMember(principal)
    if (input.space !== TEAM_SPACE) {
      throw new HotsauceError('forbidden', 'Comments are for things the team shares')
    }
    if (!isCommentable(input.path)) {
      throw new HotsauceError('bad_request', 'This kind of item doesn’t take comments yet')
    }
    const text = cleanText(input.text)
    const quote = cleanQuote(input.quote)
    const members = await this.members(principal)
    const id = ulid()
    const now = this.#iso()
    for (let attempt = 1; ; attempt++) {
      const file = await this.#d.git.readFile(TEAM_SPACE, input.path).catch((err) => {
        throw isNotFound(err)
          ? new HotsauceError('not_found', 'Save this before commenting on it')
          : err
      })
      // An item without an `id` (a file written outside Hotsauce) gets one with its first
      // comment, in the same commit: a frontmatter patch, the rest of the file untouched.
      const withId = idFor(input.path, file.content)
      if (!isCommentableId(withId.id)) {
        throw new HotsauceError('bad_request', 'This item’s id can’t hold comments; fix it in Git')
      }
      if (this.#rows(withId.id).length >= MAX_COMMENTS_PER_ITEM) {
        throw new HotsauceError('bad_request', `At most ${MAX_COMMENTS_PER_ITEM} comments`)
      }
      const fm = CommentFrontmatter.parse({
        id,
        type: 'comment',
        item: withId.id,
        author: principal.email,
        name: principal.name || principal.email,
        created: now,
        mentions: mentionedEmails(text, members),
        ...(quote ? { quote } : {}),
        ...(via ? { via } : {}),
      })
      const path = commentPath(withId.id, id)
      const title = titleOf(input.path, file.content)
      const changes: Change[] = [{ path, content: commentFile(fm, text) }]
      if (withId.added) changes.unshift({ path: input.path, content: withId.text })
      const result = await this.#d.git.commit(TEAM_SPACE, {
        changes,
        author: { name: principal.name, email: principal.email },
        message: withVia(
          formatCommitMessage({ app: 'comments', verb: 'add to', title: oneLine(title, 120) }),
          via,
        ),
        // Patching the item mustn't undo a save that landed since it was read; a comment's own
        // file only has to be new.
        unchanged: withId.added
          ? { path: input.path, blobOid: file.blobOid }
          : { path, blobOid: null },
      })
      if (result.status === 'conflict') {
        if (attempt >= WRITE_ATTEMPTS) {
          throw new HotsauceError('conflict', 'This changed at the same time; try again')
        }
        continue
      }
      await this.#d.syncer.afterHeadChanged(TEAM_SPACE)
      this.#notify(principal, { fm, body: text }, fm.mentions, {
        path: input.path,
        title,
      })
      return this.#view({ fm, body: text }, principal, members)
    }
  }

  /** The author rewrites their comment; it shows as edited. */
  async edit(
    principal: Principal,
    itemId: string,
    commentId: string,
    input: { text: string },
    via?: string,
  ): Promise<CommentView> {
    this.#assertMember(principal)
    const text = cleanText(input.text)
    const members = await this.members(principal)
    for (let attempt = 1; ; attempt++) {
      const prior = await this.#read(itemId, commentId)
      if (!sameMember(prior.fm.author, principal.email)) {
        throw new HotsauceError('forbidden', 'Only its author can edit a comment')
      }
      const fm = CommentFrontmatter.parse({
        ...prior.fm,
        edited: this.#iso(),
        mentions: mentionedEmails(text, members),
      })
      const result = await this.#d.git.commit(TEAM_SPACE, {
        changes: [{ path: prior.path, content: commentFile(fm, text) }],
        author: { name: principal.name, email: principal.email },
        message: withVia(
          formatCommitMessage({ app: 'comments', verb: 'edit on', title: this.#itemTitle(itemId) }),
          via,
        ),
        unchanged: { path: prior.path, blobOid: prior.blobOid },
      })
      if (result.status === 'conflict') {
        if (attempt >= WRITE_ATTEMPTS) {
          throw new HotsauceError('conflict', 'This changed at the same time; try again')
        }
        continue
      }
      await this.#d.syncer.afterHeadChanged(TEAM_SPACE)
      // Only the members this edit names for the first time hear about it.
      const before = new Set(prior.fm.mentions.map((m) => m.toLowerCase()))
      const item = this.#d.index.fileById(TEAM_SPACE, itemId)
      if (item) {
        this.#notify(
          principal,
          { fm, body: text },
          fm.mentions.filter((m) => !before.has(m.toLowerCase())),
          { path: item.path, title: item.title },
        )
      }
      return this.#view({ fm, body: text }, principal, members)
    }
  }

  /** The author deletes their comment; an admin (in a session) deletes anyone's. History keeps it. */
  async remove(
    principal: Principal,
    itemId: string,
    commentId: string,
    via?: string,
  ): Promise<void> {
    this.#assertMember(principal)
    const prior = await this.#read(itemId, commentId)
    if (!sameMember(prior.fm.author, principal.email) && !(principal.isAdmin && !principal.via)) {
      throw new HotsauceError('forbidden', 'Only its author or an admin can delete a comment')
    }
    const result = await this.#d.git.commit(TEAM_SPACE, {
      changes: [{ path: prior.path, content: null }],
      author: { name: principal.name, email: principal.email },
      message: withVia(
        formatCommitMessage({
          app: 'comments',
          verb: 'delete from',
          title: this.#itemTitle(itemId),
        }),
        via,
      ),
      unchanged: { path: prior.path, blobOid: prior.blobOid },
    })
    if (result.status === 'conflict') {
      throw new HotsauceError('conflict', 'This changed at the same time; try again')
    }
    await this.#d.syncer.afterHeadChanged(TEAM_SPACE)
  }

  // ── internals ─────────────────────────────────────────────────────────

  #rows(itemId: string): Row[] {
    const rows = this.#d.index.listFiles({
      space: TEAM_SPACE,
      kind: 'comment',
      prefix: commentFolder(itemId),
    })
    const bodies = this.#d.index.bodies(
      TEAM_SPACE,
      rows.map((r) => r.path),
    )
    const out: Row[] = []
    for (const row of rows) {
      const fm = CommentFrontmatter.safeParse(row.frontmatter ?? {})
      // A file that doesn't say what its path says isn't one of ours.
      if (!fm.success || row.path !== commentPath(itemId, fm.data.id) || fm.data.item !== itemId)
        continue
      out.push({ fm: fm.data, body: (bodies.get(row.path) ?? '').trim() })
    }
    return out.sort(
      (a, b) => a.fm.created.localeCompare(b.fm.created) || a.fm.id.localeCompare(b.fm.id),
    )
  }

  async #read(itemId: string, commentId: string) {
    if (!isCommentableId(itemId) || !isId(commentId)) throw noComment()
    const path = commentPath(itemId, commentId)
    const file = await this.#d.git.readFile(TEAM_SPACE, path).catch((err) => {
      throw isNotFound(err) ? noComment() : err
    })
    const parsed = parseFrontmatter(file.content)
    const fm = CommentFrontmatter.safeParse(parsed.data)
    if (!fm.success || fm.data.id !== commentId || fm.data.item !== itemId) {
      throw new HotsauceError('conflict', 'This comment’s file can’t be read; fix it in Git')
    }
    return { fm: fm.data, body: parsed.body.trim(), blobOid: file.blobOid, path }
  }

  #itemTitle(itemId: string): string {
    return oneLine(this.#d.index.fileById(TEAM_SPACE, itemId)?.title ?? 'an item', 120)
  }

  #view(row: Row, principal: Principal, members: readonly MentionMember[]): CommentView {
    const nameOf = new Map(members.map((m) => [m.email.toLowerCase(), m.name]))
    const mine = sameMember(row.fm.author, principal.email)
    return {
      id: row.fm.id,
      item: row.fm.item,
      author: row.fm.author,
      // Their name now when they are still a member, else as it was written.
      name: nameOf.get(row.fm.author.toLowerCase()) || row.fm.name || row.fm.author,
      created: row.fm.created,
      edited: row.fm.edited ?? null,
      text: row.body,
      quote: row.fm.quote ?? null,
      mentions: row.fm.mentions.map((email) => ({
        email,
        name: nameOf.get(email.toLowerCase()) ?? email,
      })),
      via: row.fm.via ?? null,
      mine,
      canEdit: mine,
      canDelete: mine || (principal.isAdmin && !principal.via),
    }
  }

  /** One push per member named, never to the author, never twice for one comment. */
  #notify(
    author: Principal,
    comment: Row,
    emails: readonly string[],
    item: { path: string; title: string },
  ): void {
    const push = this.#d.push
    const to = [...new Set(emails.map((e) => e.toLowerCase()))].filter(
      (e) => !sameMember(e, author.email),
    )
    if (!push || to.length === 0) return
    const payload = {
      title: `${author.name || author.email} mentioned you`,
      body: `${oneLine(item.title, 80)}: ${oneLine(comment.body, 140)}`,
      url: `${itemUrl(item.path)}#comment-${comment.fm.id}`,
      tag: `comment-${comment.fm.id}`,
    }
    const send = async () => {
      const subscribers = await push.store.subscribers()
      for (const email of to) {
        const subs = subscribers.filter((s) => sameMember(s.principal.email, email))
        if (subs.length === 0) continue
        if (!(await push.store.markSent(`mention ${email} ${comment.fm.id}`, this.#now().getTime())))
          continue
        for (const sub of subs) {
          try {
            const result = await push.sender.send(sub.subscription, payload, {
              ttlSeconds: MENTION_PUSH_TTL_SECONDS,
            })
            if (result === 'gone') await push.store.unsubscribe(sub.subscription.endpoint)
          } catch (err) {
            this.#log(`comments: push to ${email} failed: ${err}`)
          }
        }
      }
    }
    // The comment is saved; a slow push service never holds up the reply to its author.
    this.#pending = this.#pending
      .then(send)
      .catch((err) => this.#log(`comments: pushes failed: ${err}`))
  }

  #assertMember(principal: Principal): void {
    if (!principal.email) throw new HotsauceError('forbidden', 'Only members comment')
  }

  #iso(): string {
    return this.#now().toISOString()
  }
}

/**
 * The comment files under the items at `paths` (files, or folders of them), as deletions: an item
 * that is deleted takes its conversation with it, in the same commit (history keeps both).
 */
export function commentRemovals(
  index: Pick<Index, 'getFile' | 'listFiles'>,
  space: string,
  paths: readonly string[],
): Array<{ path: string; content: null }> {
  if (space !== TEAM_SPACE) return []
  const items = new Set<string>()
  for (const path of paths) {
    const rows = [
      ...[index.getFile(space, path)].filter((r): r is FileRow => r !== null),
      ...(path.toLowerCase().endsWith('.md') ? [] : index.listFiles({ space, prefix: `${path}/` })),
    ]
    for (const row of rows) {
      const id = row.kind === 'comment' ? null : itemIdOf(row)
      if (id) items.add(id)
    }
  }
  const out: Array<{ path: string; content: null }> = []
  for (const id of items) {
    for (const row of index.listFiles({ space, kind: 'comment', prefix: commentFolder(id) })) {
      out.push({ path: row.path, content: null })
    }
  }
  return out
}

/** The id an indexed item's comments are filed under, or null when it has none that can be. */
function itemIdOf(row: Pick<FileRow, 'id' | 'path'>): string | null {
  const id = taskIdOf(row.path) ?? row.id
  return id && isCommentableId(id) ? id : null
}

function idFor(path: string, content: string): { id: string; text: string; added: boolean } {
  const taskId = taskIdOf(path)
  if (taskId) return { id: taskId, text: content, added: false }
  try {
    return ensureId(content)
  } catch (err) {
    if (err instanceof FrontmatterError) {
      throw new HotsauceError('bad_request', 'This file’s properties can’t be read; fix them first')
    }
    throw err
  }
}

/** Where the item opens in the app, by what it is. */
function itemUrl(path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  const taskId = taskIdOf(path)
  if (taskId) return `/tasks/item/${TEAM_SPACE}/${taskId}`
  return kindOf(path) === 'meeting'
    ? `/meetings/${TEAM_SPACE}/${encoded}`
    : `/docs/${TEAM_SPACE}/${encoded}`
}

function titleOf(path: string, content: string): string {
  const fm = parseFrontmatter(content).data
  if (typeof fm.title === 'string' && fm.title.trim()) return fm.title.trim()
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
  return extractTitle(content) ?? name
}

function commentFile(fm: CommentFrontmatter, body: string): string {
  const data = Object.fromEntries(Object.entries(fm).filter(([, v]) => v !== undefined))
  return `---\n${toYaml(data)}---\n${body}\n`
}

function cleanText(text: string): string {
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (!clean) throw new HotsauceError('bad_request', 'Write a comment first')
  if (clean.length > MAX_COMMENT) {
    throw new HotsauceError(
      'bad_request',
      `A comment is at most ${MAX_COMMENT.toLocaleString('en-US')} characters`,
    )
  }
  return clean
}

function cleanQuote(quote: string | undefined): string | null {
  const clean = quote?.replace(/\r\n/g, '\n').trim()
  if (!clean) return null
  return clean.length > MAX_COMMENT_QUOTE ? `${clean.slice(0, MAX_COMMENT_QUOTE - 1)}…` : clean
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').replace(/"/g, "'").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function sameMember(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function isNotFound(err: unknown): boolean {
  return err instanceof HotsauceError && err.code === 'not_found'
}

function noComment(): HotsauceError {
  return new HotsauceError('not_found', 'No such comment')
}
