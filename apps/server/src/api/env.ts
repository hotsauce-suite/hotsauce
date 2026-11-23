import type { AccountStore, SignInPhotos } from '../account/index.js'
import type { Assistant } from '../assistant/index.js'
import type { Authenticator, Principal } from '../auth/index.js'
import type { BackupService } from '../backup/index.js'
import type { Boards } from '../boards/index.js'
import type { AgentBriefs } from '../brief/index.js'
import type { Briefcasts } from '../briefcast/index.js'
import type { ChatReader } from '../chat/index.js'
import type { CheckinScheduler, Checkins } from '../checkins/index.js'
import type { Clips } from '../clips/index.js'
import type { Comments } from '../comments/index.js'
import type { Config } from '../config.js'
import type { Dictation } from '../dictation/index.js'
import type { Feedback } from '../feedback/index.js'
import type { Files } from '../files/index.js'
import type { ChatRooms, Forms } from '../forms/index.js'
import type { ForYou } from '../foryou/index.js'
import type { Author, GitStore } from '../git/index.js'
import type { HostAdapter } from '../hosts/index.js'
import type { Index } from '../index/index.js'
import type { Links } from '../links/index.js'
import type { MeetingServices } from '../meetings/index.js'
import type { Notes } from '../notes/index.js'
import type { ClientMetadataResolver, OAuthStore } from '../oauth/index.js'
import type { BrandStore } from '../org/brand.js'
import type { BrandFonts } from '../org/brandFonts.js'
import type { OrgStore } from '../org/store.js'
import type { Pages } from '../pages/index.js'
import type { People } from '../people/index.js'
import type { Bookings } from '../scheduling/index.js'
import type { LinkStore, Shares } from '../shares/index.js'
import type { Sign } from '../sign/index.js'
import type { SlideDrafter } from '../slides/index.js'
import type { SpaceService } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'
import type { Tables } from '../tables/index.js'
import type { TaskServices } from '../tasks/index.js'
import type { Themes } from '../themes/index.js'
import type { TokenStore } from '../tokens/index.js'
import type { Updater } from '../updates/index.js'
import type { Usage } from '../usage/index.js'

/** Everything the API is built from; tests pass a temp data dir, LocalHost and DevAuth. */
export interface AppDeps {
  config: Config
  git: GitStore
  host: HostAdapter
  index: Index
  account: AccountStore
  /** Members' sign-in pictures as default profile photos; absent where sign-in has none. */
  signInPhotos?: SignInPhotos
  auth: Authenticator
  tokens: TokenStore
  oauth: OAuthStore
  clientMetadata: ClientMetadataResolver
  spaces: SpaceService
  syncer: Syncer
  meetings: MeetingServices
  dictation: Dictation
  assistant: Assistant
  clips: Clips
  tasks: TaskServices
  /** Each member's own themes (docs/PLAN-ai-themes.md). */
  themes: Themes
  notes: Notes
  files: Files
  briefs: AgentBriefs
  feedback: Feedback
  /** Draft slides from a doc (docs/PLAN-slides.md). */
  slides: SlideDrafter
  boards: Boards
  people: People
  bookings: Bookings
  briefcasts: Briefcasts
  shares: Shares
  /** Who each read-only link is for and when it ends (docs/PLAN-outside-links.md). */
  shareLinks: LinkStore
  pages: Pages
  forms: Forms
  /** Sign: envelopes in Git, the PDFs in Files (docs/PLAN-sign.md). */
  sign: Sign
  chatRooms: ChatRooms
  /** The copy of the chat rooms read for context (docs/PLAN-chat-context.md). */
  chatReader: ChatReader
  tables: Tables
  links: Links
  checkins: Checkins
  checkinScheduler: CheckinScheduler
  /** The conversation under a team item (ARCHITECTURE §27). */
  comments: Comments
  /** What is waiting on each member (ARCHITECTURE §27.5). */
  forYou: ForYou
  org: OrgStore
  brand: BrandStore
  /** The brand's fonts as TTF files, for downloaded documents. */
  brandFonts: BrandFonts
  updates: Updater
  /** The admin Usage page's numbers (docs/PLAN-app-usage.md). */
  usage: Usage
  /** Daily backups; null when there's no bucket or BACKUP=off. */
  backups: BackupService | null
  /** Stops gracefully and exits so the process manager starts us with the new settings. */
  restart?: () => void
}

export type AppEnv = {
  Variables: {
    principal: Principal
    /** Set when a Hotsauce Dictate device token authenticated the request: that device's id. */
    deviceId?: string
  }
}

/** Commits made for a member are authored by them; Hotsauce is only the committer. */
export function authorOf(p: Principal): Author {
  return { name: p.name, email: p.email }
}
