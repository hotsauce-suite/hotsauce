import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { createClerkClient } from '@clerk/backend'
import { initialSpaceFiles, rewriteLinksForMove } from '@hearth/format'
import dotenv from 'dotenv'
import { type Authenticator, createAuthenticator } from './auth/index.js'
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
import { GitStore } from './git/index.js'
import { createHostAdapter } from './hosts/index.js'
import { Index, Indexer, indexPath } from './index/index.js'
import {
  AnthropicLLM,
  type AudioStore,
  CachedCalendar,
  CalendarCache,
  type CalendarSource,
  CalendarSync,
  clerkGoogleToken,
  createAudioStore,
  DeepgramTranscriber,
  Enhancer,
  FakeGoogle,
  FakeLLM,
  FakeTranscriber,
  fakeGoogleToken,
  GoogleCalendarHttp,
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
import { BrandStore } from './org/brand.js'
import { OrgStore } from './org/store.js'
import {
  UnconfiguredClipTranscriber,
  UnconfiguredDictationTranscriber,
  UnconfiguredLLM,
  UnconfiguredTranscriber,
} from './org/unconfigured.js'
import { SpaceService } from './spaces/index.js'
import { Broadcaster, Syncer } from './sync/index.js'
import { TokenAuth, TokenStore } from './tokens/index.js'

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
  /** Stands in for Web Push; reminders run with it even without VAPID keys. */
  pushSender?: PushSender
  dictationTranscriber?: DictationTranscriber
  clipTranscriber?: ClipTranscriber
  /** Free bytes on the data volume, for Clips' disk check. */
  diskFreeBytes?: () => Promise<number>
  /** The organization store, when the caller already opened one (main.ts). */
  org?: OrgStore
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
  const llm = overrides.llm ?? createLLM(config)
  const meetings = createMeetingServices(
    config,
    { git, index, auth, spaces, syncer },
    { ...overrides, llm },
  )
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
  return {
    config,
    git,
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
    clips,
    org,
    brand,
  }
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
  },
  overrides: ServiceOverrides,
): MeetingServices {
  const { git, index, auth, spaces, syncer } = deps
  const transcriber =
    overrides.transcriber ??
    (config.ASR_PROVIDER === 'deepgram'
      ? new DeepgramTranscriber({ apiKey: config.DEEPGRAM_API_KEY ?? '' })
      : config.ASR_PROVIDER === 'none'
        ? new UnconfiguredTranscriber()
        : new FakeTranscriber())
  const llm = overrides.llm ?? createLLM(config)
  const { calendar, calendarSync, fakeGoogle } = overrides.calendar
    ? { calendar: overrides.calendar, calendarSync: null, fakeGoogle: null }
    : createCalendar(config)
  const templates = new MeetingTemplates({ git, spaces })
  const audioStore =
    overrides.audioStore !== undefined ? overrides.audioStore : createAudioStore(config)
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
} {
  const fake = config.AUTH_MODE !== 'clerk' || !config.CLERK_SECRET_KEY
  const fakeGoogle = fake ? new FakeGoogle() : null
  const google = fakeGoogle
    ? new GoogleCalendarHttp({ accessToken: fakeGoogleToken, fetch: fakeGoogle.fetch })
    : new GoogleCalendarHttp({
        accessToken: clerkGoogleToken(
          createClerkClient({ secretKey: config.CLERK_SECRET_KEY ?? '' }),
        ),
      })
  const calendarSync = new CalendarSync({
    cache: new CalendarCache(path.join(config.DATA_DIR, 'calendar', 'cache.sqlite')),
    google,
    intervalMs: config.CALENDAR_SYNC_MINUTES * 60_000,
  })
  return { calendar: new CachedCalendar(calendarSync), calendarSync, fakeGoogle }
}
