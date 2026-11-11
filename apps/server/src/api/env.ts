import type { Authenticator, Principal } from '../auth/index.js'
import type { Clips } from '../clips/index.js'
import type { Config } from '../config.js'
import type { Dictation } from '../dictation/index.js'
import type { Author, GitStore } from '../git/index.js'
import type { HostAdapter } from '../hosts/index.js'
import type { Index } from '../index/index.js'
import type { MeetingServices } from '../meetings/index.js'
import type { BrandStore } from '../org/brand.js'
import type { OrgStore } from '../org/store.js'
import type { SpaceService } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'
import type { TokenStore } from '../tokens/index.js'

/** Everything the API is built from; tests pass a temp data dir, LocalHost and DevAuth. */
export interface AppDeps {
  config: Config
  git: GitStore
  host: HostAdapter
  index: Index
  auth: Authenticator
  tokens: TokenStore
  spaces: SpaceService
  syncer: Syncer
  meetings: MeetingServices
  dictation: Dictation
  clips: Clips
  org: OrgStore
  brand: BrandStore
  /** Stops gracefully and exits so the process manager starts us with the new settings. */
  restart?: () => void
}

export type AppEnv = {
  Variables: {
    principal: Principal
    /** Set when a Hearth Dictate device token authenticated the request: that device's id. */
    deviceId?: string
  }
}

/** Commits made for a member are authored by them; Hearth is only the committer. */
export function authorOf(p: Principal): Author {
  return { name: p.name, email: p.email }
}
