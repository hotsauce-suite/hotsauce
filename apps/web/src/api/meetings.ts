// Client for `/api/meetings` (ARCHITECTURE §7.2). The audio socket is in
// apps/meetings/audio/socket.ts.

import type { GranolaMeeting } from '../apps/meetings/granolaExport'
import { api, HearthApiError, request, requestBlob } from './client'
import type {
  ChatAnswer,
  ChatScope,
  CreateSessionBody,
  EnhanceBody,
  EnhanceResult,
  MeetingActionItems,
  MeetingFilters,
  MeetingSession,
  MeetingSummary,
  MeetingTemplate,
  StopResult,
} from './types'

const BASE = '/api/meetings'
const session = (id: string) => `${BASE}/sessions/${encodeURIComponent(id)}`

/** The list comes straight from index frontmatter, so any key may be missing or null. */
type MeetingRow = Partial<MeetingSummary> & Pick<MeetingSummary, 'space' | 'path'>

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

function toSummary(row: MeetingRow): MeetingSummary {
  return {
    space: row.space,
    path: row.path,
    title: row.title || row.path.slice(row.path.lastIndexOf('/') + 1).replace(/\.md$/i, ''),
    date: typeof row.date === 'string' ? row.date : '',
    duration_min: typeof row.duration_min === 'number' ? row.duration_min : null,
    attendees: strings(row.attendees),
    companies: strings(row.companies),
    template: typeof row.template === 'string' ? row.template : null,
    hasTranscript: row.hasTranscript === true,
  }
}

export interface MeetingSettings {
  /** Whether a meeting's audio can be kept (the server has somewhere to put it), and if by default. */
  keepAudio: { available: boolean; byDefault: boolean }
}

export type AudioTrack = 'me' | 'them'

export const meetingsApi = {
  templates: () => request<MeetingTemplate[]>(`${BASE}/templates`),

  settings: () => request<MeetingSettings>(`${BASE}/settings`),

  /** The VAPID key to subscribe with; null when the server sends no reminders. */
  reminderKey: () => request<{ publicKey: string | null }>(`${BASE}/reminders`),

  subscribeReminders: (subscription: PushSubscriptionJSON) =>
    request<void>(`${BASE}/reminders`, { method: 'POST', json: { subscription } }),

  unsubscribeReminders: (endpoint: string) =>
    request<void>(`${BASE}/reminders`, { method: 'DELETE', json: { endpoint } }),
  /** One test notification to each of this member's subscribed browsers. */
  testNotification: () => request<{ sent: number }>(`${BASE}/reminders/test`, { method: 'POST' }),

  /** The tracks whose audio was kept for this meeting, from its pointer file; none if not kept. */
  keptAudio: async (space: string, id: string): Promise<AudioTrack[]> => {
    try {
      const { content } = await api.readFile(space, `.hearth/meetings/audio/${id}.yaml`)
      return (['me', 'them'] as const).filter((t) => new RegExp(`^  ${t}:`, 'm').test(content))
    } catch (err) {
      if (err instanceof HearthApiError && err.status === 404) return []
      throw err
    }
  },

  audio: (space: string, id: string, track: AudioTrack) =>
    requestBlob(`${BASE}/audio`, { query: { space, id, track } }),

  /** Open checklist items from the member's meetings, newest meeting first. */
  actionItems: () => request<MeetingActionItems[]>(`${BASE}/action-items`),

  /** Ticks one item; 409 when the line no longer holds it. */
  completeActionItem: (item: { space: string; path: string; line: number; text: string }) =>
    request<{ ok: true }>(`${BASE}/action-items/done`, { method: 'POST', json: item }),

  list: async (filters: MeetingFilters = {}) => {
    const rows = await request<MeetingRow[]>(BASE, { query: { ...filters } })
    return rows.map(toSummary)
  },

  createSession: (body: CreateSessionBody) =>
    request<MeetingSession>(`${BASE}/sessions`, { method: 'POST', json: body }),

  session: (id: string) => request<MeetingSession>(session(id)),

  /** The caller's sessions that aren't saved yet, newest first. */
  unsavedSessions: () => request<MeetingSession[]>(`${BASE}/sessions`),

  putNotes: (id: string, text: string, opts: { keepalive?: boolean } = {}) =>
    request<void>(`${session(id)}/notes`, {
      method: 'PUT',
      json: { text },
      keepalive: opts.keepalive ?? false,
    }),

  /** Remembers Keep audio for the session, so however the meeting ends, the choice holds. */
  setKeepAudio: (id: string, keep: boolean) =>
    request<MeetingSession>(`${session(id)}/keep-audio`, { method: 'PUT', json: { keep } }),

  pause: (id: string) =>
    request<MeetingSession>(`${session(id)}/pause`, { method: 'POST', json: {} }),

  resume: (id: string) =>
    request<MeetingSession>(`${session(id)}/resume`, { method: 'POST', json: {} }),

  /** `notes`, when given, replaces the session's raw notes before it is saved. */
  stop: (id: string, opts: { keepAudio?: boolean; notes?: string } = {}) =>
    request<StopResult>(`${session(id)}/stop`, { method: 'POST', json: opts }),

  /** Deletes a meeting note with its transcript, raw notes and kept audio, in one commit. */
  deleteNote: (space: string, path: string) =>
    request<{ deleted: string[] }>(`${BASE}/delete`, { method: 'POST', json: { space, path } }),

  enhance: (body: EnhanceBody) =>
    request<EnhanceResult>(`${BASE}/enhance`, { method: 'POST', json: body }),

  /** Names speakers ("Speaker 1" → "Priya Shah") in a meeting's transcript and note, in one commit. */
  nameSpeakers: (
    space: string,
    path: string,
    names: Record<string, string>,
    transcriptBlobOid?: string,
  ) =>
    request<{ transcriptPath: string; renamed: Record<string, string> }>(`${BASE}/speakers`, {
      method: 'POST',
      json: { space, path, names, ...(transcriptBlobOid ? { transcriptBlobOid } : {}) },
    }),

  /** Past meetings from Granola's export, into the personal space (ARCHITECTURE §7.12). */
  importGranola: (meetings: GranolaMeeting[], tz: string) =>
    request<{ imported: number; skipped: number; space: string }>(`${BASE}/import/granola`, {
      method: 'POST',
      json: { meetings, tz },
    }),

  chat: (question: string, scope: ChatScope) =>
    request<ChatAnswer>(`${BASE}/chat`, { method: 'POST', json: { question, scope } }),
}
