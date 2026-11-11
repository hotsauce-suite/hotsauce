import { HearthError } from '../errors.js'

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** `-04:00`, `+05:30`, or `+00:00`. */
  offset: string
}

/** Throws bad_request unless `timeZone` is an IANA zone this runtime knows. */
export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
  } catch {
    throw new HearthError('bad_request', `Unknown time zone: ${timeZone}`)
  }
}

/** The wall clock at `instant` in `timeZone`, which the member's browser reports. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'longOffset',
  }).formatToParts(instant)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? ''
  // longOffset is "GMT-04:00", or plain "GMT" at UTC.
  const offset = part('timeZoneName').replace(/^GMT/, '') || '+00:00'
  return {
    year: Number(part('year')),
    month: Number(part('month')),
    day: Number(part('day')),
    hour: Number(part('hour')),
    minute: Number(part('minute')),
    second: Number(part('second')),
    offset,
  }
}

/** `2026-10-07T15:00:00-04:00`: the instant, written in the member's zone. */
export function isoInZone(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone)
  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    p.offset
  )
}

/**
 * A Date whose local calendar day is the member's day at `instant`. `meetingPaths` reads the
 * runtime's local fields, so this keeps the server's own zone out of file names.
 */
export function calendarDayIn(instant: Date, timeZone: string): Date {
  const p = zonedParts(instant, timeZone)
  return new Date(p.year, p.month - 1, p.day)
}

/** "3:04 PM" in the member's zone. */
export function clockTimeIn(instant: Date, timeZone: string): string {
  return (
    new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })
      .format(instant)
      // Recent ICU puts a narrow no-break space before AM/PM.
      .replace(/\s+/g, ' ')
  )
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
