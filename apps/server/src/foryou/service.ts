// For you (ARCHITECTURE §27.5; docs/PLAN-comments.md slice 2): one list of what is waiting on a
// member. The list is worked out from the index (every comment that mentions them); only their own
// marks (seen, Done, Later) are written, to `.hearth/for-you.json` in their personal space.

import {
  CommentFrontmatter,
  FOR_YOU_STATE_PATH,
  type ForYouAction,
  type ForYouState,
  forYouStanding,
  laterUntil,
  markForYou,
  parseForYouState,
  serializeForYouState,
} from '@hotsauce/format'
import type { Principal } from '../auth/index.js'
import { itemUrl } from '../comments/index.js'
import { HotsauceError } from '../errors.js'
import { formatCommitMessage, type GitStore } from '../git/index.js'
import type { FileKind, FileRow, Index } from '../index/index.js'
import type { SpaceService } from '../spaces/index.js'
import { TEAM_SPACE } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'

const WRITE_ATTEMPTS = 3

export interface ForYouItem {
  /** The item's `id` (a task's is its file name): what a mark is kept under. */
  item: string
  space: string
  path: string
  title: string
  kind: FileKind
  /** Opens the item at the newest comment that names the member. */
  url: string
  /** That comment. */
  comment: { id: string; author: string; name: string; text: string; created: string }
  /** How many comments on the item name the member. */
  mentions: number
  /** When it last moved for the member: the newest mention, or the end of a Later. Newest first. */
  at: string
  /** False once they opened it after it last moved. */
  unseen: boolean
}

export interface ForYouView {
  items: ForYouItem[]
  /** How many items count: shown and not opened since they last moved. */
  unseen: number
  /** False when the member has no personal space to keep marks in. */
  canMark: boolean
}

export type ForYouRequest =
  | { action: 'seen' | 'done' | 'undone' }
  | { action: 'later'; when: 'tomorrow' | 'monday'; zone: string }

export interface ForYouDeps {
  git: Pick<GitStore, 'readFile' | 'commit'>
  index: Pick<Index, 'commentsMentioning' | 'getFile' | 'fileById' | 'getSyncState'>
  spaces: Pick<SpaceService, 'visibleSpaces'>
  syncer: Pick<Syncer, 'afterHeadChanged'>
  /** Members' names now, by lowercase email; a comment keeps the name it was written with. */
  names: () => Promise<Record<string, { name: string }>>
  now?: () => Date
}

export class ForYou {
  readonly #d: ForYouDeps
  readonly #now: () => Date
  /** Each personal space's marks as of its indexed head, so a list needs no Git read. */
  readonly #cache = new Map<string, { head: string; state: ForYouState }>()

  constructor(deps: ForYouDeps) {
    this.#d = deps
    this.#now = deps.now ?? (() => new Date())
  }

  async list(principal: Principal): Promise<ForYouView> {
    const space = await this.#personalSpace(principal)
    const state = space ? await this.#state(space) : { schema: 1 as const, items: {} }
    const names = await this.#d.names()
    const now = this.#now()
    const me = principal.email.toLowerCase()
    const byItem = new Map<string, Array<{ fm: CommentFrontmatter; body: string; when: string }>>()
    for (const row of this.#d.index.commentsMentioning(TEAM_SPACE, principal.email)) {
      const fm = CommentFrontmatter.safeParse(row.frontmatter ?? {})
      if (!fm.success) continue
      // Naming yourself isn't asking for your own attention.
      if (fm.data.author.toLowerCase() === principal.email.toLowerCase()) continue
      const list = byItem.get(fm.data.item) ?? []
      // An edit that named them later counts from the edit, as its push did.
      list.push({
        fm: fm.data,
        body: row.body.trim(),
        when: fm.data.named?.[me] ?? fm.data.created,
      })
      byItem.set(fm.data.item, list)
    }
    const items: ForYouItem[] = []
    for (const [itemId, comments] of byItem) {
      const row = this.#item(itemId)
      if (!row) continue
      const latest = comments.reduce((a, b) =>
        b.when > a.when || (b.when === a.when && b.fm.id > a.fm.id) ? b : a,
      )
      const standing = forYouStanding(state.items[itemId], latest.when, now)
      if (!standing.shown) continue
      items.push({
        item: itemId,
        space: TEAM_SPACE,
        path: row.path,
        title: row.title,
        kind: row.kind,
        url: `${itemUrl(row.path)}#comment-${latest.fm.id}`,
        comment: {
          id: latest.fm.id,
          author: latest.fm.author,
          name: names[latest.fm.author.toLowerCase()]?.name || latest.fm.name || latest.fm.author,
          text: oneLine(latest.body, 200),
          created: latest.fm.created,
        },
        mentions: comments.length,
        at: standing.at,
        unseen: standing.unseen,
      })
    }
    items.sort((a, b) => b.at.localeCompare(a.at) || b.item.localeCompare(a.item))
    return { items, unseen: items.filter((i) => i.unseen).length, canMark: space !== null }
  }

  /** Records the member's mark on one item, then answers with the list as it now stands. */
  async mark(principal: Principal, itemId: string, req: ForYouRequest): Promise<ForYouView> {
    const space = await this.#personalSpace(principal)
    if (!space) {
      throw new HotsauceError('bad_request', 'You have no personal space to keep For you in')
    }
    const now = this.#now()
    let act: ForYouAction
    if (req.action === 'later') {
      let until: Date
      try {
        until = laterUntil(req.when, now, req.zone)
      } catch {
        throw new HotsauceError('bad_request', `Unknown time zone: ${req.zone}`)
      }
      act = { action: 'later', until: until.toISOString() }
    } else {
      act = { action: req.action }
    }
    // Opening something already seen since it last moved changes nothing worth a commit.
    if (req.action === 'seen' && !(await this.#isUnseen(principal, itemId))) {
      return this.list(principal)
    }
    const title = oneLine(this.#item(itemId)?.title ?? 'an item', 120).replace(/"/g, "'")
    for (let attempt = 1; ; attempt++) {
      const file = await this.#d.git.readFile(space, FOR_YOU_STATE_PATH).catch((err) => {
        if (err instanceof HotsauceError && err.code === 'not_found') return null
        throw err
      })
      const before = parseForYouState(file?.content ?? '')
      const content = serializeForYouState(markForYou(before, itemId, act, now))
      if (content === file?.content) break
      let oid: string | null = null
      try {
        const result = await this.#d.git.commit(space, {
          changes: [{ path: FOR_YOU_STATE_PATH, content }],
          author: { name: principal.name, email: principal.email },
          message: formatCommitMessage({ app: 'for you', verb: verbOf(req), title }),
          unchanged: { path: FOR_YOU_STATE_PATH, blobOid: file?.blobOid ?? null },
        })
        oid = result.status === 'committed' ? result.oid : null
      } catch (err) {
        if (err instanceof HotsauceError && err.code === 'conflict' && attempt < WRITE_ATTEMPTS)
          continue
        throw err
      }
      await this.#d.syncer.afterHeadChanged(space)
      this.#remember(space, oid, parseForYouState(content))
      break
    }
    return this.list(principal)
  }

  async #isUnseen(principal: Principal, itemId: string): Promise<boolean> {
    const view = await this.list(principal)
    return view.items.some((i) => i.item === itemId && i.unseen)
  }

  /** The item a conversation is under, in the team space, or null when it has gone. */
  #item(itemId: string): FileRow | null {
    const task = /^[0-9A-Z]{26}$/.test(itemId)
      ? this.#d.index.getFile(TEAM_SPACE, `tasks/${itemId}.md`)
      : null
    return task ?? this.#d.index.fileById(TEAM_SPACE, itemId)
  }

  async #state(space: string): Promise<ForYouState> {
    const head = this.#d.index.getSyncState(space)?.headOid ?? ''
    const hit = this.#cache.get(space)
    if (hit && head && hit.head === head) return hit.state
    const file = await this.#d.git.readFile(space, FOR_YOU_STATE_PATH).catch((err) => {
      if (err instanceof HotsauceError && err.code === 'not_found') return null
      throw err
    })
    const state = parseForYouState(file?.content ?? '')
    if (head) this.#cache.set(space, { head, state })
    return state
  }

  /** Keeps what this commit wrote, but only when the index is at that commit; else reads again. */
  #remember(space: string, oid: string | null, state: ForYouState): void {
    const head = this.#d.index.getSyncState(space)?.headOid
    if (oid && head === oid) this.#cache.set(space, { head, state })
    else this.#cache.delete(space)
  }

  async #personalSpace(principal: Principal): Promise<string | null> {
    const spaces = await this.#d.spaces.visibleSpaces(principal)
    return spaces.find((s) => s.kind === 'personal')?.name ?? null
  }
}

function verbOf(req: ForYouRequest): string {
  switch (req.action) {
    case 'seen':
      return 'open'
    case 'done':
      return 'done'
    case 'undone':
      return 'undo done'
    case 'later':
      return req.when === 'monday' ? 'later until Monday' : 'later until tomorrow'
  }
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
