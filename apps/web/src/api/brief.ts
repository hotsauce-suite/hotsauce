// Client for `/api/brief` (ARCHITECTURE §13.3): the member's agent brief.

import { request } from './client'
import { memberTimeZone } from './tasks'

export interface AgentBrief {
  space: string
  path: string
  /** Markdown: one `## ` section per part of the brief. */
  body: string
  /** ISO instant it was written. */
  generated: string
  model: string
  meetings: number
  tasks: number
}

export interface BriefState {
  brief: AgentBrief | null
  /** The member's own corrections, verbatim. */
  notes: string
}

export type RefreshStatus = 'written' | 'unchanged' | 'empty'

const BASE = '/api/brief'

export const briefApi = {
  /** Also tells the server the member's zone, so the nightly brief is written in their night. */
  get: () => request<BriefState>(`${BASE}?tz=${encodeURIComponent(memberTimeZone())}`),

  refresh: () =>
    request<BriefState & { status: RefreshStatus }>(`${BASE}/refresh`, {
      method: 'POST',
      json: { tz: memberTimeZone() },
    }),

  saveNotes: (text: string) => request<void>(`${BASE}/notes`, { method: 'PUT', json: { text } }),
}
