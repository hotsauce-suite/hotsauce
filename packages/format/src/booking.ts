// Booking links (ARCHITECTURE §19): a booking type is a file in the member's personal space,
// `.hearth/booking/<slug>.md`, and `openSlots` is the pure slot math the public page and the
// booking check share. Written fresh for Hearth (no code copied); every instant is UTC.

import { z } from 'zod'

export const BOOKING_FOLDER = '.hearth/booking'
export const BOOKING_LENGTHS = [15, 30, 45, 60] as const
export const MAX_BOOKING_QUESTIONS = 3
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
export type Weekday = (typeof WEEKDAYS)[number]

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/** The file of a booking type; throws for a slug that isn't lowercase letters, digits and dashes. */
export function bookingPath(slug: string): string {
  if (!SLUG.test(slug)) throw new Error(`Not a booking link name: ${slug}`)
  return `${BOOKING_FOLDER}/${slug}.md`
}

export function isBookingSlug(slug: string): boolean {
  return SLUG.test(slug)
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const Window = z
  .tuple([z.string().regex(HHMM), z.string().regex(HHMM)])
  .refine(([a, b]) => a < b, 'a window must end after it starts')

const DEFAULT_DAY: Array<[string, string]> = [['09:00', '17:00']]
const Hours = z
  .object({
    sun: z.array(Window).max(4).default([]),
    mon: z.array(Window).max(4).default(DEFAULT_DAY),
    tue: z.array(Window).max(4).default(DEFAULT_DAY),
    wed: z.array(Window).max(4).default(DEFAULT_DAY),
    thu: z.array(Window).max(4).default(DEFAULT_DAY),
    fri: z.array(Window).max(4).default(DEFAULT_DAY),
    sat: z.array(Window).max(4).default([]),
  })
  .default({
    sun: [],
    mon: DEFAULT_DAY,
    tue: DEFAULT_DAY,
    wed: DEFAULT_DAY,
    thu: DEFAULT_DAY,
    fri: DEFAULT_DAY,
    sat: [],
  })

/** A booking type's frontmatter. Unknown keys pass through. */
export const BookingFrontmatter = z.looseObject({
  title: z.string().trim().min(1).max(120),
  minutes: z
    .number()
    .refine(
      (n) => (BOOKING_LENGTHS as readonly number[]).includes(n),
      'minutes is 15, 30, 45 or 60',
    ),
  tz: z.string().refine(validZone, 'not a time zone'),
  hours: Hours,
  buffer_before: z.number().int().min(0).max(120).default(0),
  buffer_after: z.number().int().min(0).max(120).default(0),
  /** How soon a booker may book, in minutes from now. */
  notice_minutes: z.number().int().min(0).max(10_080).default(240),
  /** How far ahead, in days. */
  horizon_days: z.number().int().min(1).max(365).default(30),
  /** Most bookings from this link per day; null is no cap. */
  daily_cap: z.number().int().min(1).max(50).nullable().default(null),
  questions: z.array(z.string().trim().min(1).max(200)).max(MAX_BOOKING_QUESTIONS).default([]),
  description: z.string().max(1000).optional(),
  active: z.boolean().default(true),
})
export type BookingFrontmatter = z.infer<typeof BookingFrontmatter>

export interface BookingRules {
  minutes: number
  tz: string
  hours: Record<Weekday, Array<[string, string]>>
  bufferBefore: number
  bufferAfter: number
  noticeMinutes: number
  horizonDays: number
  dailyCap: number | null
}

export function rulesOf(fm: BookingFrontmatter): BookingRules {
  return {
    minutes: fm.minutes,
    tz: fm.tz,
    hours: fm.hours as BookingRules['hours'],
    bufferBefore: fm.buffer_before,
    bufferAfter: fm.buffer_after,
    noticeMinutes: fm.notice_minutes,
    horizonDays: fm.horizon_days,
    dailyCap: fm.daily_cap,
  }
}

export interface Slot {
  start: string
  end: string
}

const MIN = 60_000
const DAY = 86_400_000

const partsCache = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    partsCache.set(tz, f)
  }
  return f
}

/** The wall clock in `tz` at instant `ms`, as UTC milliseconds of the same fields. */
function wallMs(ms: number, tz: string): number {
  const p: Record<string, number> = {}
  for (const part of formatter(tz).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  return Date.UTC(
    p.year ?? 0,
    (p.month ?? 1) - 1,
    p.day ?? 1,
    p.hour ?? 0,
    p.minute ?? 0,
    p.second ?? 0,
  )
}

/** `YYYY-MM-DD` of instant `ms` in `tz`. */
function localDate(ms: number, tz: string): string {
  return new Date(wallMs(ms, tz)).toISOString().slice(0, 10)
}

/**
 * The instant a wall-clock time in `tz` happens. A time that happens twice (fall back) is the
 * first; a time that never happens (spring forward) is null.
 */
export function zonedTimeToUtc(date: string, time: string, tz: string): Date | null {
  const [y, m, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  const wanted = Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0)
  // Try the offsets in force around that time; the earliest that maps back is the answer.
  const candidates = new Set<number>()
  for (const probe of [wanted - DAY / 2, wanted, wanted + DAY / 2]) {
    candidates.add(wanted - (wallMs(probe, tz) - probe))
  }
  const hits = [...candidates].filter((t) => wallMs(t, tz) === wanted).sort((a, b) => a - b)
  return hits[0] === undefined ? null : new Date(hits[0])
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/**
 * Open slots between `from` and `to`: within working hours in the member's time zone, one every
 * `minutes`, not before `now` plus notice, not past `now` plus the horizon, clear of every busy
 * period by the buffers, on a day under its cap (`booked` are this link's booked start times).
 */
export function openSlots(
  rules: BookingRules,
  busy: ReadonlyArray<{ start: string; end: string }>,
  opts: { now: Date; from: string; to: string; booked?: readonly string[] },
): Slot[] {
  const now = opts.now.getTime()
  const earliest = Math.max(Date.parse(opts.from), now + rules.noticeMinutes * MIN)
  const latest = Math.min(Date.parse(opts.to), now + rules.horizonDays * DAY)
  if (!(earliest < latest)) return []
  const busyMs = busy
    .map((b) => [Date.parse(b.start), Date.parse(b.end)] as const)
    .filter(([s, e]) => e > s)
  const perDay = new Map<string, number>()
  for (const b of opts.booked ?? []) {
    const day = localDate(Date.parse(b), rules.tz)
    perDay.set(day, (perDay.get(day) ?? 0) + 1)
  }

  const slots: Slot[] = []
  const lastDay = localDate(latest, rules.tz)
  for (let day = localDate(earliest, rules.tz); day <= lastDay; day = addDays(day, 1)) {
    if (rules.dailyCap !== null && (perDay.get(day) ?? 0) >= rules.dailyCap) continue
    const weekday = WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()] as Weekday
    for (const [open, close] of rules.hours[weekday] ?? []) {
      const [oh, om] = open.split(':').map(Number)
      const [ch, cm] = close.split(':').map(Number)
      const closeMin = (ch ?? 0) * 60 + (cm ?? 0)
      for (let m = (oh ?? 0) * 60 + (om ?? 0); m + rules.minutes <= closeMin; m += rules.minutes) {
        // A start the clock skips (spring forward) doesn't exist. A meeting is its real length.
        const start = zonedTimeToUtc(day, hhmm(m), rules.tz)
        if (!start) continue
        const s = start.getTime()
        const e = s + rules.minutes * MIN
        if (s < earliest || e > latest || e <= s) continue
        const lo = s - rules.bufferBefore * MIN
        const hi = e + rules.bufferAfter * MIN
        if (busyMs.some(([bs, be]) => bs < hi && be > lo)) continue
        slots.push({ start: start.toISOString(), end: new Date(e).toISOString() })
      }
    }
  }
  return slots
}
