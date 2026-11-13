import type { Weekday } from '../../api/checkins'

export const WEEKDAY_ORDER: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
export const WEEKDAY_SHORT: Record<Weekday, string> = {
  sun: 'Sun',
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
}

/** "Monday, November 16" for a round's date. */
export function roundLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export const DEFAULTS = [
  { title: 'What will you get done this week?', days: ['mon'] as Weekday[], time: '09:00' },
  { title: 'What got done, and what’s stuck?', days: ['fri'] as Weekday[], time: '15:00' },
]
