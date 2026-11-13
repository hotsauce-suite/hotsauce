import type { Assistant } from '../assistant/index.js'
import type { Authenticator, Principal } from '../auth/index.js'
import type { BackupService } from '../backup/index.js'
import type { Boards } from '../boards/index.js'
import type { AgentBriefs } from '../brief/index.js'
import type { Briefcasts } from '../briefcast/index.js'
import type { CheckinScheduler, Checkins } from '../checkins/index.js'
import type { Clips } from '../clips/index.js'
import type { Config } from '../config.js'
import type { Dictation } from '../dictation/index.js'
import type { Feedback } from '../feedback/index.js'
import type { Files } from '../files/index.js'
import type { ChatRooms, Forms } from '../forms/index.js'
import type { Author, GitStore } from '../git/index.js'
import type { HostAdapter } from '../hosts/index.js'
import type { Index } from '../index/index.js'
import type { Links } from '../links/index.js'
import type { MeetingServices } from '../meetings/index.js'
import type { Notes } from '../notes/index.js'
import type { BrandStore } from '../org/brand.js'
import type { OrgStore } from '../org/store.js'
import type { Pages } from '../pages/index.js'
import type { People } from '../people/index.js'
import type { Bookings } from '../scheduling/index.js'
import type { Shares } from '../shares/index.js'
import type { SpaceService } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'
import type { Tables } from '../tables/index.js'
import type { TaskServices } from '../tasks/index.js'
import type { TokenStore } from '../tokens/index.js'
import type { Updater } from '../updates/index.js'

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
  assistant: Assistant
  clips: Clips
  tasks: TaskServices
  notes: Notes
  files: Files
  briefs: AgentBriefs
  feedback: Feedback
  boards: Boards
  people: People
  bookings: Bookings
  briefcasts: Briefcasts
  shares: Shares
  pages: Pages
  forms: Forms
  chatRooms: ChatRooms
  tables: Tables
  links: Links
  checkins: Checkins
  checkinScheduler: CheckinScheduler
  org: OrgStore
  brand: BrandStore
  updates: Updater
  /** Daily backups; null when there's no bucket or BACKUP=off. */
  backups: BackupService | null
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
