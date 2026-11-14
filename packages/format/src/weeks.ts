import { addDays, weekday } from './tasks.js'

// Weeks in Hotsauce run Monday to Sunday (docs/PLAN-monday-weeks.md). Dates are `YYYY-MM-DD`.

/** Short day names in week order, Monday first. */
export const WEEK_DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

/** Days since Monday: 0 for Monday … 6 for Sunday. */
export function daysSinceMonday(date: string): number {
  return (weekday(date) + 6) % 7
}

/** The Monday on or before `date`. */
export function startOfWeek(date: string): string {
  return addDays(date, -daysSinceMonday(date))
}

/** The Sunday on or after `date`. */
export function endOfWeek(date: string): string {
  return addDays(startOfWeek(date), 6)
}

/**
 * The weeks of the month `month` (`YYYY-MM`) as Monday-to-Sunday rows of dates. The first and
 * last rows include days of the months either side, so every row has seven days.
 */
export function monthGrid(month: string): string[][] {
  const first = `${month}-01`
  const rows: string[][] = []
  let day = startOfWeek(first)
  do {
    rows.push(Array.from({ length: 7 }, (_, i) => addDays(day, i)))
    day = addDays(day, 7)
  } while (day.slice(0, 7) === month)
  return rows
}
