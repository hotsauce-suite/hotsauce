import {
  dropEchoes,
  formatTranscriptLine,
  meetingPaths,
  patchFrontmatter,
  SPACE_LAYOUT,
} from '@hearth/format'
import { stringify } from 'yaml'
import { z } from 'zod'
import { PCM_BYTES_PER_MS, type TranscriptSegment } from './transcriber/types.js'
import { calendarDayIn, isoInZone } from './zoned-time.js'

/** What a stopped session knows, for the files of ARCHITECTURE §7.4. */
export interface CaptureInput {
  id: string
  title: string
  templateId: string
  /** The template's section heading lines, e.g. `## Summary`. */
  templateHeadings: string[]
  startedAt: Date
  /** The owner's IANA time zone, sent by their browser at session creation. */
  tz: string
  /** The longest track's audio, in bytes of 16 kHz PCM16. */
  audioBytes: number
  attendees: string[]
  companies: string[]
  calendarEventId?: string | undefined
  calendarSeriesId?: string | undefined
  rawNotes: string
  /** Final segments, in any order. */
  segments: TranscriptSegment[]
}

export interface CapturePaths {
  note: string
  transcript: string
  raw: string
}

/**
 * `meetings/YYYY/MM/YYYY-MM-DD-<slug>.md` and its transcript, dated in the owner's time zone. A
 * `-2`, `-3`… suffix keeps a second meeting with the same title that day from replacing the first.
 */
export function capturePaths(
  input: Pick<CaptureInput, 'id' | 'title' | 'startedAt' | 'tz'>,
  n = 1,
): CapturePaths {
  const base = meetingPaths(calendarDayIn(input.startedAt, input.tz), input.title)
  const suffix = n > 1 ? `-${n}` : ''
  return {
    note: base.note.replace(/\.md$/, `${suffix}.md`),
    transcript: base.transcript.replace(/\.transcript\.md$/, `${suffix}.transcript.md`),
    raw: rawNotesPath(input.id),
  }
}

/** What the member typed during the meeting, kept verbatim. */
export function rawNotesPath(id: string): string {
  return `${SPACE_LAYOUT.meta}/meetings/raw/${id}.md`
}

/** The pointer to a meeting's kept audio (PRD §7); the audio itself is never in Git. */
export function keptAudioPath(id: string): string {
  return `${SPACE_LAYOUT.meta}/meetings/audio/${id}.yaml`
}

/**
 * Where one kept track lives in the audio store. The key is derived from the space the pointer
 * is in, never read from the pointer, so a pointer committed to one space can't reach another
 * space's audio.
 */
export function keptAudioKey(space: string, id: string, track: 'me' | 'them'): string {
  return `meetings/${space}/${id}/${track}.wav`
}

export interface KeptAudio {
  id: string
  /** The note as saved; a later move doesn't update it, the id is what ties them. */
  note: string
  store: 'local' | 'r2'
  tracks: Partial<Record<'me' | 'them', { key: string; bytes: number; seconds: number }>>
}

export function keptAudioPointer(kept: KeptAudio): string {
  return stringify(kept)
}

export const KeptAudioSchema = z.object({
  id: z.string(),
  note: z.string(),
  store: z.enum(['local', 'r2']),
  tracks: z.object({
    me: z.object({ key: z.string(), bytes: z.number(), seconds: z.number() }).optional(),
    them: z.object({ key: z.string(), bytes: z.number(), seconds: z.number() }).optional(),
  }),
})

/** The three files committed on stop. */
export function captureFiles(
  input: CaptureInput,
  paths: CapturePaths,
): Array<{ path: string; content: string }> {
  return [
    { path: paths.note, content: noteText(input, paths) },
    { path: paths.transcript, content: transcriptText(input.title, input.segments) },
    { path: paths.raw, content: input.rawNotes },
  ]
}

/** Frontmatter per PRD §7, then the template's headings with the raw notes under the first. */
export function noteText(input: CaptureInput, paths: CapturePaths): string {
  const frontmatter: Record<string, unknown> = {
    id: input.id,
    type: 'meeting',
    title: input.title,
    date: isoInZone(input.startedAt, input.tz),
    duration_min: Math.round(input.audioBytes / PCM_BYTES_PER_MS / 60_000),
    attendees: input.attendees,
    companies: input.companies,
    template: input.templateId,
    calendar_event_id: input.calendarEventId,
    calendar_series_id: input.calendarSeriesId,
    transcript: paths.transcript.slice(paths.transcript.lastIndexOf('/') + 1),
    ai_ranges: [],
    models: {},
  }
  return patchFrontmatter(
    captureBody(input.title, input.templateHeadings, input.rawNotes),
    frontmatter,
  )
}

/** The note's body before enhancement. */
export function captureBody(title: string, headings: string[], rawNotes: string): string {
  const notes = rawNotes.replace(/\r\n?/g, '\n').trim()
  const parts = [`# ${title}`]
  if (headings.length === 0) {
    if (notes) parts.push(notes)
  } else {
    headings.forEach((heading, i) => {
      parts.push(i === 0 && notes ? `${heading}\n\n${notes}` : heading)
    })
  }
  return `${parts.join('\n\n')}\n`
}

/**
 * `# <title>: transcript`, then one `[hh:mm:ss] **Speaker:** text` line per final segment,
 * without "me" lines that are the other side heard through the speakers (`dropEchoes`).
 */
export function transcriptText(title: string, segments: TranscriptSegment[]): string {
  const lines = dropEchoes(segments.filter((s) => s.final))
    // Stable: segments starting together keep the order they arrived in.
    .sort((a, b) => a.at - b.at)
    .map((s) => formatTranscriptLine({ at: s.at / 1000, speaker: s.speaker, text: s.text }))
  return `# ${title}: transcript\n\n${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`
}

/** "Dana Lee <dana@acme.com>", or the bare address when there's no name. */
export function attendeeLabel(a: { email: string; name?: string | undefined }): string {
  return a.name ? `${a.name} <${a.email}>` : a.email
}

/** The attendees' email domains that aren't ours, in order, once each. */
export function externalDomains(emails: string[], internal: readonly string[]): string[] {
  const ours = new Set(internal.map((d) => d.toLowerCase()))
  const domains: string[] = []
  for (const email of emails) {
    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
    if (domain && !ours.has(domain) && !domains.includes(domain)) domains.push(domain)
  }
  return domains
}
