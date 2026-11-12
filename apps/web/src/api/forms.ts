// Client for Hearth Forms (ARCHITECTURE §21): building forms and reading answers at
// `/api/forms`, chat rooms at `/api/chat-rooms`, and the fill page at `/api/form/<link>`.

import type { Answers, FormAccess, Question } from '@hearth/format'
import type { RobotCheckWidget } from './booking'
import { request, requestBlob } from './client'

export type {
  AnswerFile,
  Answers,
  AnswerValue,
  FormAccess,
  Question,
  QuestionType,
} from '@hearth/format'

export interface FormSummary {
  space: string
  id: string
  title: string
  access: FormAccess
  open: boolean
  answerCount: number
  lastAnswer: string | null
  updated: string | null
  updatedBy: string | null
}

export interface FormView extends FormSummary {
  description: string
  questions: Question[]
  room: string | null
  url: string
  created: string | null
  createdBy: string | null
  blobOid: string
}

export interface FormInput {
  title: string
  description: string
  questions: Question[]
  access: FormAccess
  open: boolean
  room: string | null
  blobOid: string
}

export interface AnswerRow {
  id: string
  submitted: string
  submittedBy: string | null
  answers: Answers
}

export interface Tally {
  question: string
  counts?: Array<{ option: string; count: number }>
  average?: number
  answered: number
}

export interface Summary {
  summary: string | null
  tallies: Tally[]
  read: number
  total: number
}

export interface FillPage {
  title: string
  description: string
  questions: Question[]
  access: FormAccess
  open: boolean
  canTakeAnswers: boolean
  robotCheck: RobotCheckWidget | null
  maxFiles: number
  maxFileBytes: number
}

export interface ChatRoom {
  id: string
  name: string
  last4?: string
}

const enc = encodeURIComponent
const at = (space: string, id: string) => `/api/forms/${enc(space)}/${enc(id)}`

export const formsApi = {
  list: () => request<{ forms: FormSummary[]; canSummarize: boolean }>('/api/forms'),
  create: (space: string, title: string) =>
    request<FormView>('/api/forms', { method: 'POST', json: { space, title } }),
  get: (space: string, id: string) => request<FormView>(at(space, id)),
  save: (space: string, id: string, input: FormInput) =>
    request<FormView>(at(space, id), { method: 'PUT', json: input }),
  remove: (space: string, id: string) => request<void>(at(space, id), { method: 'DELETE' }),
  answers: (space: string, id: string) =>
    request<{ answers: AnswerRow[] }>(`${at(space, id)}/answers`),
  removeAnswer: (space: string, id: string, answer: string) =>
    request<void>(`${at(space, id)}/answers/${enc(answer)}`, { method: 'DELETE' }),
  csv: (space: string, id: string) => requestBlob(`${at(space, id)}/csv`),
  summarize: (space: string, id: string) =>
    request<Summary>(`${at(space, id)}/summary`, { method: 'POST' }),
  rooms: () => request<{ rooms: ChatRoom[]; canManage: boolean }>('/api/chat-rooms'),
  addRoom: (name: string, url: string) =>
    request<ChatRoom>('/api/chat-rooms', { method: 'POST', json: { name, url } }),
  removeRoom: (id: string) => request<void>(`/api/chat-rooms/${enc(id)}`, { method: 'DELETE' }),
  fill: (link: string) => request<FillPage>(`/api/form/${enc(link)}`),
  submit: (
    link: string,
    input: { answers: Record<string, unknown>; token: string; files: Array<[string, File]> },
  ) => {
    if (input.files.length === 0) {
      return request<{ id: string }>(`/api/form/${enc(link)}`, {
        method: 'POST',
        json: { answers: input.answers, token: input.token },
      })
    }
    const form = new FormData()
    form.set('payload', JSON.stringify({ answers: input.answers, token: input.token }))
    for (const [question, file] of input.files) form.append(`file:${question}`, file)
    return request<{ id: string }>(`/api/form/${enc(link)}`, { method: 'POST', form })
  },
}
