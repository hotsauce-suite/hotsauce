// Client for `/api/feedback` (docs/plans/2026-11-12-feedback.md): Send feedback.

import { request } from './client'

export type FeedbackKind = 'bug' | 'idea'
export type FeedbackStatus =
  | 'new'
  | 'needs info'
  | 'needs decision'
  | 'approved'
  | 'building'
  | 'shipped'
  | 'declined'

export interface QA {
  question: string
  answer: string
}

export type Clarified =
  | { ready: true; title: string; summary: string }
  | { ready: false; questions: string[] }

export interface FeedbackItem {
  number: number
  url: string
  title: string
  kind: FeedbackKind
  status: FeedbackStatus
  createdAt: string
  question?: string
}

const BASE = '/api/feedback'

export const feedbackApi = {
  status: () => request<{ enabled: boolean }>(`${BASE}/status`),
  clarify: (body: { kind: FeedbackKind; text: string; answers: QA[]; round: number }) =>
    request<Clarified>(`${BASE}/clarify`, { method: 'POST', json: body }),
  submit: (body: {
    kind: FeedbackKind
    text: string
    answers: QA[]
    title?: string
    summary?: string
    context: { page?: string; app?: string; browser?: string }
  }) => request<{ number: number; url: string }>(BASE, { method: 'POST', json: body }),
  mine: () => request<{ items: FeedbackItem[] }>(`${BASE}/mine`),
  reply: (number: number, text: string) =>
    request<{ ok: true }>(`${BASE}/${number}/reply`, { method: 'POST', json: { text } }),
}

/** What a member sees for each board column. */
export const STATUS_TEXT: Record<FeedbackStatus, string> = {
  new: 'Received',
  'needs info': 'We have a question',
  'needs decision': 'Being considered',
  approved: 'Planned',
  building: 'Being built',
  shipped: 'Shipped',
  declined: 'Not planned',
}

let enabledOnce: Promise<boolean> | null = null

/** Whether Send feedback is on here, asked once per page load (the rail and menu hide it if not). */
export function feedbackEnabled(): Promise<boolean> {
  enabledOnce ??= feedbackApi.status().then(
    (s) => s.enabled,
    () => {
      enabledOnce = null
      return false
    },
  )
  return enabledOnce
}
