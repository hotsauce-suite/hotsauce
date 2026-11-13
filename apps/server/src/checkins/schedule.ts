// When a check-in's rounds open (ARCHITECTURE §24.2). Pure: every function takes the instant
// and the zone, so tests pin both.

import { type CheckinFrontmatter, WEEKDAYS, type Weekday } from '@hearth/format'
import { zonedParts } from '../meetings/zoned-time.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** A member's current round is at most this many days old: past it, they've missed it. */
export const ROUND_LOOKBACK_DAYS = 7
/** Rounds older than this are never summarised late. */
export const SUMMARY_LOOKBACK_DAYS = 3

/** The member's calendar date at `instant`, `YYYY-MM-DD`. */
export function localDate(instant: Date, tz: string): string {
  const p = zonedParts(instant, tz)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** `date` (`YYYY-MM-DD`) shifted by whole days. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)
}

export function weekdayOf(date: string): Weekday {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] as Weekday
}

/** The instant the wall clock in `tz` reads `date time`. A time skipped by a DST jump moves on. */
export function instantOf(date: string, time: string, tz: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number]
  const [h, mi] = time.split(':').map(Number) as [number, number]
  const wall = Date.UTC(y, mo - 1, d, h, mi)
  let guess = wall
  // Two passes settle the offset, including across a DST change between guess and answer.
  for (let i = 0; i < 2; i++) guess = wall - offsetMs(new Date(guess), tz)
  return new Date(guess)
}

function offsetMs(instant: Date, tz: string): number {
  const p = zonedParts(instant, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000
}

export interface Round {
  date: string
  opensAt: Date
}

type Schedule = Pick<CheckinFrontmatter, 'days' | 'time' | 'created'>

/**
 * The member's current round: the latest scheduled date whose time has come in their zone,
 * within a week, and not before the check-in was set up. Null when there is none yet.
 */
export function currentRound(fm: Schedule, now: Date, tz: string): Round | null {
  const created = Date.parse(fm.created)
  const today = localDate(now, tz)
  for (let back = 0; back <= ROUND_LOOKBACK_DAYS; back++) {
    const date = addDays(today, -back)
    if (!fm.days.includes(weekdayOf(date))) continue
    const opensAt = instantOf(date, fm.time, tz)
    if (opensAt.getTime() > now.getTime()) continue
    if (opensAt.getTime() < created) return null
    return { date, opensAt }
  }
  return null
}

/** Rounds in the check-in's own zone that have opened in the last few days, newest first. */
export function recentRounds(fm: Schedule & { tz: string }, now: Date): Round[] {
  const out: Round[] = []
  const today = localDate(now, fm.tz)
  for (let back = 0; back <= SUMMARY_LOOKBACK_DAYS; back++) {
    const date = addDays(today, -back)
    if (!fm.days.includes(weekdayOf(date))) continue
    const opensAt = instantOf(date, fm.time, fm.tz)
    if (opensAt.getTime() > now.getTime() || opensAt.getTime() < Date.parse(fm.created)) continue
    out.push({ date, opensAt })
  }
  return out
}

/** When a round's summary goes even if people are missing: 5 PM, or two hours after the question. */
export function summaryDeadline(fm: Pick<CheckinFrontmatter, 'time' | 'tz'>, date: string): Date {
  const five = instantOf(date, '17:00', fm.tz).getTime()
  const twoAfter = instantOf(date, fm.time, fm.tz).getTime() + 2 * HOUR
  return new Date(Math.max(five, twoAfter))
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
