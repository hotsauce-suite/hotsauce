// Hand-written mirror of ARCHITECTURE §3.2 and §3.8. Keep in step with the server's AppType.

export type AuthMode = 'dev' | 'clerk' | 'setup'

export interface Health {
  ok: boolean
  authMode: AuthMode
  /** A fresh instance: only the setup wizard works until it's finished. */
  setupRequired?: boolean
  productName?: string
  orgName?: string
  clerkPublishableKey?: string | null
  chatUrl?: string | null
  signInDomain?: string | null
  /** Invited people outside the domains can sign in with an emailed code. */
  emailCodeSignIn?: boolean
  features?: { ai: boolean; transcription: boolean }
  /** Added by the root loader from /api/org/brand. */
  brand?: PublicBrand | null
}

/** The organization's brand kit, as GET /api/org/brand serves it (ARCHITECTURE §11.3). */
export interface PublicBrand {
  productName: string
  orgName: string
  primary: string
  accent: string
  neutral: 'warm' | 'cool' | 'gray'
  fonts: { choice: string; label: string; display: string; ui: string }
  defaultTheme: 'system' | 'light' | 'dark'
  logoUrl: string | null
  markUrl: string | null
  voice: string
  updatedAt: string | null
}

export interface Principal {
  userId: string
  email: string
  name: string
  handle: string
  isAdmin: boolean
}

export interface Space {
  name: string
  kind: 'team' | 'personal'
  label: string
}

export interface Me {
  principal: Principal
  spaces: Space[]
  settings: { idleCommitMs: number }
}

export interface Entry {
  path: string
  type: 'file' | 'dir'
  size?: number
  oid?: string
}

export interface FileContent {
  content: string
  blobOid: string
  headOid: string
}

export interface Author {
  name: string
  email: string
}

export interface Commit {
  oid: string
  author: Author
  date: string
  message: string
  label?: string
}

// `committed` carries `content` when the server changed the text it was sent (it adds a
// frontmatter `id` on save); adopt it exactly like `merged` content.
export type CommitResult =
  | { status: 'committed'; oid: string; blobOid: string; content?: string }
  | { status: 'merged'; oid: string; blobOid: string; content: string }
  | {
      status: 'conflict'
      conflictRef: string
      theirs: { blobOid: string; content: string }
      ours: { content: string }
    }

export interface PutFileBody {
  path: string
  content: string
  baseBlobOid?: string
  /** Refuse (409) rather than replace a file already at `path`: a new doc's first save. */
  createOnly?: boolean
  message?: string
  label?: string
}

export interface ConflictSummary {
  ref: string
  path: string
  createdAt: string
}

export interface ConflictDetail {
  path: string
  ours: { content: string }
  /** What main has now; null when the file is gone from main. */
  theirs: { content: string; blobOid: string } | null
}

export interface SearchResult {
  space: string
  path: string
  title: string
  /** Matched terms are wrapped in \u0002 … \u0003. */
  snippet: string
  score: number
}

export interface RecentItem {
  space: string
  path: string
  openedAt: string
  title: string | null
}

export interface StarItem {
  space: string
  path: string
  title: string | null
}

export type ServerEvent =
  | { type: 'changed'; space: string; headOid: string; paths: string[] }
  | { type: 'conflict'; space: string; path: string; ref: string }

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown }
}

// ---------------------------------------------------------------------------------------------
// Hearth Meetings: hand-written mirror of ARCHITECTURE §7.1–7.3.

export type Track = 'me' | 'them'

export interface TranscriptSegment {
  track: Track
  speaker: string
  /** Milliseconds from the session start. */
  at: number
  durationMs: number
  text: string
  /** A partial (`false`) replaces the previous partial on the same track. */
  final: boolean
}

export type MeetingState = 'recording' | 'paused' | 'stopped' | 'saved'

export interface MeetingSession {
  id: string
  /** The owner's email. */
  owner: string
  space: string
  title: string
  template: string
  calendarEventId?: string
  /** The Google Meet call it records ("abc-defg-hij"), when known. */
  meetCode?: string
  startedAt: string
  state: MeetingState
  /** The member's Keep audio choice, once made; otherwise Stop uses the server's default. */
  keepAudio?: boolean
  rawNotes: string
  segments: TranscriptSegment[]
}

export interface CreateSessionBody {
  title?: string
  template?: string
  calendarEventId?: string
  /** The Google Meet call it records, so resuming capture later finds that tab. */
  meetCode?: string
  /** The owner's IANA time zone; the note's date and file name use it (ARCHITECTURE §7.4). */
  tz?: string
}

export interface StopResult {
  space: string
  path: string
  transcriptPath: string
}

export interface CalendarAttendee {
  email: string
  name?: string
}

export interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  attendees: CalendarAttendee[]
  description?: string
  meetLink?: string
  /** The Google series (`recurringEventId`) this occurrence belongs to. */
  seriesId?: string
  /** The Google calendar it came from. */
  calendarId?: string
}

/** `GET /api/calendar/status`, `POST /api/calendar/refresh` (ARCHITECTURE §7.8). */
export interface CalendarStatus {
  lastSyncedAt: string | null
  /** The last sync's failure, null after a success. */
  error: string | null
}

/** `GET /api/calendar/match?meet=`: the event a Meet call belongs to. */
export interface CalendarMatch {
  event: CalendarEvent | null
  by: 'meet' | 'now' | null
}

/** A past calendar meeting, with the note taken for it if there is one. */
export interface CoverageItem {
  event: CalendarEvent
  note: { space: string; path: string; title: string } | null
}

/** One of the member's Google calendars; primary is always synced. */
export interface CalendarChoice {
  id: string
  name: string
  primary: boolean
  selected: boolean
  color?: string
}

export interface MeetingTemplate {
  id: string
  name: string
  description: string
  source: 'builtin' | 'team' | 'personal'
}

/** A row of `GET /api/meetings`, with absent frontmatter keys normalized by the client. */
export interface MeetingSummary {
  space: string
  path: string
  title: string
  date: string
  duration_min: number | null
  /** As written in frontmatter: `Name <email>`. */
  attendees: string[]
  companies: string[]
  template: string | null
  hasTranscript: boolean
}

export interface MeetingFilters {
  space?: string
  from?: string
  to?: string
  person?: string
  company?: string
  folder?: string
}

export interface EnhanceBody {
  space: string
  path: string
  template?: string
  /** Re-enhance even though the note was edited since the last enhance. */
  force?: boolean
}

export interface EnhanceResult {
  path: string
  aiRanges: Array<[number, number]>
  usage: { input: number; output: number }
}

export interface ChatScope {
  space?: string
  meetingPath?: string
  folder?: string
  person?: string
  company?: string
}

export interface ChatCitation {
  space: string
  path: string
  /** 1-based line in the cited file. */
  line: number
  text: string
}

export interface ChatAnswer {
  answer: string
  citations: ChatCitation[]
}

/** Text frames the server sends on `/ws/meetings/:id`. */
export type MeetingServerMessage =
  | { type: 'ready'; sessionId: string; resumeFrom: Record<Track, number> }
  | { type: 'segment'; segment: TranscriptSegment }
  | { type: 'state'; state: MeetingState }
  | { type: 'error'; message: string }

/** Text frames the client sends after auth; audio goes as binary frames. */
export type MeetingClientMessage =
  | { type: 'notes'; text: string }
  | { type: 'pause' }
  | { type: 'resume' }

/** `GET /api/meetings/action-items`: a meeting note's open `- [ ]` lines, with their file line. */
export interface MeetingActionItems {
  space: string
  path: string
  title: string
  date: string
  items: Array<{ line: number; text: string }>
}
