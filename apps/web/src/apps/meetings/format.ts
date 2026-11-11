// Display helpers for Meetings: times, days, names. Locale-aware, never codenames.

const DAY = 86_400_000

export function startOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

/** `YYYY-MM-DD` in local time, for grouping by day. */
export function dayKey(date: Date): string {
  const d = startOfDay(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** "Today", "Yesterday", "Tomorrow", else "Wed, Oct 7" (with the year when it isn't this one). */
export function dayLabel(date: Date, now: Date = new Date()): string {
  const days = Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / DAY)
  if (days === 0) return 'Today'
  if (days === -1) return 'Yesterday'
  if (days === 1) return 'Tomorrow'
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
}

export function timeLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** What an ad-hoc meeting is called until it's renamed (PRD §6.1): "3:05 PM Meeting". */
export function defaultMeetingTitle(now: Date = new Date()): string {
  return `${timeLabel(now)} Meeting`
}

/** "12:04" under an hour, "1:02:09" past it. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** "Dana Lee <dana@acme.com>" → "Dana Lee"; a bare address → its local part. */
export function attendeeName(attendee: string): string {
  const named = /^(.*?)\s*<[^>]+>$/.exec(attendee.trim())
  if (named?.[1]) return named[1]
  return attendee.trim().split('@')[0] ?? attendee
}

/** "meetings/2026/10/2026-10-07-acme-sync.transcript.md" → "Acme sync". */
export function meetingLabel(path: string): string {
  const name = path
    .slice(path.lastIndexOf('/') + 1)
    .replace(/\.md$/i, '')
    .replace(/\.transcript$/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')
    .replace(/-/g, ' ')
  return name ? name[0]?.toUpperCase() + name.slice(1) : path
}

export const isTranscriptPath = (path: string) => /\.transcript\.md$/i.test(path)
