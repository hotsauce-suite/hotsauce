// Client for People (ARCHITECTURE §17): `/api/people` and `/api/companies`.

import { request } from './client'
import type { TaskView } from './tasks'

export interface MeetingRef {
  space: string
  path: string
  title: string
  date: string
}

export interface PersonSummary {
  email: string
  name: string | null
  /** The email's domain; null for personal mail. */
  company: string | null
  team: boolean
  meetings: number
  last: MeetingRef | null
  next: { title: string; start: string } | null
}

export interface PersonView extends PersonSummary {
  history: MeetingRef[]
  tasks: TaskView[]
  about: { text: string; blobOid: string | null }
  /** Only for someone the whole team can already see. */
  canEditAbout: boolean
}

export interface CompanyView {
  domain: string
  team: boolean
  people: PersonSummary[]
  meetings: MeetingRef[]
}

const enc = encodeURIComponent

export const peopleApi = {
  list: (q?: string) =>
    request<{ people: PersonSummary[] }>('/api/people', q?.trim() ? { query: { q } } : {}),
  get: (email: string) => request<PersonView>(`/api/people/${enc(email)}`),
  saveAbout: (email: string, text: string, blobOid: string | null) =>
    request<{ blobOid: string }>(`/api/people/${enc(email)}/about`, {
      method: 'PUT',
      json: { text, blobOid },
    }),
  company: (domain: string) => request<CompanyView>(`/api/companies/${enc(domain)}`),
}

/** A person's page. */
export function personUrl(email: string): string {
  return `/people/${enc(email.toLowerCase())}`
}

/** A company's page. */
export function companyUrl(domain: string): string {
  return `/people/company/${enc(domain.toLowerCase())}`
}

/** What to call someone: their name, else their email. */
export function displayName(p: Pick<PersonSummary, 'name' | 'email'>): string {
  return p.name ?? p.email
}
