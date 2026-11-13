/**
 * Which backups to keep (docs/PLAN-backups-storage.md R5): the newest one, the newest of each of
 * the last `daily` days that have one, and the newest of each of the last `weekly` ISO weeks
 * (UTC). Everything else can go. Pure, so the rule is tested on its own.
 */
export interface Dated {
  key: string
  /** When the backup was made. */
  at: Date
}

export function backupsToDelete<T extends Dated>(
  backups: T[],
  opts: { daily?: number; weekly?: number; now?: Date } = {},
): T[] {
  const daily = opts.daily ?? 14
  const weekly = opts.weekly ?? 8
  const now = opts.now ?? new Date()
  const newest = [...backups].sort((a, b) => b.at.getTime() - a.at.getTime())
  const keep = new Set<string>()
  // Always the newest; then the newest of each of the last `daily` days that have one (so ten
  // "Back up now" clicks in an afternoon don't push older days out).
  if (newest[0]) keep.add(newest[0].key)
  const days = new Set<string>()
  for (const b of newest) {
    const day = b.at.toISOString().slice(0, 10)
    if (days.has(day)) continue
    if (days.size >= daily) break
    days.add(day)
    keep.add(b.key)
  }
  const thisWeek = weekStart(now).getTime()
  const seenWeeks = new Set<number>()
  for (const b of newest) {
    const w = weekStart(b.at).getTime()
    const weeksAgo = Math.round((thisWeek - w) / WEEK_MS)
    if (weeksAgo >= weekly || seenWeeks.has(w)) continue
    seenWeeks.add(w)
    keep.add(b.key)
  }
  return newest.filter((b) => !keep.has(b.key))
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** Midnight UTC on the Monday of `d`'s week. */
function weekStart(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day))
}

/** `2026-11-13T030000Z` style stamps, safe in object keys and sortable. */
export function stampOf(d: Date): string {
  return `${d.toISOString().slice(0, 19).replace(/:/g, '')}Z`
}

/** The date in a backup key made with `stampOf`, or null for other keys. */
export function dateOfKey(key: string): Date | null {
  const m = key.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z\.tar\.gz$/)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`)
}
