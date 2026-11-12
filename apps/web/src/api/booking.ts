// Client for booking links (ARCHITECTURE §19): the member's links at `/api/booking`, and the
// signed-out booking page at `/api/book/<handle>/<slug>`.

import { request } from './client'

export type Weekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'
export type Hours = Record<Weekday, Array<[string, string]>>

export interface BookingLink {
  slug: string
  title: string
  minutes: number
  tz: string
  hours: Hours
  bufferBefore: number
  bufferAfter: number
  noticeMinutes: number
  horizonDays: number
  dailyCap: number | null
  questions: string[]
  description: string
  active: boolean
  blobOid: string
}

export type BookingInput = Omit<BookingLink, 'slug' | 'blobOid'> & { blobOid: string | null }

export interface BookingStatus {
  ready: boolean
  missing: 'scope' | null
  canTakeBookings: boolean
  handle: string
  links: BookingLink[]
}

export interface Slot {
  start: string
  end: string
}

export type RobotCheckWidget = { kind: 'turnstile'; siteKey: string } | { kind: 'dev' }

export interface PublicBookingPage {
  title: string
  minutes: number
  description: string
  ownerName: string
  questions: string[]
  slots: Slot[]
  robotCheck: RobotCheckWidget | null
  canTakeBookings: boolean
}

export interface Booked {
  start: string
  end: string
  meetLink: string | null
}

const enc = encodeURIComponent

export const bookingApi = {
  status: () => request<BookingStatus>('/api/booking'),
  save: (slug: string, input: BookingInput) =>
    request<BookingLink>(`/api/booking/${enc(slug)}`, { method: 'PUT', json: input }),
  remove: (slug: string, blobOid: string) =>
    request<void>(`/api/booking/${enc(slug)}`, { method: 'DELETE', query: { blobOid } }),
  page: (handle: string, slug: string, from: string, to: string) =>
    request<PublicBookingPage>(`/api/book/${enc(handle)}/${enc(slug)}`, { query: { from, to } }),
  book: (
    handle: string,
    slug: string,
    input: { start: string; name: string; email: string; answers: string[]; token: string },
  ) => request<Booked>(`/api/book/${enc(handle)}/${enc(slug)}`, { method: 'POST', json: input }),
}

/** The public page for a link, on this site. */
export function bookingUrl(handle: string, slug: string, origin = window.location.origin): string {
  return `${origin}/book/${enc(handle)}/${enc(slug)}`
}

/** A link name from a title: lowercase letters, numbers and dashes. */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
      .replace(/-+$/, '') || 'meeting'
  )
}
