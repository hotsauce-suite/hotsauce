// A member's screen-break settings (docs/PLAN-breaks.md B2): `.hearth/breaks.json` in their
// personal space, shared by the Mac app and every browser. The file is the truth; nothing about
// it is indexed.

import {
  BREAKS_PATH,
  type BreakSettings,
  BreakSettingsError,
  defaultBreakSettings,
  parseBreakSettings,
  readBreakSettings,
  serializeBreakSettings,
} from '@hotsauce/format'
import type { Principal } from '../auth/index.js'
import { HotsauceError } from '../errors.js'
import { formatCommitMessage, type GitStore } from '../git/index.js'
import type { SpaceService } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'

export interface BreaksDeps {
  git: Pick<GitStore, 'readFile' | 'commit'>
  spaces: Pick<SpaceService, 'visibleSpaces'>
  syncer: Pick<Syncer, 'afterHeadChanged'>
}

export interface BreaksView {
  settings: BreakSettings
  /** False until the member saves: they see the defaults. */
  saved: boolean
}

export class Breaks {
  readonly #deps: BreaksDeps

  constructor(deps: BreaksDeps) {
    this.#deps = deps
  }

  async get(principal: Principal): Promise<BreaksView> {
    const space = await this.#personalSpace(principal)
    if (!space) return { settings: defaultBreakSettings(), saved: false }
    try {
      const { content } = await this.#deps.git.readFile(space, BREAKS_PATH)
      return { settings: readBreakSettings(content), saved: true }
    } catch (err) {
      if (err instanceof HotsauceError && err.code === 'not_found')
        return { settings: defaultBreakSettings(), saved: false }
      throw err
    }
  }

  /** Validates and commits; saving the same settings is a no-op. */
  async save(principal: Principal, input: unknown): Promise<BreaksView> {
    let settings: BreakSettings
    try {
      settings = parseBreakSettings(input)
    } catch (err) {
      if (err instanceof BreakSettingsError) throw new HotsauceError('bad_request', err.message)
      throw err
    }
    const space = await this.#personalSpace(principal)
    if (!space)
      throw new HotsauceError('bad_request', 'You have no personal space to save breaks in')
    const content = serializeBreakSettings(settings)
    const current = await this.#deps.git.readFile(space, BREAKS_PATH).catch(() => null)
    if (current?.content !== content) {
      await this.#deps.git.commit(space, {
        changes: [{ path: BREAKS_PATH, content }],
        author: { name: principal.name, email: principal.email },
        message: formatCommitMessage({ app: 'breaks', verb: 'set', title: 'Screen breaks' }),
      })
      await this.#deps.syncer.afterHeadChanged(space)
    }
    return { settings, saved: true }
  }

  async #personalSpace(principal: Principal): Promise<string | null> {
    const spaces = await this.#deps.spaces.visibleSpaces(principal)
    return spaces.find((s) => s.kind === 'personal')?.name ?? null
  }
}
