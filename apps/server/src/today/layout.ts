// The member's Today layout (ARCHITECTURE §16.4): `.hearth/today.json` in their personal space.
// The file is the truth; nothing about it is indexed.

import {
  defaultTodayLayout,
  offerGettingStarted,
  parseTodayLayout,
  serializeTodayLayout,
  TODAY_LAYOUT_PATH,
  type TodayLayout,
  TodayLayoutError,
} from '@hotsauce/format'
import type { Principal } from '../auth/index.js'
import { HotsauceError } from '../errors.js'
import { formatCommitMessage, type GitStore } from '../git/index.js'
import type { SpaceService } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'

export interface TodayLayoutsDeps {
  git: Pick<GitStore, 'readFile' | 'commit'>
  spaces: Pick<SpaceService, 'visibleSpaces'>
  syncer: Pick<Syncer, 'afterHeadChanged'>
}

export interface TodayLayoutView {
  layout: TodayLayout
  /** False until the member saves one: they see the default. */
  saved: boolean
}

export class TodayLayouts {
  readonly #deps: TodayLayoutsDeps

  constructor(deps: TodayLayoutsDeps) {
    this.#deps = deps
  }

  async get(principal: Principal): Promise<TodayLayoutView> {
    const space = await this.#personalSpace(principal)
    if (!space) return { layout: offerGettingStarted(defaultTodayLayout()), saved: false }
    let content: string
    try {
      content = (await this.#deps.git.readFile(space, TODAY_LAYOUT_PATH)).content
    } catch (err) {
      if (err instanceof HotsauceError && err.code === 'not_found')
        return { layout: offerGettingStarted(defaultTodayLayout()), saved: false }
      throw err
    }
    try {
      // A layout saved before Getting started existed is offered it once (PLAN-getting-started F4).
      return { layout: offerGettingStarted(parseTodayLayout(content)), saved: true }
    } catch (err) {
      // A hand-edited file that no longer parses: show the default rather than an empty Today.
      if (err instanceof TodayLayoutError)
        return { layout: offerGettingStarted(defaultTodayLayout()), saved: false }
      throw err
    }
  }

  /** Validates (dropping tiles it doesn't know) and commits; saving the same layout is a no-op. */
  async save(principal: Principal, input: unknown): Promise<TodayLayoutView> {
    let layout: TodayLayout
    try {
      layout = parseTodayLayout(input)
    } catch (err) {
      if (err instanceof TodayLayoutError) throw new HotsauceError('bad_request', err.message)
      throw err
    }
    const space = await this.#personalSpace(principal)
    if (!space)
      throw new HotsauceError(
        'bad_request',
        'You have no personal space to save your Today layout in',
      )
    const content = serializeTodayLayout(layout)
    const current = await this.#deps.git.readFile(space, TODAY_LAYOUT_PATH).catch(() => null)
    if (current?.content !== content) {
      await this.#deps.git.commit(space, {
        changes: [{ path: TODAY_LAYOUT_PATH, content }],
        author: { name: principal.name, email: principal.email },
        message: formatCommitMessage({ app: 'today', verb: 'arrange', title: 'Today' }),
      })
      await this.#deps.syncer.afterHeadChanged(space)
    }
    // As the file now reads, with its Getting started mark.
    return { layout: parseTodayLayout(content), saved: true }
  }

  async #personalSpace(principal: Principal): Promise<string | null> {
    const spaces = await this.#deps.spaces.visibleSpaces(principal)
    return spaces.find((s) => s.kind === 'personal')?.name ?? null
  }
}
