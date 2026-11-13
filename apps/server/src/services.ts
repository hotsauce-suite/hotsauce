import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { createClerkClient } from '@clerk/backend'
import { initialSpaceFiles, rewriteLinksForMove } from '@hearth/format'
import dotenv from 'dotenv'
import { type Authenticator, createAuthenticator, type Principal } from './auth/index.js'
import { createBackups } from './backup/index.js'
import { BoardRooms, Boards } from './boards/index.js'
import { AgentBriefs, BriefMembers } from './brief/index.js'
import {
  BriefcastState,
  Briefcasts,
  FakeSpeaker,
  OpenAISpeaker,
  type Speaker,
  UnconfiguredSpeaker,
} from './briefcast/index.js'
import { CheckinMembers, CheckinScheduler, Checkins } from './checkins/index.js'
import {
  ClipStore,
  Clips,
  type ClipTranscriber,
  DeepgramClipTranscriber,
  FakeClipTranscriber,
} from './clips/index.js'
import type { Config } from './config.js'
import {
  DeepgramDictationTranscriber,
  Dictation,
  DictationSocketServer,
  DictationStore,
  type DictationTranscriber,
  FakeDictationTranscriber,
} from './dictation/index.js'
import {
  Clarifier,
  Feedback,
  type FeedbackTracker,
  GitHubTracker,
  MemoryTracker,
} from './feedback/index.js'
import { Files } from './files/index.js'
import { ChatRooms, Forms } from './forms/index.js'
import { GitStore } from './git/index.js'
import { createHostAdapter } from './hosts/index.js'
import { Index, Indexer, indexPath } from './index/index.js'
import { fakePageFetcher, fetchPage, Links, type PageFetcher } from './links/index.js'
import {
  DeepgramRetranscriber,
  type MeetingRetranscriber,
  TranscriptCleanup,
} from './meetings/cleanup/index.js'
import {
  AnthropicLLM,
  type AudioStore,
  CachedCalendar,
  CalendarCache,
  type CalendarSource,
  CalendarSync,
  clerkGoogleGrant,
  createAudioStore,
  DeepgramTranscriber,
  Enhancer,
  FakeGoogle,
  FakeLLM,
  FakeTranscriber,
  fakeGoogleToken,
  GoogleCalendarHttp,
  type GoogleGrantSource,
  type LLM,
  MeetingChat,
  type MeetingServices,
  MeetingSessions,
  MeetingSocketServer,
  MeetingTemplates,
  type Transcriber,
} from './meetings/index.js'
import {
  FakePushSender,
  MeetingReminders,
  type PushSender,
  ReminderStore,
  WebPushSender,
} from './meetings/reminders/index.js'
import { Notes } from './notes/index.js'
import { BrandStore } from './org/brand.js'
import { OrgStore } from './org/store.js'
import {
  UnconfiguredClipTranscriber,
  UnconfiguredDictationTranscriber,
  UnconfiguredLLM,
  UnconfiguredTranscriber,
} from './org/unconfigured.js'
import { Pages } from './pages/index.js'
import { People } from './people/index.js'
import {
  Bookings,
  FakeRobotCheck,
  GoogleBookingHttp,
  type RobotCheck,
  Turnstile,
} from './scheduling/index.js'
import { Shares } from './shares/index.js'
import { SpaceService } from './spaces/index.js'
import type { ObjectStore } from './storage/s3.js'
import { Broadcaster, Syncer } from './sync/index.js'
import { Tables } from './tables/index.js'
import { Ramble, TaskReminders, type TaskServices, Tasks, TodoistImport } from './tasks/index.js'
import { TokenAuth, TokenStore } from './tokens/index.js'
import {
  type FlyApi,
  fetchLatestRelease,
  flyApi,
  RELEASE_IMAGE,
  type Release,
  readVersion,
  Updater,
  UpdateStore,
} from './updates/index.js'

// Same depth from src/ and dist/: apps/server/{src,dist}/services.{ts,js} → the repo root.
const ENV_FILE = fileURLToPath(new URL('../../../.env.local', import.meta.url))

/** Loads the repo-root `.env.local` when there is one (local dev). Variables already set win. */
export function loadEnvFile(): void {
  if (existsSync(ENV_FILE)) dotenv.config({ path: ENV_FILE, quiet: true })
}

export type Services = ReturnType<typeof createServices>

/** Stand-ins for the paid services, for tests; config picks the real ones otherwise. */
export interface ServiceOverrides {
  transcriber?: Transcriber
  llm?: LLM
  calendar?: CalendarSource
  /** null turns kept audio off. */
  audioStore?: AudioStore | null
  /** Where backups go; null turns them off (docs/PLAN-backups-storage.md). */
  backupStore?: ObjectStore | null
  /** Briefcast's voice; tests pass a FakeSpeaker to see what was read. */
  speaker?: Speaker
  /** Briefcast's clock, so tests can step through mornings. */
  briefcastNow?: () => Date
  /** The clock Check-ins and its scheduler read; tests pin it. */
  checkinsNow?: () => Date
  /** Stands in for Web Push; reminders run with it even without VAPID keys. */
  pushSender?: PushSender
  dictationTranscriber?: DictationTranscriber
  clipTranscriber?: ClipTranscriber
  /** Re-transcribes kept meeting audio after the call; null turns that off (§7.11). */
  retranscriber?: MeetingRetranscriber | null
  /** Booking links' robot check; null is a server that can't take bookings (§19). */
  robotCheck?: RobotCheck | null
  /** Saved links' page fetcher (§23.2); tests pass their own pages. */
  linkFetch?: PageFetcher
  /** Hearth Forms' chat posts (§21.5); tests pass a fake. */
  chatFetch?: typeof fetch
  /** Free bytes on the data volume, for Clips' disk check. */
  diskFreeBytes?: () => Promise<number>
  /** The updater's view of the newest release and of Fly (docs/PLAN-releases-and-updates.md). */
  latestRelease?: () => Promise<Release | null>
  fly?: FlyApi | null
  flyEnv?: { app?: string; region?: string; imageRef?: string }
  version?: string
  /** Stands in for the network in the Todoist import. */
  todoistFetch?: typeof fetch
  /** The organization store, when the caller already opened one (main.ts). */
  org?: OrgStore
  /** Where feedback is filed; null turns Send feedback off. */
  feedbackTracker?: FeedbackTracker | null
}

/** The real services, wired from config. Shared by the server and the CLI. */
export function createServices(config: Config, overrides: ServiceOverrides = {}) {
  const committer = { name: config.HEARTH_COMMITTER_NAME, email: config.HEARTH_COMMITTER_EMAIL }
  const git = new GitStore({
    dataDir: config.DATA_DIR,
    committer,
    rewriteLinks: rewriteLinksForMove,
  })
  const host = createHostAdapter(config)
  const index = new Index(indexPath(config.DATA_DIR))
  const indexer = new Indexer(git, index)
  // Personal access tokens in front of Clerk (or dev) auth, everywhere a request is authenticated.
  const tokens = new TokenStore(config.DATA_DIR)
  // The organization's settings, keys and brand kit (ARCHITECTURE §11).
  const org =
    overrides.org ??
    new OrgStore({
      dataDir: config.DATA_DIR,
      ...(config.HOTSAUCE_MASTER_KEY ? { masterKey: config.HOTSAUCE_MASTER_KEY } : {}),
    })
  const brand = new BrandStore(org.dir)
  const auth = new TokenAuth(createAuthenticator(config), tokens)
  const spaces = new SpaceService({
    git,
    host,
    registry: index,
    committer,
    initialFiles: (name, opts) => initialSpaceFiles(name, opts),
    webhook: {
      url: `${config.PUBLIC_URL.replace(/\/+$/, '')}/api/webhooks/git`,
      secret: config.WEBHOOK_SECRET,
    },
  })
  const broadcaster = new Broadcaster({ auth, spaces, publicUrl: config.PUBLIC_URL })
  const syncer = new Syncer({ git, index, indexer, broadcaster })
  const boardRooms = new BoardRooms({ auth, spaces, publicUrl: config.PUBLIC_URL })
  const llm = overrides.llm ?? createLLM(config)
  const dictation = new Dictation({
    store: new DictationStore(path.join(config.DATA_DIR, 'dictation.sqlite')),
    transcriber:
      overrides.dictationTranscriber ??
      (config.ASR_PROVIDER === 'deepgram'
        ? new DeepgramDictationTranscriber({ apiKey: config.DEEPGRAM_API_KEY ?? '' })
        : config.ASR_PROVIDER === 'none'
          ? new UnconfiguredDictationTranscriber()
          : new FakeDictationTranscriber()),
    // Its own client: a dictation can't wait out the SDK's retries; the cleaner falls back instead.
    llm:
      overrides.llm ??
      (config.LLM_PROVIDER === 'anthropic'
        ? new AnthropicLLM(
            new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 0, timeout: 15_000 }),
          )
        : llm),
    model: config.DICTATION_MODEL,
  })
  const meetings = createMeetingServices(
    config,
    { git, index, auth, spaces, syncer, keyterms: (p) => dictation.keyterms(p) },
    { ...overrides, llm },
  )
  const dictationSockets = new DictationSocketServer({
    dictation,
    auth,
    // Its own streaming transcriber (the meetings one is per meeting session).
    transcriber:
      overrides.transcriber ??
      (config.ASR_PROVIDER === 'deepgram'
        ? new DeepgramTranscriber({ apiKey: config.DEEPGRAM_API_KEY ?? '' })
        : config.ASR_PROVIDER === 'none'
          ? new UnconfiguredTranscriber()
          : new FakeTranscriber()),
  })
  // Clips keep their video beside kept meeting audio, under clips/ (ARCHITECTURE §10).
  const clips = new Clips({
    store: new ClipStore(path.join(config.DATA_DIR, 'clips.sqlite')),
    media: meetings.audioStore,
    dataDir: config.DATA_DIR,
    transcriber:
      overrides.clipTranscriber ??
      (config.ASR_PROVIDER === 'deepgram'
        ? new DeepgramClipTranscriber({ apiKey: config.DEEPGRAM_API_KEY ?? '' })
        : config.ASR_PROVIDER === 'none'
          ? new UnconfiguredClipTranscriber()
          : new FakeClipTranscriber()),
    llm,
    model: config.CLIPS_MODEL,
    keyterms: (userId) => dictation.dictionary(userId).slice(0, 100),
    ...(overrides.diskFreeBytes ? { freeBytes: overrides.diskFreeBytes } : {}),
    ffmpeg: { ffmpeg: config.FFMPEG_PATH, ffprobe: config.FFPROBE_PATH },
  })
  const taskService = new Tasks({ git, index, spaces, syncer })
  const tasks: TaskServices = {
    service: taskService,
    ramble: new Ramble({ dictation, llm, model: config.TASKS_MODEL, tasks: taskService }),
    todoist: new TodoistImport({
      tasks: taskService,
      ...(overrides.todoistFetch ? { fetch: overrides.todoistFetch } : {}),
    }),
    // Task reminders go to the browsers that turned on meeting reminders (ARCHITECTURE §12.2).
    reminders: meetings.pushSender
      ? new TaskReminders({
          store: meetings.reminderStore,
          sender: meetings.pushSender,
          tasks: taskService,
        })
      : null,
  }
  // Agent briefs (ARCHITECTURE §13): written nightly from each member's meetings and tasks.
  const briefs = new AgentBriefs({
    git,
    index,
    spaces,
    syncer,
    tasks: taskService,
    llm,
    model: config.BRIEF_MODEL,
    members: new BriefMembers(config.DATA_DIR),
    auth,
    org: config.ORG_NAME,
    hour: config.BRIEF_HOUR,
    forcedGapMs: config.BRIEF_REFRESH_GAP_SECONDS * 1000,
    nightly: config.LLM_PROVIDER !== 'none',
  })
  // Briefcast (docs/plans/2026-11-12-briefcast.md): a spoken briefing each weekday morning.
  const speaker =
    overrides.speaker ??
    (config.TTS_PROVIDER === 'openai'
      ? new OpenAISpeaker({
          apiKey: config.OPENAI_API_KEY ?? '',
          model: config.TTS_MODEL,
          voice: config.TTS_VOICE,
        })
      : config.TTS_PROVIDER === 'none'
        ? new UnconfiguredSpeaker()
        : new FakeSpeaker())
  // Saved links: one file per link, a readable copy fetched in the background (§23).
  const links = new Links({
    git,
    index,
    spaces,
    syncer,
    fetchPage:
      overrides.linkFetch ??
      (config.LINK_FETCH === 'live' ? (url) => fetchPage(url) : fakePageFetcher),
    llm: overrides.llm || config.LLM_PROVIDER !== 'none' ? llm : null,
    model: config.LINKS_MODEL,
  })
  const briefcasts = new Briefcasts({
    git,
    index,
    spaces,
    syncer,
    tasks: taskService,
    links,
    calendar: meetings.calendar,
    llm,
    model: config.BRIEFCAST_MODEL,
    speaker,
    audio: meetings.audioStore,
    members: new BriefMembers(config.DATA_DIR, 'briefcast'),
    state: new BriefcastState(config.DATA_DIR),
    auth,
    push: meetings.pushSender
      ? { store: meetings.reminderStore, sender: meetings.pushSender }
      : null,
    org: config.ORG_NAME,
    publicUrl: config.PUBLIC_URL,
    hour: config.BRIEFCAST_HOUR,
    forcedGapMs: config.BRIEF_REFRESH_GAP_SECONDS * 1000,
    nightly: config.LLM_PROVIDER !== 'none',
    ...(overrides.briefcastNow ? { now: overrides.briefcastNow } : {}),
  })
  const files = new Files({
    git,
    index,
    spaces,
    syncer,
    store: meetings.audioStore,
    dataDir: config.DATA_DIR,
    ...(overrides.diskFreeBytes ? { freeBytes: overrides.diskFreeBytes } : {}),
  })
  const chatRooms = new ChatRooms({
    dataDir: config.DATA_DIR,
    ...(overrides.chatFetch
      ? { fetch: overrides.chatFetch, resolve: async () => ['203.0.113.10'] }
      : {}),
  })
  const forms = new Forms({
    git,
    index,
    spaces,
    syncer,
    files,
    rooms: chatRooms,
    llm: overrides.llm || config.LLM_PROVIDER !== 'none' ? llm : null,
    model: config.ENHANCE_MODEL,
    robotCheck: overrides.robotCheck !== undefined ? overrides.robotCheck : robotCheckFor(config),
    publicUrl: config.PUBLIC_URL.replace(/\/+$/, ''),
    productName: config.PRODUCT_NAME,
  })
  // Check-ins (§24): scheduled team questions in the team space; summaries go to a chat room.
  const checkins = new Checkins({
    git,
    index,
    syncer,
    rooms: chatRooms,
    members: new CheckinMembers(config.DATA_DIR),
    llm: overrides.llm || config.LLM_PROVIDER !== 'none' ? llm : null,
    model: config.ENHANCE_MODEL,
    publicUrl: config.PUBLIC_URL.replace(/\/+$/, ''),
    ...(overrides.checkinsNow ? { now: overrides.checkinsNow } : {}),
  })
  const checkinScheduler = new CheckinScheduler({
    checkins,
    push: meetings.pushSender
      ? { store: meetings.reminderStore, sender: meetings.pushSender }
      : null,
    ...(overrides.checkinsNow ? { now: overrides.checkinsNow } : {}),
  })
  // In tests nothing reaches GitHub or Fly unless the test hands in stand-ins.
  const flyEnv = overrides.flyEnv ?? {
    ...(process.env.FLY_APP_NAME ? { app: process.env.FLY_APP_NAME } : {}),
    ...(process.env.FLY_REGION ? { region: process.env.FLY_REGION } : {}),
    ...(process.env.FLY_IMAGE_REF ? { imageRef: process.env.FLY_IMAGE_REF } : {}),
  }
  const updates = new Updater({
    current: overrides.version ?? readVersion(),
    store: new UpdateStore(config.DATA_DIR),
    latestRelease:
      overrides.latestRelease ??
      (config.NODE_ENV === 'test' ? async () => null : () => fetchLatestRelease()),
    fly:
      overrides.fly !== undefined
        ? overrides.fly
        : config.FLY_API_TOKEN && flyEnv.app
          ? flyApi({ token: config.FLY_API_TOKEN, app: flyEnv.app })
          : null,
    flyEnv,
    image: RELEASE_IMAGE,
    publicUrl: config.PUBLIC_URL,
    busy: () => meetings.sessions.openCount > 0,
  })
  return {
    config,
    git,
    updates,
    host,
    index,
    indexer,
    auth,
    tokens,
    spaces,
    broadcaster,
    syncer,
    meetings,
    dictation,
    dictationSockets,
    boardRooms,
    clips,
    tasks,
    notes: new Notes({ git, index, spaces, syncer }),
    // Hearth Files keep their bytes beside Clips and kept audio, under files/ (ARCHITECTURE §18).
    files,
    briefs,
    feedback: new Feedback({
      clarifier: new Clarifier({ llm, model: config.FEEDBACK_MODEL }),
      tracker:
        overrides.feedbackTracker === undefined
          ? createFeedbackTracker(config)
          : overrides.feedbackTracker,
      secret: config.WEBHOOK_SECRET,
    }),
    boards: new Boards({ git, index, spaces, syncer }),
    people: new People({
      git,
      index,
      spaces,
      syncer,
      tasks: taskService,
      calendar: meetings.calendar,
      internalDomains: config.ALLOWED_EMAIL_DOMAINS,
    }),
    briefcasts,
    bookings: createBookings(
      config,
      { git, index, spaces, syncer, meetings },
      overrides.robotCheck,
    ),
    // Read-only links to docs, meeting notes and notes (ARCHITECTURE §20).
    shares: new Shares({ git, index, spaces, syncer }),
    // HTML pages Claude publishes over MCP, versioned in Git (§20.2).
    pages: new Pages({ git, index, spaces, syncer }),
    // Forms and their answers in Git; answers' files in Hearth Files (§21).
    chatRooms,
    forms,
    // Tables: a CSV block in Git, formulas by IronCalc (§22).
    tables: new Tables({ git, index, spaces, syncer, forms }),
    links,
    checkins,
    checkinScheduler,
    org,
    brand,
    backups: createBackups(config, overrides.backupStore, (space, fn) =>
      git.withSpaceLocked(space, fn),
    ),
  }
}
/**
 * Booking links' robot check: Cloudflare Turnstile with both keys; otherwise the dev stand-in, or
 * in production nothing, so the page says it can't take bookings yet (S8).
 */
export function robotCheckFor(config: Config): RobotCheck | null {
  if (config.TURNSTILE_SECRET_KEY && config.TURNSTILE_SITE_KEY) {
    return new Turnstile({
      siteKey: config.TURNSTILE_SITE_KEY,
      secret: config.TURNSTILE_SECRET_KEY,
    })
  }
  return config.NODE_ENV === 'production' ? null : new FakeRobotCheck()
}

/** Booking links (ARCHITECTURE §19): the member's Google grant, and Turnstile or its dev stand-in. */
function createBookings(
  config: Config,
  deps: {
    git: GitStore
    index: Index
    spaces: SpaceService
    syncer: Syncer
    meetings: MeetingServices
  },
  override?: RobotCheck | null,
): Bookings {
  const { calendarSync, googleGrant, fakeGoogle } = deps.meetings
  const robotCheck = override !== undefined ? override : robotCheckFor(config)
  return new Bookings({
    git: deps.git,
    spaces: deps.spaces,
    registry: deps.index,
    syncer: deps.syncer,
    google: new GoogleBookingHttp({
      grant: googleGrant ?? (async () => null),
      ...(fakeGoogle ? { fetch: fakeGoogle.fetch } : {}),
    }),
    member: (email) =>
      calendarSync?.cache.members().find((m) => m.email.toLowerCase() === email.toLowerCase()) ??
      null,
    calendarsOf: (p) => calendarSync?.cache.calendars(p.userId) ?? [],
    register: (p) => calendarSync?.cache.register(p),
    robotCheck,
  })
}

/** GitHub issues when a repo and token are set; memory outside production; else off. */
function createFeedbackTracker(config: Config): FeedbackTracker | null {
  if (config.FEEDBACK_REPO && config.FEEDBACK_GITHUB_TOKEN) {
    return new GitHubTracker({ repo: config.FEEDBACK_REPO, token: config.FEEDBACK_GITHUB_TOKEN })
  }
  return config.NODE_ENV === 'production' ? null : new MemoryTracker()
}

/** Claude, with the key from config (env or the organization's saved key). */
function createLLM(config: Config): LLM {
  if (config.LLM_PROVIDER === 'anthropic') {
    return new AnthropicLLM(new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }))
  }
  return config.LLM_PROVIDER === 'none' ? new UnconfiguredLLM() : new FakeLLM()
}

function createMeetingServices(
  config: Config,
  deps: {
    git: GitStore
    index: Index
    auth: Authenticator
    spaces: SpaceService
    syncer: Syncer
    keyterms: (principal: Principal) => string[]
  },
  overrides: ServiceOverrides,
): MeetingServices {
  const { git, index, auth, spaces, syncer, keyterms } = deps
  const transcriber =
    overrides.transcriber ??
    (config.ASR_PROVIDER === 'deepgram'
      ? new DeepgramTranscriber({ apiKey: config.DEEPGRAM_API_KEY ?? '' })
      : config.ASR_PROVIDER === 'none'
        ? new UnconfiguredTranscriber()
        : new FakeTranscriber())
  const llm = overrides.llm ?? createLLM(config)
  const { calendar, calendarSync, fakeGoogle, googleGrant } = overrides.calendar
    ? { calendar: overrides.calendar, calendarSync: null, fakeGoogle: null, googleGrant: null }
    : createCalendar(config)
  const templates = new MeetingTemplates({ git, spaces })
  const audioStore =
    overrides.audioStore !== undefined ? overrides.audioStore : createAudioStore(config)
  const cleanup = new TranscriptCleanup({
    git,
    afterCommit: (space) => syncer.afterHeadChanged(space),
    retranscriber:
      overrides.retranscriber !== undefined
        ? overrides.retranscriber
        : config.ASR_PROVIDER === 'deepgram'
          ? new DeepgramRetranscriber({ apiKey: config.DEEPGRAM_API_KEY ?? '' })
          : null,
    llm: overrides.llm || config.LLM_PROVIDER !== 'none' ? llm : null,
    model: config.CLEANUP_MODEL,
  })
  const sessions = new MeetingSessions({
    dataDir: config.DATA_DIR,
    git,
    afterCommit: (space) => syncer.afterHeadChanged(space),
    transcriber,
    templates,
    calendar,
    spaces,
    internalDomains: config.ALLOWED_EMAIL_DOMAINS,
    keepAudio: config.KEEP_AUDIO,
    audioStore,
    idleStopMs: config.SESSION_IDLE_STOP_MINUTES * 60_000,
    maxAgeMs: config.SESSION_MAX_HOURS * 3_600_000,
    keyterms,
    cleanup,
  })
  return {
    sessions,
    sockets: new MeetingSocketServer({ auth, sessions, publicUrl: config.PUBLIC_URL }),
    templates,
    enhancer: new Enhancer(llm, { model: config.ENHANCE_MODEL }),
    chat: new MeetingChat(index, git, llm, { model: config.CHAT_MODEL, spaces }),
    calendar,
    calendarSync,
    fakeGoogle,
    googleGrant,
    audioStore,
    ...reminderServices(config, calendar, overrides.pushSender),
  }
}

/** Meeting reminders, when VAPID keys are set (or a test supplies a sender). */
function reminderServices(config: Config, calendar: CalendarSource, sender?: PushSender) {
  const store = new ReminderStore(config.DATA_DIR)
  const vapid =
    config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY
      ? {
          subject: config.VAPID_SUBJECT,
          publicKey: config.VAPID_PUBLIC_KEY,
          privateKey: config.VAPID_PRIVATE_KEY,
        }
      : null
  const recorder = !sender && config.PUSH_SENDER === 'record' ? new FakePushSender() : null
  const pushSender = sender ?? recorder ?? (vapid ? new WebPushSender(vapid) : null)
  return {
    reminderStore: store,
    recordedPushes: recorder,
    vapidPublicKey: vapid?.publicKey ?? (sender || recorder ? 'test-public-key' : null),
    pushSender,
    reminders: pushSender ? new MeetingReminders({ store, calendar, sender: pushSender }) : null,
  }
}

/**
 * The cached Google Calendar (ARCHITECTURE §7.8). Dev auth has no Google account behind it, so
 * the same sync runs against an in-memory Google instead.
 */
function createCalendar(config: Config): {
  calendar: CalendarSource
  calendarSync: CalendarSync
  fakeGoogle: FakeGoogle | null
  googleGrant: GoogleGrantSource
} {
  const fake = config.AUTH_MODE !== 'clerk' || !config.CLERK_SECRET_KEY
  const fakeGoogle = fake ? new FakeGoogle() : null
  const googleGrant: GoogleGrantSource = fakeGoogle
    ? async (p) => ({ token: await fakeGoogleToken(p), scopes: fakeGoogle.scopes(p.email) })
    : clerkGoogleGrant(createClerkClient({ secretKey: config.CLERK_SECRET_KEY ?? '' }))
  const google = new GoogleCalendarHttp({
    accessToken: async (p) => (await googleGrant(p))?.token ?? null,
    ...(fakeGoogle ? { fetch: fakeGoogle.fetch } : {}),
  })
  const calendarSync = new CalendarSync({
    cache: new CalendarCache(path.join(config.DATA_DIR, 'calendar', 'cache.sqlite')),
    google,
    intervalMs: config.CALENDAR_SYNC_MINUTES * 60_000,
  })
  return { calendar: new CachedCalendar(calendarSync), calendarSync, fakeGoogle, googleGrant }
}
