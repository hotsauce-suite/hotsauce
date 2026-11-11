import type { CalendarEvent } from './types.js'

const HOUR = 60 * 60_000
const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/

/** The call's code ("abc-defg-hij") from an event's Meet link, or null. */
export function meetCode(link: string | undefined): string | null {
  if (!link) return null
  try {
    const url = new URL(link)
    const code = url.pathname.replace(/^\/|\/$/g, '')
    return url.hostname === 'meet.google.com' && MEET_CODE.test(code) ? code : null
  } catch {
    return null
  }
}

/** Whether anyone but the member is invited: a meeting, not a focus block. */
export function hasOthers(event: CalendarEvent, memberEmail: string): boolean {
  const me = memberEmail.toLowerCase()
  return event.attendees.some((a) => a.email.toLowerCase() !== me)
}

/**
 * The event a Meet call belongs to (ARCHITECTURE §7.8): the one whose Meet link is the call,
 * nearest to now within 12 hours (a weekly series shares one link); else the meeting overlapping
 * now that started most recently; else null.
 */
export function matchMeetEvent(
  events: readonly CalendarEvent[],
  code: string,
  memberEmail: string,
  now: number,
): { event: CalendarEvent | null; by: 'meet' | 'now' | null } {
  const distance = (e: CalendarEvent) => {
    const start = Date.parse(e.start)
    const end = Date.parse(e.end)
    return now < start ? start - now : now > end ? now - end : 0
  }
  let best: CalendarEvent | null = null
  for (const event of events) {
    if (!code || meetCode(event.meetLink) !== code || distance(event) > 12 * HOUR) continue
    if (!best || distance(event) < distance(best)) best = event
  }
  if (best) return { event: best, by: 'meet' }
  let current: CalendarEvent | null = null
  for (const event of events) {
    if (Date.parse(event.start) > now || Date.parse(event.end) <= now) continue
    if (!hasOthers(event, memberEmail)) continue
    // A call with a different Meet link is some other meeting, not this one.
    const theirs = meetCode(event.meetLink)
    if (code && theirs && theirs !== code) continue
    if (!current || Date.parse(event.start) > Date.parse(current.start)) current = event
  }
  return current ? { event: current, by: 'now' } : { event: null, by: null }
}

export interface NoteRef {
  space: string
  path: string
  title: string
}

export interface CoverageItem {
  event: CalendarEvent
  note: NoteRef | null
}

/**
 * Past meetings and whether they have notes (ARCHITECTURE §7.8): events that ended by `now` and
 * have someone besides the member, newest first, each with the note whose `calendar_event_id`
 * is the event's (from `notes`, which lists the member's own space first).
 */
export function coverage(
  events: readonly CalendarEvent[],
  notes: ReadonlyMap<string, NoteRef>,
  memberEmail: string,
  now: number,
): CoverageItem[] {
  return events
    .filter((e) => Date.parse(e.end) <= now && hasOthers(e, memberEmail))
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start) || a.id.localeCompare(b.id))
    .map((event) => ({ event, note: notes.get(event.id) ?? null }))
}
