/** `1:05`, `12:40`, `1:02:03` for a number of milliseconds. */
export function formatDuration(ms: number | null | undefined): string {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** A transcript line's time, from seconds. */
export function formatTimestamp(seconds: number): string {
  return formatDuration(seconds * 1000)
}

/** "Today, 3:04 PM", "Yesterday, …", or "Nov 3, 3:04 PM". */
export function formatWhen(iso: string, now = new Date()): string {
  const date = new Date(iso)
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(now) - day(date)) / 86_400_000)
  if (days === 0) return `Today, ${time}`
  if (days === 1) return `Yesterday, ${time}`
  const sameYear = date.getFullYear() === now.getFullYear()
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })}, ${time}`
}

/** The index of the transcript line playing at `time`: the last that started at or before it. */
export function activeLine(starts: number[], time: number): number {
  let lo = 0
  let hi = starts.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((starts[mid] as number) <= time + 0.05) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}
