// Client for `/api/checkins` (ARCHITECTURE §24.4). Every call sends the browser's zone, so a
// round opens at the member's own time.

import { request } from './client'

export type Weekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'

export interface CheckinReply {
  id: string
  by: string
  name: string
  at: string
  text: string
}

export interface CheckinAnswer {
  id: string
  date: string
  name: string
  email: string
  submitted: string
  edited: string | null
  text: string
  replies: CheckinReply[]
  mine: boolean
  path: string
}

export interface CheckinRound {
  date: string
  answers: CheckinAnswer[]
  summary: { text: string; written: string; posted: boolean; missing: string[] } | null
}

export interface CheckinItem {
  id: string
  title: string
  days: Weekday[]
  time: string
  tz: string
  schedule: string
  paused: boolean
  room: string | null
  skip: string[]
  current: { date: string; answered: boolean; answers: number } | null
}

export interface CheckinView extends CheckinItem {
  blobOid: string
  createdBy: string
  asked: Array<{ email: string; name: string }>
  rounds: CheckinRound[]
  canManage: boolean
}

export interface CheckinInput {
  title: string
  days: Weekday[]
  time: string
  room: string | null
  skip: string[]
  paused: boolean
}

export interface DueCheckin {
  id: string
  title: string
  date: string
  opensAt: string
}

export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

const BASE = '/api/checkins'
const enc = encodeURIComponent

export const checkinsApi = {
  list: () =>
    request<{ checkins: CheckinItem[]; canManage: boolean }>(BASE, {
      query: { tz: browserZone() },
    }),
  due: () => request<{ due: DueCheckin[] }>(`${BASE}/due`, { query: { tz: browserZone() } }),
  get: (id: string) => request<CheckinView>(`${BASE}/${enc(id)}`, { query: { tz: browserZone() } }),
  create: (input: CheckinInput) =>
    request<CheckinView>(BASE, { method: 'POST', query: { tz: browserZone() }, json: input }),
  save: (id: string, input: CheckinInput & { blobOid: string }) =>
    request<CheckinView>(`${BASE}/${enc(id)}`, { method: 'PUT', json: input }),
  remove: (id: string) => request<void>(`${BASE}/${enc(id)}`, { method: 'DELETE' }),
  answer: (id: string, text: string, date?: string) =>
    request<CheckinAnswer>(`${BASE}/${enc(id)}/answers`, {
      method: 'POST',
      query: { tz: browserZone() },
      json: date ? { text, date } : { text },
    }),
  reply: (id: string, answerId: string, text: string) =>
    request<CheckinAnswer>(`${BASE}/${enc(id)}/answers/${enc(answerId)}/replies`, {
      method: 'POST',
      json: { text },
    }),
}
