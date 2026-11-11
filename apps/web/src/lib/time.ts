const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function relativeTime(at: Date | number | string, now: number = Date.now()): string {
  const then = new Date(at).getTime()
  const ago = now - then
  if (ago < 45_000) return 'just now'
  if (ago < HOUR) return `${Math.round(ago / MINUTE)} min ago`
  if (ago < DAY) return `${Math.round(ago / HOUR)} h ago`
  if (ago < 2 * DAY) return 'yesterday'
  const date = new Date(then)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}
