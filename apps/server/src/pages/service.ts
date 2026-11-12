import { parseFrontmatter, patchFrontmatter, SPACE_LAYOUT } from '@hearth/format'
import { ulid } from 'ulid'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import { formatCommitMessage, type GitStore, withVia } from '../git/index.js'
import type { Index } from '../index/index.js'
import type { ShareState } from '../shares/index.js'
import { SHARE_TOKEN, shareUrl } from '../shares/index.js'
import { type SpaceService, TEAM_SPACE } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'

/**
 * Published pages (ARCHITECTURE §20.2): HTML that Claude publishes over MCP, kept in Git as two
 * files written in one commit. `pages/<id>.html` is the page as sent; `pages/<id>.md` carries its
 * title, who and when, the read-only link, and the page's visible text for search. Every publish
 * is a new version of the `.html` file.
 */

export const PAGES_FOLDER = 'pages'
export const MAX_PAGE_BYTES = 2 * 1024 * 1024
export const MAX_PAGE_TEXT_CHARS = 200_000
const PAGE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/
const MAX_VERSIONS = 100
const WRITE_ATTEMPTS = 3

export const pagePointerPath = (id: string) => `${PAGES_FOLDER}/${id}.md`
export const pageHtmlPath = (id: string) => `${PAGES_FOLDER}/${id}.html`

export interface PageSummary {
  space: string
  id: string
  title: string
  created: string | null
  createdBy: string | null
  updated: string | null
  updatedBy: string | null
  shared: boolean
}

export interface PageVersion {
  oid: string
  date: string
  author: string
}

export interface PageView extends PageSummary {
  html: string
  /** The version shown: its commit, or null for the latest. */
  version: string | null
  versions: PageVersion[]
  share: ShareState
}

export interface PagesDeps {
  git: Pick<GitStore, 'readFile' | 'commit' | 'log' | 'show'>
  index: Pick<Index, 'listFiles' | 'listSpaces'>
  spaces: Pick<SpaceService, 'canAccess'>
  syncer: Pick<Syncer, 'afterHeadChanged'>
  now?: () => Date
}

export class Pages {
  readonly #deps: PagesDeps

  constructor(deps: PagesDeps) {
    this.#deps = deps
  }

  /** A new page, or a new version of `id`, in one commit authored by the member. */
  async publish(
    principal: Principal,
    input: { title: string; html: string; space?: string; id?: string },
    via?: string,
  ): Promise<PageSummary & { version: number }> {
    const space = input.space ?? TEAM_SPACE
    this.#assertAccess(principal, space)
    const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 200)
    if (!title) throw new HearthError('bad_request', 'A page needs a title')
    if (!input.html.trim()) throw new HearthError('bad_request', 'A page needs some HTML')
    if (Buffer.byteLength(input.html) > MAX_PAGE_BYTES) {
      throw new HearthError('bad_request', 'A page can be at most 2 MB of HTML', { status: 413 })
    }
    if (input.id !== undefined && !PAGE_ID.test(input.id)) throw notFound(input.id)
    const now = (this.#deps.now?.() ?? new Date()).toISOString().replace(/\.\d+Z$/, 'Z')
    const text = pageText(input.html)

    for (let attempt = 1; ; attempt++) {
      const id = input.id ?? ulid()
      const pointerPath = pagePointerPath(id)
      let pointer: string
      let blobOid: string | null = null
      if (input.id === undefined) {
        // The frontmatter is made on its own and the text appended, so page text that starts
        // with "---" can never be read as (or add keys to) the pointer's frontmatter.
        pointer = `${patchFrontmatter('', {
          id,
          type: 'page',
          title,
          created: now,
          created_by: principal.email,
          updated: now,
          updated_by: principal.email,
        })}${text}\n`
      } else {
        const cur = await this.#deps.git.readFile(space, pointerPath).catch((err) => {
          throw err instanceof HearthError && err.code === 'not_found' ? notFound(id) : err
        })
        blobOid = cur.blobOid
        const patched = patchFrontmatter(cur.content, {
          title,
          updated: now,
          updated_by: principal.email,
        })
        const oldBody = parseFrontmatter(patched).body
        pointer = `${patched.slice(0, patched.length - oldBody.length)}${text}\n`
      }
      try {
        await this.#deps.git.commit(space, {
          changes: [
            { path: pageHtmlPath(id), content: input.html },
            { path: pointerPath, content: pointer },
          ],
          author: { name: principal.name, email: principal.email },
          message: withVia(formatCommitMessage({ app: 'pages', verb: 'publish', title }), via),
          unchanged: { path: pointerPath, blobOid },
        })
      } catch (err) {
        if (err instanceof HearthError && err.code === 'conflict' && attempt < WRITE_ATTEMPTS) {
          continue
        }
        throw err
      }
      await this.#deps.syncer.afterHeadChanged(space)
      const versions = await this.#deps.git.log(space, { path: pageHtmlPath(id) })
      return { ...summaryOf(space, id, parseFrontmatter(pointer).data), version: versions.length }
    }
  }

  /** Pages in every space the member can open, newest first. */
  list(principal: Principal): PageSummary[] {
    const out: PageSummary[] = []
    for (const { name } of this.#deps.index.listSpaces()) {
      if (!this.#deps.spaces.canAccess(principal, name)) continue
      for (const row of this.#deps.index.listFiles({ space: name, kind: 'page' })) {
        const id = row.path.slice(`${PAGES_FOLDER}/`.length, -'.md'.length)
        if (PAGE_ID.test(id)) out.push(summaryOf(name, id, row.frontmatter ?? {}))
      }
    }
    return out.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''))
  }

  /** One page with its HTML (the latest, or the version at commit `version`) and its versions. */
  async get(principal: Principal, space: string, id: string, version?: string): Promise<PageView> {
    this.#assertAccess(principal, space)
    if (!PAGE_ID.test(id)) throw notFound(id)
    const pointer = await this.#deps.git.readFile(space, pagePointerPath(id)).catch((err) => {
      throw err instanceof HearthError && err.code === 'not_found' ? notFound(id) : err
    })
    const log = await this.#deps.git.log(space, { path: pageHtmlPath(id), limit: MAX_VERSIONS })
    const versions = log.map((c) => ({ oid: c.oid, date: c.date, author: c.author.name }))
    let html: string
    if (version) {
      if (!versions.some((v) => v.oid === version)) {
        throw new HearthError('not_found', `No version ${version} of this page`)
      }
      html = await this.#deps.git.show(space, version, pageHtmlPath(id))
    } else {
      html = (await this.#deps.git.readFile(space, pageHtmlPath(id))).content
    }
    const fm = parseFrontmatter(pointer.content).data
    const share = typeof fm.share === 'string' && SHARE_TOKEN.test(fm.share) ? fm.share : null
    return {
      ...summaryOf(space, id, fm),
      html,
      version: version ?? null,
      versions,
      share: shareUrl(share),
    }
  }

  /** Moves the page (both files) to the space's trash in one commit; nothing is lost. */
  async remove(principal: Principal, space: string, id: string, via?: string): Promise<void> {
    this.#assertAccess(principal, space)
    if (!PAGE_ID.test(id)) throw notFound(id)
    const pointer = await this.#deps.git.readFile(space, pagePointerPath(id)).catch((err) => {
      throw err instanceof HearthError && err.code === 'not_found' ? notFound(id) : err
    })
    const html = await this.#deps.git.readFile(space, pageHtmlPath(id))
    const day = (this.#deps.now?.() ?? new Date()).toISOString().slice(0, 10)
    const trash = `${SPACE_LAYOUT.trash}/${day}-${id.slice(-8)}`
    const title = summaryOf(space, id, parseFrontmatter(pointer.content).data).title
    await this.#deps.git.commit(space, {
      changes: [
        { path: `${trash}/${pagePointerPath(id)}`, content: pointer.content },
        { path: `${trash}/${pageHtmlPath(id)}`, content: html.content },
        { path: pagePointerPath(id), content: null },
        { path: pageHtmlPath(id), content: null },
      ],
      author: { name: principal.name, email: principal.email },
      message: withVia(formatCommitMessage({ app: 'pages', verb: 'delete', title }), via),
      unchanged: { path: pagePointerPath(id), blobOid: pointer.blobOid },
    })
    await this.#deps.syncer.afterHeadChanged(space)
  }

  #assertAccess(principal: Principal, space: string) {
    if (!this.#deps.spaces.canAccess(principal, space)) {
      throw new HearthError('forbidden', `You don't have access to the space "${space}"`)
    }
  }
}

function summaryOf(space: string, id: string, fm: Record<string, unknown>): PageSummary {
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  return {
    space,
    id,
    title: str(fm.title) ?? 'Untitled page',
    created: str(fm.created),
    createdBy: str(fm.created_by),
    updated: str(fm.updated),
    updatedBy: str(fm.updated_by),
    shared: typeof fm.share === 'string' && SHARE_TOKEN.test(fm.share),
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** The words a reader sees on the page, for search: no scripts, styles or tags. */
export function pageText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template|svg|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(
      /<\/(p|div|h[1-6]|li|tr|section|article|header|footer|br|table|ul|ol|title)\s*>/gi,
      '\n',
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code =
          e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n[\s]*/g, '\n')
    .trim()
    .slice(0, MAX_PAGE_TEXT_CHARS)
}

const notFound = (id: string) => new HearthError('not_found', `No page ${id}`)
