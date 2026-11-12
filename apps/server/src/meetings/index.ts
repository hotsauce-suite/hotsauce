import type { AudioStore } from './audio/index.js'
import type {
  FakePushSender,
  MeetingReminders,
  PushSender,
  ReminderStore,
} from './reminders/index.js'

export {
  type AudioStore,
  createAudioStore,
  LocalAudioStore,
  R2AudioStore,
  wavHeader,
} from './audio/index.js'
export * from './cleanup/index.js'
export {
  GranolaMeeting,
  granolaFiles,
  granolaTranscript,
  type ImportGranolaDeps,
  importGranola,
  MAX_IMPORT_MEETINGS,
} from './import-granola.js'

import type { FakeGoogle } from './calendar/fake-google.js'
import type { CalendarSync } from './calendar/sync.js'
import type { CalendarSource } from './calendar/types.js'
import type { MeetingChat } from './chat.js'
import type { Enhancer } from './enhance/enhancer.js'
import type { MeetingSessions } from './sessions.js'
import type { MeetingSocketServer } from './socket.js'
import type { MeetingTemplates } from './templates.js'

export {
  type ActionItem,
  completeActionItem,
  listActionItems,
  type MeetingActionItems,
  openActionItems,
} from './action-items.js'
export { CalendarCache } from './calendar/cache.js'
export { FakeCalendar } from './calendar/fake.js'
export { FAKE_TEAM_CALENDAR, FakeGoogle, fakeGoogleToken } from './calendar/fake-google.js'
export {
  type AccessToken,
  clerkGoogleGrant,
  clerkGoogleToken,
  type GoogleCalendarApi,
  GoogleCalendarHttp,
  type GoogleGrantSource,
  mapGoogleEvents,
} from './calendar/google.js'
export { CachedCalendar, CalendarSync, SYNC_AHEAD_MS, SYNC_BACK_MS } from './calendar/sync.js'
export { type CalendarEvent, type CalendarSource, findEvent } from './calendar/types.js'
export {
  type CoverageItem,
  coverage,
  matchMeetEvent,
  meetCode,
  type NoteRef,
} from './calendar/views.js'
export { type ChatScope, type Citation, MeetingChat } from './chat.js'
export { type DeleteMeetingDeps, deleteMeeting } from './delete.js'
export { assembleEnhancedNote } from './enhance/assemble.js'
export { Enhancer } from './enhance/enhancer.js'
export { type EnhanceNoteDeps, type EnhanceResult, enhanceNote } from './enhance/note.js'
export { buildEnhancePrompt, type EnhanceInput } from './enhance/prompt.js'
export { KeptAudioSchema, keptAudioKey, keptAudioPath } from './files.js'
export { audioFrame, parseAudioFrame } from './frames.js'
export { listMeetings, type MeetingFilters, type MeetingListItem } from './list.js'
export { AnthropicLLM, type MessagesClient } from './llm/anthropic.js'
export { FakeLLM, scriptedResponse } from './llm/fake.js'
export type { LLM, LLMRequest, LLMUsage } from './llm/types.js'
export { previousInSeries, type SeriesNote } from './series.js'
export {
  type AudioSocket,
  type MeetingSession,
  MeetingSessions,
  type SavedMeeting,
  type ServerMessage,
  type SessionState,
  WS_REPLACED,
} from './sessions.js'
export {
  MAX_MEETING_FRAME_BYTES,
  MeetingSocketServer,
  WS_FORBIDDEN,
  WS_NOT_FOUND,
} from './socket.js'
export { type NameSpeakersDeps, nameSpeakers } from './speakers.js'
export { MeetingTemplates, TEMPLATES_DIR, type TemplateDoc } from './templates.js'
export { DeepgramTranscriber } from './transcriber/deepgram.js'
export { FakeTranscriber } from './transcriber/fake.js'
export type {
  Track,
  Transcriber,
  TranscriberSession,
  TranscriptSegment,
} from './transcriber/types.js'

/** Everything the Meetings API and WebSocket are built from. */
import type { GoogleGrantSource } from './calendar/google.js'

export interface MeetingServices {
  sessions: MeetingSessions
  sockets: MeetingSocketServer
  templates: MeetingTemplates
  enhancer: Enhancer
  chat: MeetingChat
  calendar: CalendarSource
  /** The Google sync behind `calendar`; null when a test supplies its own calendar. */
  calendarSync: CalendarSync | null
  /** The in-memory Google behind the sync in dev and test; null with real Google. */
  fakeGoogle: FakeGoogle | null
  /** The member's Google grant with its scopes (booking links); null when a test supplies its own calendar. */
  googleGrant: GoogleGrantSource | null
  /** Where kept audio lives; null when keeping it isn't offered. */
  audioStore: AudioStore | null
  reminderStore: ReminderStore
  /** With `PUSH_SENDER=record` (test only): every reminder push, for e2e. */
  recordedPushes: FakePushSender | null
  /** The VAPID public key browsers subscribe with; null when reminders are off. */
  vapidPublicKey: string | null
  reminders: MeetingReminders | null
  /** What reminders are pushed with; null when they are off. Hearth Tasks reminds through it too. */
  pushSender: PushSender | null
}
