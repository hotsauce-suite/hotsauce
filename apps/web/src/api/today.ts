// Client for `GET /api/today` (ARCHITECTURE §16): the Today page in one read.

import { request } from './client'
import type { TaskView } from './tasks'
import type { MeetingActionItems } from './types'

export interface TodayMeeting {
  id: string
  title: string
  start: string
  end: string
  attendees: Array<{ email: string; name?: string }>
  meetLink: string | null
  note: { space: string; path: string } | null
  prep: { space: string; path: string; title: string; date: string; line: string } | null
}

export interface TodayView {
  date: string
  meetings: { events: TodayMeeting[]; error: string | null }
  tasks: TaskView[]
  actionItems: MeetingActionItems[]
  notes: Array<{
    space: string
    id: string
    path: string
    title: string
    body: string
    created: string
  }>
  docs: Array<{ space: string; path: string; title: string; changed: string; team: boolean }>
  briefcast: null
}

/** The member's own day: local midnight to midnight, and its date. */
export function localDay(now = new Date()): { from: string; to: string; date: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    date: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
  }
}

export const todayApi = {
  get: (now = new Date()) => request<TodayView>('/api/today', { query: localDay(now) }),
}
