import { randomBytes } from 'node:crypto'
import {
  FrontmatterError,
  parseFrontmatter,
  patchFrontmatter,
  resolveRelative,
} from '@hotsauce/format'
import type { Principal } from '../auth/index.js'
import { HotsauceError } from '../errors.js'
import { formatCommitMessage, type GitStore, withVia } from '../git/index.js'
import { normalizeRepoPath } from '../git/validate.js'
import { extractDoc, type FileKind, type Index, kindOf } from '../index/index.js'
import type { SpaceService } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'
import {
  checkLinkOptions,
  type LinkOptions,
  type LinkPolicy,
  type LinkStore,
  linkEnded,
  wantsNewLink,
} from './links.js'

/**
 * Read-only links (ARCHITECTURE §20): `share: <token>` in a doc's, meeting note's, note's or
 * page's frontmatter. Git is the record, so reindex rebuilds every link and a move keeps it.
 */

export type SharedKind = 'doc' | 'meeting' | 'note' | 'page'

const SHAREABLE: Partial<Record<FileKind, { kind: SharedKind; app: string }>> = {
  docs: { kind: 'doc', app: 'docs' },
  other: { kind: 'doc', app: 'docs' },
  meeting: { kind: 'meeting', app: 'meetings' },
  note: { kind: 'note', app: 'notes' },
  page: { kind: 'page', app: 'pages' },
}

export const SHARE_TOKEN = /^[A-Za-z0-9_-]{16,64}$/
const WRITE_ATTEMPTS = 3
/** Images a shared page may load from its space; an SVG can carry script, so it isn't one. */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
}

export interface ShareState {
  token: string | null
  url: string | null
  /** Who can open it and when it ends; null while there's no link. */
  link: LinkPolicy | null
}

/** What anyone holding the link sees: never the space or the path. */
export interface SharedItem {
  kind: SharedKind
  title: string
  /** The body without its frontmatter (docs, meeting notes, notes); empty for a page. */
  markdown: string
  /** A page's HTML (shown in a sandboxed frame), else absent. */
  html?: string
  /** When the file last changed, and who changed it. */
  updated: string | null
  updatedBy: string | null
}

/** The file behind a link, for the routes that need more than the public view. */
export interface SharedFile {
  space: string
  path: string
  kind: SharedKind
  content: string
  item: SharedItem
}

export interface SharesDeps {
  git: Pick<GitStore, 'readFile' | 'readBlob' | 'commit' | 'log'>
  index: Pick<Index, 'filesByShareToken'>
  spaces: Pick<SpaceService, 'canAccess'>
  syncer: Pick<Syncer, 'afterHeadChanged'>
  links: LinkStore
  /** Whether members may make links anyone can open (Settings → Organization). */
  allowAnyone: () => boolean
}

export const shareUrl = (token: string | null, link: LinkPolicy | null = null): ShareState => ({
  token,
  url: token ? `/s/${token}` : null,
  link: token ? link : null,
})

export class Shares {
  readonly #deps: SharesDeps
  constructor(deps: SharesDeps) {
    this.#deps = deps
  }

  async state(principal: Principal, space: string, rawPath: string): Promise<ShareState> {
    const { content } = await this.#readShareable(principal, space, rawPath)
    return this.#stateOf(tokenOf(content))
  }

  #stateOf(token: string | null): ShareState {
    return shareUrl(token, this.#deps.links.policy(token))
  }

  /**
   * Turns the link on (a fresh random token, with who it's for and when it ends) or off. A repeat
   * changes nothing; turning on a link that has ended makes a new one.
   */
  async set(
    principal: Principal,
    space: string,
    rawPath: string,
    on: boolean,
    via?: string,
    opts: LinkOptions = {},
  ): Promise<ShareState> {
    // Checked before any commit, so a refusal changes nothing; the same answer is used after it.
    const allowAnyone = this.#deps.allowAnyone()
    if (on) checkLinkOptions(opts, allowAnyone)
    for (let attempt = 1; ; attempt++) {
      const { path, content, blobOid, app, kind } = await this.#readShareable(
        principal,
        space,
        rawPath,
      )
      const current = tokenOf(content)
      const policy = this.#deps.links.policy(current)
      const live = current !== null && policy !== null && !policy.ended
      // A live link stays, unless the caller asked for a different one (a new token then).
      const keep = live && !wantsNewLink(policy, opts)
      if (on ? keep : current === null) return this.#stateOf(current)
      const token = on ? randomBytes(18).toString('base64url') : null
      let text: string
      try {
        text = patchFrontmatter(content, { share: token ?? undefined })
      } catch (err) {
        if (err instanceof FrontmatterError) throw new HotsauceError('bad_request', err.message)
        throw err
      }
      const message = withVia(
        formatCommitMessage({ app, verb: on ? 'share' : 'unshare', title: titleOf(path, content) }),
        via,
      )
      try {
        await this.#deps.git.commit(space, {
          changes: [{ path, content: text }],
          author: { name: principal.name, email: principal.email },
          message,
          unchanged: { path, blobOid },
          trusted: true,
        })
      } catch (err) {
        if (err instanceof HotsauceError && err.code === 'conflict' && attempt < WRITE_ATTEMPTS) {
          continue
        }
        throw err
      }
      await this.#deps.syncer.afterHeadChanged(space)
      if (current) this.#deps.links.delete(current)
      if (!token) return this.#stateOf(null)
      this.#deps.links.create(
        principal,
        { token, kind, ref: { space, path }, title: titleOf(path, content) },
        opts,
        allowAnyone,
      )
      return this.#stateOf(token)
    }
  }

  /** The file a link opens, re-read from Git so turning it off counts before the index catches up. */
  async open(token: string): Promise<SharedFile> {
    if (!SHARE_TOKEN.test(token)) throw notShared()
    if (this.#deps.links.policy(token)?.ended) throw linkEnded()
    for (const row of this.#deps.index.filesByShareToken(token)) {
      const target = this.#shareable(row.path)
      if (!target) continue
      const file = await this.#deps.git.readFile(row.space, row.path).catch(() => null)
      if (!file || tokenOf(file.content) !== token) continue
      const [last] = await this.#deps.git.log(row.space, { path: row.path, limit: 1 })
      const html =
        target.kind === 'page'
          ? (await this.#deps.git.readFile(row.space, row.path.replace(/\.md$/, '.html'))).content
          : undefined
      return {
        space: row.space,
        path: row.path,
        kind: target.kind,
        content: file.content,
        item: {
          kind: target.kind,
          title: titleOf(row.path, file.content),
          markdown: html === undefined ? parseFrontmatter(file.content).body : '',
          ...(html === undefined ? {} : { html }),
          updated: last?.date ?? null,
          updatedBy: last?.author.name ?? null,
        },
      }
    }
    throw notShared()
  }

  /** An image the shared doc itself shows, from its space's `assets/`; anything else is 404. */
  async asset(token: string, src: string): Promise<{ bytes: Buffer; contentType: string }> {
    const file = await this.open(token)
    if (file.kind === 'page' || !imageSources(file.item.markdown).has(src)) throw noAsset()
    let path: string
    try {
      path = normalizeRepoPath(resolveRelative(file.path, src))
    } catch {
      throw noAsset()
    }
    const contentType = IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? '']
    if (!path.startsWith('assets/') || !contentType) throw noAsset()
    const blob = await this.#deps.git.readBlob(file.space, path).catch(() => null)
    if (!blob) throw noAsset()
    return { bytes: blob.content, contentType }
  }

  #shareable(path: string) {
    if (!path.toLowerCase().endsWith('.md')) return null
    const fileKind = kindOf(path)
    return SHAREABLE[fileKind] ?? null
  }

  async #readShareable(principal: Principal, space: string, rawPath: string) {
    if (!this.#deps.spaces.canAccess(principal, space)) {
      throw new HotsauceError('forbidden', `You don't have access to the space "${space}"`)
    }
    const path = normalizeRepoPath(rawPath)
    const target = path.split('/').some((s) => s.startsWith('.')) ? null : this.#shareable(path)
    if (!target) {
      throw new HotsauceError(
        'bad_request',
        'Only a doc, a meeting note, a note or a page can have a read-only link',
      )
    }
    const file = await this.#deps.git.readFile(space, path)
    return { path, content: file.content, blobOid: file.blobOid, ...target }
  }
}

/**
 * The rule every markdown write passes through (GitStore `guardMarkdown`): a file may carry a
 * read-only link only if it is the one the path already has. Share is the one writer that makes
 * a new link, and its commit is `trusted`. Whatever way the text came in (a save, a merge, a
 * conflict resolve, an upload, a rename into `.md`, an AI tool), a link someone chose is refused.
 */
export function assertOwnShare(path: string, text: string, previous: string | null): void {
  const sent = tokenOf(text)
  if (sent === null) return
  if (previous !== null && tokenOf(previous) === sent) return
  throw new HotsauceError(
    'bad_request',
    `${path} has a "share" line in its header that Hotsauce didn't write. Remove that line; read-only links are made with Share.`,
  )
}

function tokenOf(content: string): string | null {
  try {
    const share = parseFrontmatter(content).data.share
    return typeof share === 'string' && SHARE_TOKEN.test(share) ? share : null
  } catch {
    return null
  }
}

/** The title the index would give it; a note without one is named by its first line. */
function titleOf(path: string, content: string): string {
  const doc = extractDoc(path, content)
  if (doc.kind === 'note' && typeof doc.frontmatter?.title !== 'string') {
    const first = doc.body.split('\n').find((l) => l.trim())
    return first ? first.replace(/^\s*(- \[[ x]\]\s*)?/i, '').slice(0, 60) : 'Untitled note'
  }
  return doc.title
}

/** Every image source in the markdown: `![alt](src "title")` and `<img src="…">`. */
function imageSources(markdown: string): Set<string> {
  const out = new Set<string>()
  for (const m of markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    if (m[1]) out.add(m[1])
  }
  for (const m of markdown.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    if (m[1]) out.add(m[1])
  }
  return out
}

const notShared = () => new HotsauceError('not_found', 'This link doesn’t exist or was turned off')
const noAsset = () => new HotsauceError('not_found', 'No such image')
