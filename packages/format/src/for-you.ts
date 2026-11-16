// For you (docs/PLAN-comments.md, slice 2): the list of what is waiting on a member is worked out
// from the index; only the member's own marks are kept, one JSON file in their personal space,
// `.hearth/for-you.json`. Everything here is pure: the file, and the rules for what shows.

import { z } from 'zod'
import { zonedTimeToUtc } from './booking.js'
import { isCommentableId } from './comments.js'

export const FOR_YOU_STATE_PATH = '.hearth/for-you.json'
/** Marks past this many are dropped when the file is written, the oldest first. */
export const MAX_FOR_YOU_MARKS = 1_000

/** A member's marks on one item, as instants (ISO strings). */
export interface ForYouMark {
  /** When they last opened it. Activity after this counts again. */
  seen?: string
  /** When they marked it Done. Only activity after this brings it back. */
  done?: string
  /** Hidden until this instant (9 AM in their zone), then back at the top and counted. */
  later?: string
  /** When they chose Later: activity after this brings it back at once. */
  laterAt?: string
}

export interface ForYouState {
  schema: 1
  /** By item `id`. */
  items: Record<string, ForYouMark>
}

export const emptyForYouState = (): ForYouState => ({ schema: 1, items: {} })

const Instant = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)))
const RawMark = z.looseObject({
  seen: z.unknown().optional(),
  done: z.unknown().optional(),
  later: z.unknown().optional(),
  laterAt: z.unknown().optional(),
})
const RawState = z.looseObject({ schema: z.literal(1), items: z.record(z.string(), z.unknown()) })

const MARK_KEYS = ['seen', 'done', 'later', 'laterAt'] as const

/**
 * Reads the file's text (or a parsed value). What isn't understood is dropped: an entry for an id
 * that can't be an item, a mark that isn't an instant. Something that isn't a state file at all
 * reads as empty, since these marks are a convenience and never worth an error page.
 */
export function parseForYouState(input: string | unknown): ForYouState {
  let data: unknown = input
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input)
    } catch {
      return emptyForYouState()
    }
  }
  const raw = RawState.safeParse(data)
  if (!raw.success) return emptyForYouState()
  const items: Record<string, ForYouMark> = {}
  for (const [id, value] of Object.entries(raw.data.items)) {
    if (!isCommentableId(id)) continue
    const m = RawMark.safeParse(value)
    if (!m.success) continue
    const mark: ForYouMark = {}
    for (const key of MARK_KEYS) {
      const v = Instant.safeParse(m.data[key])
      if (v.success) mark[key] = new Date(v.data).toISOString()
    }
    if (Object.keys(mark).length > 0) items[id] = mark
  }
  return { schema: 1, items }
}

/** The file's text: items by id, at most `MAX_FOR_YOU_MARKS` (the most recently touched kept). */
export function serializeForYouState(state: ForYouState): string {
  const clean = parseForYouState(state)
  const entries = Object.entries(clean.items)
    .sort((a, b) => latestOf(b[1]).localeCompare(latestOf(a[1])))
    .slice(0, MAX_FOR_YOU_MARKS)
    .sort((a, b) => a[0].localeCompare(b[0]))
  return `${JSON.stringify({ schema: 1, items: Object.fromEntries(entries) }, null, 2)}\n`
}

function latestOf(mark: ForYouMark): string {
  return MARK_KEYS.map((k) => mark[k] ?? '').reduce((a, b) => (b > a ? b : a), '')
}

export type ForYouAction =
  | { action: 'seen' }
  | { action: 'done' }
  | { action: 'undone' }
  | { action: 'later'; until: string }

/** The marks after the member acts on one item at `now`. */
export function markForYou(
  state: ForYouState,
  item: string,
  act: ForYouAction,
  now: Date,
): ForYouState {
  const at = now.toISOString()
  const mark: ForYouMark = { ...state.items[item] }
  switch (act.action) {
    case 'seen':
      mark.seen = at
      break
    case 'done':
      mark.done = at
      // Done is final until something new arrives; a pending Later no longer applies.
      delete mark.later
      delete mark.laterAt
      break
    case 'undone':
      delete mark.done
      break
    case 'later':
      mark.later = new Date(act.until).toISOString()
      mark.laterAt = at
      delete mark.done
      break
  }
  const items = { ...state.items }
  if (Object.keys(mark).length > 0) items[item] = mark
  else delete items[item]
  return { schema: 1, items }
}

/** Where an item stands for the member: hidden, or shown with when it last moved and whether it counts. */
export type ForYouStanding = { shown: false } | { shown: true; at: string; unseen: boolean }

/**
 * `activity` is the item's latest instant that is for the member (the newest mention of them).
 *
 * - Done hides it until activity after Done.
 * - Later hides it until its time, or until activity after Later was chosen. Once its time passes
 *   it is back at the top (`at` is the Later time) and counts again.
 * - It counts (unseen) when nothing has happened since they last opened it.
 */
export function forYouStanding(
  mark: ForYouMark | undefined,
  activity: string,
  now: Date,
): ForYouStanding {
  const t = (s: string | undefined) => (s ? Date.parse(s) : Number.NEGATIVE_INFINITY)
  const act = t(activity)
  if (act <= t(mark?.done)) return { shown: false }
  let at = act
  // A mention after Later was chosen ends the Later: it doesn't come round again at 9 AM.
  if (mark?.later && act <= t(mark.laterAt)) {
    const until = t(mark.later)
    if (until > now.getTime()) return { shown: false }
    if (until > at) at = until
  }
  return { shown: true, at: new Date(at).toISOString(), unseen: at > t(mark?.seen) }
}

/**
 * 9 AM in `timeZone` on the next day ("tomorrow"), or on the next Monday after today ("monday";
 * on a Monday, the one a week on). Throws a RangeError for a zone the runtime doesn't know.
 */
export function laterUntil(when: 'tomorrow' | 'monday', now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const today = Date.parse(`${parts}T00:00:00Z`)
  const weekday = new Date(today).getUTCDay() // 0 Sunday … 6 Saturday
  const days = when === 'tomorrow' ? 1 : (8 - weekday) % 7 || 7
  const date = new Date(today + days * 86_400_000).toISOString().slice(0, 10)
  return zonedTimeToUtc(date, '09:00', timeZone) ?? new Date(`${date}T09:00:00Z`)
}
