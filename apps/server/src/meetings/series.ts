import { parseFrontmatter } from '@hearth/format'
import type { Principal } from '../auth/index.js'
import type { GitStore } from '../git/index.js'
import type { Index } from '../index/index.js'
import type { SpaceService } from '../spaces/index.js'

/** How many earlier notes of a series Enhance sees, and how much of each. */
export const SERIES_CONTEXT_NOTES = 3
export const SERIES_CONTEXT_CHARS = 4000

export interface SeriesNote {
  title: string
  date: string
  notes: string
}

/** An earlier note must start at least this long before: not a colleague's note of this one. */
const MIN_GAP_MS = 60 * 60_000

/**
 * The last few notes of the same recurring meeting before this one (PRD P1, ARCHITECTURE §7.8):
 * meeting notes with the same `calendar_series_id`, dated an hour or more before `date` and for
 * another calendar event, newest first, bodies capped. Only from spaces no more widely read than
 * the note's own: a note in the team space never draws on someone's personal space, since what
 * Enhance writes there the whole team reads. A note unreadable from Git is skipped.
 */
export async function previousInSeries(
  deps: {
    index: Pick<Index, 'listFiles'>
    git: Pick<GitStore, 'readFile'>
    spaces: Pick<SpaceService, 'visibleSpaces'>
  },
  principal: Principal,
  note: { seriesId: string; date: string; space: string; path: string; eventId?: string },
): Promise<SeriesNote[]> {
  const before = Date.parse(note.date) - MIN_GAP_MS
  const candidates: Array<{ space: string; path: string; title: string; date: string }> = []
  const visible = await deps.spaces.visibleSpaces(principal)
  const target = visible.find((s) => s.name === note.space)
  // A personal space's reader (its owner) reads the team space too; not the other way round.
  const sources =
    target?.kind === 'personal' ? visible : visible.filter((s) => s.name === note.space)
  for (const space of sources) {
    for (const file of deps.index.listFiles({ space: space.name, kind: 'meeting' })) {
      const fm = file.frontmatter
      if (fm?.type !== 'meeting' || fm.calendar_series_id !== note.seriesId) continue
      if (space.name === note.space && file.path === note.path) continue
      if (note.eventId && fm.calendar_event_id === note.eventId) continue
      const date = typeof fm.date === 'string' ? fm.date : ''
      if (!(Date.parse(date) <= before)) continue
      candidates.push({ space: space.name, path: file.path, title: file.title, date })
    }
  }
  candidates.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
  const out: SeriesNote[] = []
  for (const c of candidates) {
    if (out.length === SERIES_CONTEXT_NOTES) break
    try {
      const { content } = await deps.git.readFile(c.space, c.path)
      const body = parseFrontmatter(content).body.trim()
      out.push({ title: c.title, date: c.date, notes: body.slice(0, SERIES_CONTEXT_CHARS) })
    } catch {
      // Moved or deleted since the index saw it; the next one will do.
    }
  }
  return out
}
