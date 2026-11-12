import { SPACE_LAYOUT, transcriptPathFor } from '@hearth/format'
import type { Index } from '../index/index.js'

export interface MeetingListItem {
  space: string
  path: string
  title: string
  date: string
  duration_min: number | null
  attendees: string[]
  companies: string[]
  template: string | null
  hasTranscript: boolean
}

export interface MeetingFilters {
  /** ISO timestamps; a bare date is midnight UTC. `to` is exclusive. */
  from?: string | undefined
  to?: string | undefined
  /** An attendee's email, matched whole and case-insensitively. */
  person?: string | undefined
  /** A company domain, matched whole and case-insensitively. */
  company?: string | undefined
  /** A folder under `meetings/`. */
  folder?: string | undefined
}

/**
 * `GET /api/meetings`: meeting notes in `spaces`, newest first, read from the index's copy of
 * each note's frontmatter (no Git reads). A note counts when its frontmatter says `type: meeting`.
 */
export function listMeetings(
  index: Pick<Index, 'listFiles'>,
  spaces: string[],
  filters: MeetingFilters,
): MeetingListItem[] {
  const prefix = folderPrefix(filters.folder)
  const from = filters.from ? Date.parse(filters.from) : null
  const to = filters.to ? Date.parse(filters.to) : null
  const items: MeetingListItem[] = []
  for (const space of spaces) {
    const transcripts = new Set(
      index.listFiles({ space, kind: 'transcript', prefix }).map((f) => f.path),
    )
    for (const file of index.listFiles({ space, kind: 'meeting', prefix })) {
      const fm = file.frontmatter
      if (fm?.type !== 'meeting') continue
      if (!matchesPerson(fm, filters.person) || !matchesCompany(fm, filters.company)) continue
      const date = typeof fm.date === 'string' ? fm.date : ''
      const time = Date.parse(date)
      if (from !== null && !(time >= from)) continue
      if (to !== null && !(time < to)) continue
      items.push({
        space,
        path: file.path,
        title: file.title,
        date,
        duration_min: typeof fm.duration_min === 'number' ? fm.duration_min : null,
        attendees: strings(fm.attendees),
        companies: strings(fm.companies),
        template: typeof fm.template === 'string' ? fm.template : null,
        hasTranscript: (() => {
          const transcriptPath = transcriptPathFor(file.path, fm)
          return transcriptPath !== null && transcripts.has(transcriptPath)
        })(),
      })
    }
  }
  // Newest first by instant (dates carry their owner's offset), then by path.
  return items.sort(
    (a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) || a.path.localeCompare(b.path),
  )
}

/** `person` is an email: an attendee matches when theirs is the same, ignoring case. */
export function matchesPerson(
  fm: Record<string, unknown> | null,
  person: string | undefined,
): boolean {
  if (!person?.trim()) return true
  const needle = person.trim().toLowerCase()
  return strings(fm?.attendees).some((a) => attendeeEmail(a) === needle)
}

/** `company` is a domain: a note matches when one of its companies is that domain, ignoring case. */
export function matchesCompany(
  fm: Record<string, unknown> | null,
  company: string | undefined,
): boolean {
  if (!company?.trim()) return true
  const needle = company.trim().toLowerCase()
  return strings(fm?.companies).some((c) => c.trim().toLowerCase() === needle)
}

/** The email of an attendee written `Name <email>` or as a bare email, lowercased. */
export function attendeeEmail(attendee: string): string {
  const bracketed = /<([^<>]*)>\s*$/.exec(attendee)
  return (bracketed?.[1] ?? attendee).trim().toLowerCase()
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** A folder under `meetings/`, with its trailing slash, as an index prefix. */
export function folderPrefix(folder: string | undefined): string | undefined {
  const clean = folder?.replace(/^\/+|\/+$/g, '')
  if (!clean) return undefined
  const root = SPACE_LAYOUT.meetings
  return clean === root || clean.startsWith(`${root}/`) ? `${clean}/` : `${root}/${clean}/`
}
