// Which apps get used (docs/PLAN-app-usage.md): counted from history that already exists, with
// no tracking added. Pure: the service feeds it commits and clips, and it hands back numbers only.

import type { ActivityCommit } from '../git/index.js'

/** The apps that write files, plus Clips (its own list). Ids match the web app's `AppId`. */
export const COUNTED_APPS = [
  'docs',
  'meetings',
  'tasks',
  'notes',
  'boards',
  'people',
  'files',
  'forms',
  'checkins',
  'tables',
  'links',
  'pages',
  'clips',
  'briefcast',
] as const
export type CountedApp = (typeof COUNTED_APPS)[number]

/** Top folder → app (U4). Mirrors the `folder` of each web manifest; `pages/` is Pages. */
const FOLDERS: Record<string, CountedApp> = {
  docs: 'docs',
  meetings: 'meetings',
  tasks: 'tasks',
  notes: 'notes',
  boards: 'boards',
  people: 'people',
  files: 'files',
  forms: 'forms',
  checkins: 'checkins',
  tables: 'tables',
  links: 'links',
  pages: 'pages',
}

const BRIEFCAST_DIR = '.hearth/briefcast/'
/** `SpaceService` seeds every new space with a commit starting so. */
const SPACE_SEED_SUBJECT = 'hotsauce: create space '

/** The app a file belongs to; null for hidden files, which no app shows as an item. */
export function appOfPath(path: string): CountedApp | null {
  if (path.startsWith(BRIEFCAST_DIR)) return 'briefcast'
  if (path.split('/').some((part) => part.startsWith('.'))) return null
  const slash = path.indexOf('/')
  const top = slash === -1 ? '' : path.slice(0, slash)
  return FOLDERS[top] ?? 'docs'
}

/** The Monday (UTC) starting the week `date` falls in, as YYYY-MM-DD. */
export function weekOf(date: Date): string {
  const day = (date.getUTCDay() + 6) % 7 // Monday 0 … Sunday 6
  const monday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day),
  )
  return monday.toISOString().slice(0, 10)
}

/** The `weeks` Mondays ending with the current week, oldest first. */
export function weekStarts(now: Date, weeks: number): string[] {
  const current = Date.parse(`${weekOf(now)}T00:00:00Z`)
  return Array.from({ length: weeks }, (_, i) =>
    new Date(current - (weeks - 1 - i) * 7 * 86_400_000).toISOString().slice(0, 10),
  )
}

export interface WeekCount {
  /** The week's Monday, YYYY-MM-DD. */
  week: string
  /** Items made that week. */
  created: number
  /** Items made or changed that week (each item once). */
  changed: number
  /** Different people who made or changed something. */
  people: number
}

export interface AppUsage {
  id: CountedApp
  weeks: WeekCount[]
  /** Over the whole window: items made, items made or changed (each once), different people. */
  total: { created: number; changed: number; people: number }
  /** Different people in the last four weeks. */
  peopleLast4Weeks: number
}

export interface UsageReport {
  generatedAt: string
  /** Mondays, oldest first; the last is the current week, so far. */
  weeks: string[]
  /** Busiest first (items changed, then people); ties in `COUNTED_APPS` order. */
  apps: AppUsage[]
  dictate: { connectedMacs: number; usedLast7Days: number }
}

export interface UsageInput {
  now: Date
  weeks: number
  /** Each space's commits; the space's name is only a key and never leaves this function. */
  spaces: Array<{ space: string; commits: ActivityCommit[] }>
  clips: Array<{ id: string; ownerEmail: string; createdAt: string }>
  dictateDevices: Array<{ lastUsedAt: string | null }>
  /** Hotsauce's own committer address: its changes are nobody using an app (U5). */
  ignoreEmails: string[]
}

interface Bucket {
  created: Set<string>
  changed: Set<string>
  people: Set<string>
}

const emptyBucket = (): Bucket => ({ created: new Set(), changed: new Set(), people: new Set() })

export function buildUsageReport(input: UsageInput): UsageReport {
  const weeks = weekStarts(input.now, input.weeks)
  const first = weeks[0] ?? weekOf(input.now)
  const ignore = new Set(input.ignoreEmails.map((e) => e.toLowerCase()))
  const buckets = new Map<CountedApp, Map<string, Bucket>>(
    COUNTED_APPS.map((app) => [app, new Map(weeks.map((w) => [w, emptyBucket()]))]),
  )
  const bucket = (app: CountedApp, when: Date): Bucket | undefined => {
    const week = weekOf(when)
    return week < first ? undefined : buckets.get(app)?.get(week)
  }

  for (const { space, commits } of input.spaces) {
    for (const commit of commits) {
      const email = commit.email.toLowerCase()
      if (email === '' || ignore.has(email)) continue
      // A new space's README and folders are Hotsauce's, though the member is the author (U5).
      if (commit.subject.startsWith(SPACE_SEED_SUBJECT)) continue
      const when = new Date(commit.date)
      if (Number.isNaN(when.getTime()) || when > input.now) continue
      for (const file of commit.files) {
        const app = appOfPath(file.path)
        if (app === null) continue
        const b = bucket(app, when)
        if (!b) continue
        const key = `${space}\u0000${file.path}`
        if (file.change === 'added') b.created.add(key)
        b.changed.add(key)
        b.people.add(email)
      }
    }
  }
  for (const clip of input.clips) {
    const when = new Date(clip.createdAt)
    if (Number.isNaN(when.getTime()) || when > input.now) continue
    const b = bucket('clips', when)
    if (!b) continue
    b.created.add(clip.id)
    b.changed.add(clip.id)
    b.people.add(clip.ownerEmail.toLowerCase())
  }

  const last4 = new Set(weeks.slice(-4))
  const apps: AppUsage[] = COUNTED_APPS.map((id) => {
    const byWeek = buckets.get(id) ?? new Map<string, Bucket>()
    const all = emptyBucket()
    const recentPeople = new Set<string>()
    const counts = weeks.map((week) => {
      const b = byWeek.get(week) ?? emptyBucket()
      for (const k of b.created) all.created.add(k)
      for (const k of b.changed) all.changed.add(k)
      for (const p of b.people) {
        all.people.add(p)
        if (last4.has(week)) recentPeople.add(p)
      }
      return { week, created: b.created.size, changed: b.changed.size, people: b.people.size }
    })
    return {
      id,
      weeks: counts,
      total: { created: all.created.size, changed: all.changed.size, people: all.people.size },
      peopleLast4Weeks: recentPeople.size,
    }
  })
  const order = new Map(COUNTED_APPS.map((id, i) => [id, i]))
  apps.sort(
    (a, b) =>
      b.total.changed - a.total.changed ||
      b.total.people - a.total.people ||
      (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  )

  const weekAgo = input.now.getTime() - 7 * 86_400_000
  return {
    generatedAt: input.now.toISOString(),
    weeks,
    apps,
    dictate: {
      connectedMacs: input.dictateDevices.length,
      usedLast7Days: input.dictateDevices.filter(
        (d) => d.lastUsedAt !== null && Date.parse(d.lastUsedAt) >= weekAgo,
      ).length,
    },
  }
}
