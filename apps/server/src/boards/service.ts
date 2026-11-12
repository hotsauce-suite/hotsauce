import {
  BoardFormatError,
  BoardFrontmatter,
  type BoardScene,
  boardBodyText,
  boardIdOf,
  boardPath,
  boardTexts,
  boardTitle,
  FrontmatterError,
  liveElements,
  mergeScenes,
  newBoardFile,
  parseBoardBody,
  parseFrontmatter,
  patchFrontmatter,
  SPACE_LAYOUT,
  tidyScene,
} from '@hearth/format'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import { type CommitResult, formatCommitMessage, type GitStore, withVia } from '../git/index.js'
import type { Index } from '../index/index.js'
import { type Space, type SpaceService, TEAM_SPACE } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'

export const MAX_BOARD_LIST = 1000
const WRITE_ATTEMPTS = 3
const BOARD_ID = /^[0-9A-Z]{26}$/

/** A board in a list: no drawing data. */
export interface BoardSummary {
  space: string
  path: string
  id: string
  blobOid: string
  title: string
  created: string
  createdBy: string
  updated: string
  updatedBy: string | null
}

/** One board, with its scene. */
export interface BoardView extends BoardSummary {
  scene: BoardScene
  /** The text on the board, one line per text element. */
  texts: string[]
}

export interface BoardFilter {
  space?: string | undefined
  q?: string | undefined
  limit?: number | undefined
}

type BoardsGit = Pick<GitStore, 'readFile' | 'commit'>
type BoardsIndex = Pick<Index, 'listFiles' | 'search'>

export interface BoardsDeps {
  git: BoardsGit
  index: BoardsIndex
  spaces: Pick<SpaceService, 'visibleSpaces' | 'canAccess'>
  syncer: Pick<Syncer, 'afterHeadChanged'>
  now?: () => Date
}

function isoNow(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function parseBoardFm(data: unknown): BoardFrontmatter | null {
  const parsed = BoardFrontmatter.safeParse(data)
  return parsed.success ? parsed.data : null
}

/** What a commit and a list call a board. */
export function boardName(title: string | undefined): string {
  const clean = boardTitle(title ?? '').replace(/"/g, "'")
  if (!clean) return 'Untitled board'
  return clean.length > 60 ? `${clean.slice(0, 59)}…` : clean
}

function summaryOf(
  space: string,
  path: string,
  id: string,
  blobOid: string,
  fm: BoardFrontmatter,
): BoardSummary {
  return {
    space,
    path,
    id,
    blobOid,
    title: fm.title ?? '',
    created: fm.created,
    createdBy: fm.created_by.toLowerCase(),
    updated: fm.updated ?? fm.created,
    updatedBy: fm.updated_by?.toLowerCase() ?? null,
  }
}

/** Every image a scene points at must be a file in the space's assets folder. */
function checkFiles(scene: BoardScene): void {
  for (const file of Object.values(scene.files)) {
    const p = file.path
    if (
      !p.startsWith(`${SPACE_LAYOUT.assets}/`) ||
      p.split('/').some((s) => s === '..' || s === '')
    ) {
      throw new HearthError(
        'bad_request',
        `A board's images must be files under ${SPACE_LAYOUT.assets}/`,
      )
    }
  }
}

/**
 * Hearth Whiteboard on the server (ARCHITECTURE §15.2): one Markdown file per board, listed from
 * the index. A save sends the whole scene with the version it started from; if the board changed
 * meanwhile, the two are merged element by element, so two people never lose each other's shapes.
 */
export class Boards {
  readonly #git: BoardsGit
  readonly #index: BoardsIndex
  readonly #spaces: BoardsDeps['spaces']
  readonly #syncer: BoardsDeps['syncer']
  readonly #now: () => Date

  constructor(deps: BoardsDeps) {
    this.#git = deps.git
    this.#index = deps.index
    this.#spaces = deps.spaces
    this.#syncer = deps.syncer
    this.#now = deps.now ?? (() => new Date())
  }

  /** Boards in the member's visible spaces, newest change first, from the index. */
  async list(principal: Principal, filter: BoardFilter = {}): Promise<BoardSummary[]> {
    const visible = await this.#spaces.visibleSpaces(principal)
    if (filter.space) this.#assertAccess(principal, filter.space)
    const scope = filter.space ? visible.filter((s) => s.name === filter.space) : visible
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? MAX_BOARD_LIST), 1), MAX_BOARD_LIST)
    const matching = filter.q?.trim() ? this.#searchPaths(filter.q, scope) : null
    return this.#summaries(scope)
      .filter((b) => matching === null || matching.has(`${b.space}\n${b.path}`))
      .sort((a, b) => b.updated.localeCompare(a.updated) || b.id.localeCompare(a.id))
      .slice(0, limit)
  }

  async get(principal: Principal, space: string, id: string): Promise<BoardView> {
    this.#assertAccess(principal, space)
    const file = await this.#read(space, id)
    return this.#view(space, file.path, file.blobOid, file.fm, file.scene)
  }

  /** A new board, in the member's personal space unless `space` says otherwise. */
  async create(
    principal: Principal,
    input: {
      title?: string | undefined
      space?: string | undefined
      scene?: BoardScene | undefined
    },
    via?: string,
  ): Promise<BoardView> {
    const space = input.space ?? (await this.#personalSpace(principal)) ?? TEAM_SPACE
    this.#assertAccess(principal, space)
    if (input.scene) checkFiles(input.scene)
    const file = newBoardFile({
      title: input.title,
      scene: input.scene ? tidyScene(input.scene) : undefined,
      createdBy: principal.email,
      created: isoNow(this.#now()),
    })
    const result = await this.#commit(principal, space, {
      changes: [{ path: file.path, content: file.text }],
      verb: 'create',
      title: boardName(input.title),
      via,
    })
    const parsed = parseFrontmatter(file.text)
    const fm = parseBoardFm(parsed.data) as BoardFrontmatter
    return this.#view(space, file.path, blobOf(result, file.path), fm, parseBoardBody(parsed.body))
  }

  /**
   * Saves a board. `scene` is the whole drawing as the client has it; `baseBlobOid` the version
   * it started from. When the board changed since, the saved scene and this one are merged
   * (higher element version wins), and the answer carries the merged scene.
   */
  async save(
    principal: Principal,
    space: string,
    id: string,
    input: {
      scene?: BoardScene | undefined
      title?: string | undefined
      baseBlobOid?: string | undefined
    },
    via?: string,
  ): Promise<BoardView & { merged: boolean }> {
    this.#assertAccess(principal, space)
    if (input.scene) checkFiles(input.scene)
    for (let attempt = 1; ; attempt++) {
      const cur = await this.#read(space, id)
      let scene = cur.scene
      let merged = false
      if (input.scene) {
        if (input.baseBlobOid && input.baseBlobOid === cur.blobOid) {
          // A save sends only the canvas settings it changed.
          scene = { ...input.scene, appState: { ...cur.scene.appState, ...input.scene.appState } }
        } else {
          scene = mergeScenes(cur.scene, input.scene)
          merged = true
        }
        scene = tidyScene(scene)
      }
      const fields: Record<string, unknown> = {}
      if (input.title !== undefined) fields.title = boardTitle(input.title) || undefined
      const sceneChanged =
        input.scene !== undefined && JSON.stringify(scene) !== JSON.stringify(cur.scene)
      const titleChanged =
        input.title !== undefined && boardTitle(input.title) !== (cur.fm.title ?? '')
      if (!sceneChanged && !titleChanged) {
        return { ...this.#view(space, cur.path, cur.blobOid, cur.fm, cur.scene), merged }
      }
      fields.updated = isoNow(this.#now())
      fields.updated_by = principal.email.toLowerCase()
      let text = patchFrontmatter(cur.content, fields)
      if (sceneChanged) {
        const { body } = parseFrontmatter(text)
        text = text.slice(0, text.length - body.length) + boardBodyText(scene)
      }
      const fm = parseBoardFm(parseFrontmatter(text).data) as BoardFrontmatter
      try {
        const result = await this.#commit(principal, space, {
          changes: [{ path: cur.path, content: text }],
          verb: titleChanged && !sceneChanged ? 'rename' : 'edit',
          title: boardName(fm.title),
          via,
          unchanged: { path: cur.path, blobOid: cur.blobOid },
        })
        return { ...this.#view(space, cur.path, blobOf(result, cur.path), fm, scene), merged }
      } catch (err) {
        if (!(err instanceof HearthError && err.code === 'conflict') || attempt >= WRITE_ATTEMPTS) {
          throw err
        }
        // Someone saved in between: the next attempt merges with their version.
      }
    }
  }

  /** Deletes a board: the file moves to `.trash/<YYYY-MM-DD>-<id8>/boards/<id>.md`, like a deleted doc. */
  async remove(principal: Principal, space: string, id: string, via?: string): Promise<void> {
    this.#assertAccess(principal, space)
    const day = isoNow(this.#now()).slice(0, 10)
    for (let attempt = 1; ; attempt++) {
      const cur = await this.#read(space, id)
      const trashPath = `${SPACE_LAYOUT.trash}/${day}-${id.slice(-8)}/${cur.path}`
      try {
        await this.#commit(principal, space, {
          changes: [
            { path: trashPath, content: cur.content },
            { path: cur.path, content: null },
          ],
          verb: 'delete',
          title: boardName(cur.fm.title),
          via,
          unchanged: { path: cur.path, blobOid: cur.blobOid },
        })
        return
      } catch (err) {
        if (!(err instanceof HearthError && err.code === 'conflict') || attempt >= WRITE_ATTEMPTS) {
          throw err
        }
      }
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  #view(
    space: string,
    path: string,
    blobOid: string,
    fm: BoardFrontmatter,
    scene: BoardScene,
  ): BoardView {
    const id = boardIdOf(path) as string
    return {
      ...summaryOf(space, path, id, blobOid, fm),
      scene,
      texts: boardTexts({ elements: liveElements(scene) }),
    }
  }

  #assertAccess(principal: Principal, space: string): void {
    if (!this.#spaces.canAccess(principal, space)) {
      throw new HearthError('forbidden', `You don't have access to the space "${space}"`)
    }
  }

  async #personalSpace(principal: Principal): Promise<string | null> {
    return (
      (await this.#spaces.visibleSpaces(principal)).find((s) => s.kind === 'personal')?.name ?? null
    )
  }

  #summaries(spaces: Pick<Space, 'name'>[]): BoardSummary[] {
    const out: BoardSummary[] = []
    for (const s of spaces) {
      for (const row of this.#index.listFiles({ space: s.name, kind: 'board' })) {
        const id = boardIdOf(row.path)
        const fm = id ? parseBoardFm(row.frontmatter) : null
        if (id && fm) out.push(summaryOf(s.name, row.path, id, row.blobOid, fm))
      }
    }
    return out
  }

  #searchPaths(q: string, spaces: Pick<Space, 'name'>[]): Set<string> {
    const hits = this.#index.search(q, {
      spaces: spaces.map((s) => s.name),
      kinds: ['board'],
      limit: MAX_BOARD_LIST,
    })
    return new Set(hits.map((h) => `${h.space}\n${h.path}`))
  }

  async #read(
    space: string,
    id: string,
  ): Promise<{
    path: string
    content: string
    blobOid: string
    fm: BoardFrontmatter
    scene: BoardScene
  }> {
    if (!BOARD_ID.test(id)) throw new HearthError('not_found', `No board ${id} in ${space}`)
    const path = boardPath(id)
    let file: { content: string; blobOid: string }
    try {
      file = await this.#git.readFile(space, path)
    } catch (err) {
      if (err instanceof HearthError && err.code === 'not_found') {
        throw new HearthError('not_found', `No board ${id} in ${space}`)
      }
      throw err
    }
    try {
      const parsed = parseFrontmatter(file.content)
      const fm = parseBoardFm(parsed.data)
      if (!fm) throw new HearthError('bad_request', `${path} in ${space} isn’t a board`)
      return {
        path,
        content: file.content,
        blobOid: file.blobOid,
        fm,
        scene: parseBoardBody(parsed.body),
      }
    } catch (err) {
      if (err instanceof FrontmatterError || err instanceof BoardFormatError) {
        throw new HearthError('bad_request', `${path} in ${space}: ${err.message}`)
      }
      throw err
    }
  }

  async #commit(
    principal: Principal,
    space: string,
    args: {
      changes: Array<{ path: string; content: string | null }>
      verb: string
      title: string
      via: string | undefined
      unchanged?: { path: string; blobOid: string }
    },
  ): Promise<CommitResult> {
    const message = withVia(
      formatCommitMessage({ app: 'boards', verb: args.verb, title: args.title }),
      args.via,
    )
    const result = await this.#git.commit(space, {
      changes: args.changes,
      author: { name: principal.name, email: principal.email },
      message,
      ...(args.unchanged ? { unchanged: args.unchanged } : {}),
    })
    await this.#syncer.afterHeadChanged(space)
    return result
  }
}

function blobOf(result: CommitResult, path: string): string {
  if (result.status === 'conflict')
    throw new HearthError('internal', `Unexpected conflict on ${path}`)
  return result.blobOid
}
