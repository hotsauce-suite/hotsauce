// Client for `/api/tasks` (ARCHITECTURE §12.3). The shapes are the server's: TaskView is §12.2.

import type { ParsedTask, TaskSource } from '@hearth/format'
import { request } from './client'
import type { MeetingActionItems } from './types'

export type { ParsedTask, TaskSource }

export type Priority = 1 | 2 | 3 | 4

export interface TaskView {
  space: string
  path: string
  id: string
  blobOid: string
  title: string
  notes: string
  status: 'open' | 'done'
  priority: Priority
  /** `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm` wall time in `tz`. */
  due: string | null
  tz: string | null
  /** The ISO instant of a timed due, else null. */
  dueAt: string | null
  recur: string | null
  project: string | null
  labels: string[]
  assignee: string | null
  createdBy: string
  created: string
  completed: string | null
  completedBy: string | null
  order: number | null
  source: TaskSource | null
  mine: boolean
}

export interface TaskFilter {
  status?: 'open' | 'done' | 'all'
  mine?: boolean
  project?: string
  space?: string
  /** `YYYY-MM-DD`, inclusive. */
  dueBefore?: string
  /** `YYYY-MM-DD`, inclusive. */
  dueAfter?: string
  /** ISO instant. */
  doneSince?: string
  q?: string
  limit?: number
}

export interface TaskInput {
  title: string
  notes?: string
  priority?: Priority
  due?: string | null
  tz?: string
  recur?: string | null
  project?: string | null
  labels?: string[]
  assignee?: string | null
  order?: number
  source?: TaskSource
}

export type TaskPatch = Partial<TaskInput> & { tz?: string; baseBlobOid?: string }

export interface TaskProject {
  space: string
  name: string
  open: number
}

export interface TaskPerson {
  email: string
  name: string
  handle: string
}

export interface RambleResult {
  transcript: string
  tasks: ParsedTask[]
}

export interface ImportResult {
  imported: number
  skipped: number
  projects: string[]
}

const BASE = '/api/tasks'
const one = (space: string, id: string) =>
  `${BASE}/${encodeURIComponent(space)}/${encodeURIComponent(id)}`

/** `space/id`: a task's identity across spaces. */
export const taskKey = (t: { space: string; id: string }) => `${t.space}/${t.id}`

/** The member's IANA zone, sent with every write that depends on "today". */
export function memberTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export const tasksApi = {
  list: async (filter: TaskFilter = {}): Promise<TaskView[]> => {
    const res = await request<{ tasks: TaskView[] }>(BASE, {
      query: {
        status: filter.status,
        mine: filter.mine === undefined ? undefined : String(filter.mine),
        project: filter.project,
        space: filter.space,
        due_before: filter.dueBefore,
        due_after: filter.dueAfter,
        done_since: filter.doneSince,
        q: filter.q,
        limit: filter.limit,
      },
    })
    return Array.isArray(res?.tasks) ? res.tasks : []
  },

  projects: () => request<TaskProject[]>(`${BASE}/projects`),

  people: () => request<TaskPerson[]>(`${BASE}/people`),

  /** Open meeting to-dos no task came from yet; with `only`, just that one note's. */
  fromMeetings: (only?: { space: string; path: string }) =>
    request<MeetingActionItems[]>(`${BASE}/from-meetings`, only ? { query: only } : {}),

  create: (input: TaskInput & { space?: string; tz: string }) =>
    request<TaskView>(BASE, { method: 'POST', json: input }),

  quick: (body: {
    text: string
    tz: string
    space?: string
    project?: string
    source?: TaskSource
  }) => request<TaskView>(`${BASE}/quick`, { method: 'POST', json: body }),

  get: (space: string, id: string) => request<TaskView>(one(space, id)),

  /**
   * `tz` defaults to the member's zone: the server's "today" (a repeat on an undated task starts
   * then), and the zone of a timed due the patch sets. Send the task's own to keep it.
   */
  update: (space: string, id: string, patch: TaskPatch) =>
    request<TaskView>(one(space, id), {
      method: 'PATCH',
      json: { ...patch, tz: patch.tz ?? memberTimeZone() },
    }),

  complete: (space: string, id: string, tz: string) =>
    request<TaskView>(`${one(space, id)}/complete`, { method: 'POST', json: { tz } }),

  reopen: (space: string, id: string) =>
    request<TaskView>(`${one(space, id)}/reopen`, { method: 'POST', json: {} }),

  move: (space: string, id: string, toSpace: string) =>
    request<TaskView>(`${one(space, id)}/move`, { method: 'POST', json: { toSpace } }),

  remove: (space: string, id: string) => request<void>(one(space, id), { method: 'DELETE' }),

  /** Audio in, proposed tasks out; nothing is saved. */
  ramble: (audio: Blob, tz: string) =>
    request<RambleResult>(`${BASE}/ramble`, {
      method: 'POST',
      query: { tz },
      body: audio,
      // The server takes audio/webm, audio/mp4 or audio/wav; codec parameters aren't needed.
      contentType: (audio.type || 'audio/webm').split(';')[0] ?? 'audio/webm',
    }),

  /** `tz`: the member's zone, for floating Todoist times and the CSV's "today". */
  importTodoist: (
    body: ({ token: string } | { csv: string; projectName: string }) & { tz: string },
  ) => request<ImportResult>(`${BASE}/import/todoist`, { method: 'POST', json: body }),
}
