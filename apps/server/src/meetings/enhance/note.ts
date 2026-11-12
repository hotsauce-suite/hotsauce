import { createHash } from 'node:crypto'
import {
  FrontmatterError,
  MeetingFrontmatter,
  parseFrontmatter,
  parseTranscript,
  patchFrontmatter,
  transcriptPathFor,
} from '@hearth/format'
import type { Principal } from '../../auth/index.js'
import { HearthError } from '../../errors.js'
import { type CommitResult, formatCommitMessage, type GitStore } from '../../git/index.js'
import { type CalendarSource, findEvent } from '../calendar/types.js'
import { rawNotesPath } from '../files.js'
import type { LLMUsage } from '../llm/types.js'
import type { SeriesNote } from '../series.js'
import { DEFAULT_TEMPLATE, type MeetingTemplates, VOICE_NOTE_TEMPLATE } from '../templates.js'
import type { TranscriptSegment } from '../transcriber/types.js'
import { assembleEnhancedNote } from './assemble.js'
import type { Enhancer } from './enhancer.js'

export interface EnhanceNoteDeps {
  git: Pick<GitStore, 'readFile' | 'log' | 'commit'>
  templates: Pick<MeetingTemplates, 'getTemplate'>
  enhancer: Enhancer
  calendar: CalendarSource
  /** Earlier notes of the same recurring meeting, newest first (§7.8); none when absent. */
  previousInSeries?: (
    principal: Principal,
    note: { seriesId: string; date: string; space: string; path: string; eventId?: string },
  ) => Promise<SeriesNote[]>
  /** Index and announce the commit, or record the conflict branch (api/save.ts afterCommit). */
  afterCommit: (space: string, path: string, result: CommitResult) => Promise<void>
  /** Waits for the meeting's after-call transcript cleanup, if one is running (§7.11). */
  transcriptSettled?: (meetingId: string) => Promise<void>
  log?: (message: string) => void
}

export interface EnhanceResult {
  path: string
  aiRanges: Array<[number, number]>
  usage: LLMUsage
}

const CAPTURE_PREFIX = 'meetings: capture '

/**
 * `POST /api/meetings/enhance`: rewrites a meeting note's body from its raw notes, transcript
 * and template, sets `ai_ranges`, `template` and `models` in its frontmatter, and commits
 * `meetings: enhance "<title>"` as the member. Refuses (conflict) when someone edited the note
 * since Hearth last wrote it, unless `force`.
 */
export async function enhanceNote(
  deps: EnhanceNoteDeps,
  principal: Principal,
  args: { space: string; path: string; template?: string | undefined; force?: boolean | undefined },
): Promise<EnhanceResult> {
  const { git } = deps
  const { space, path } = args
  const note = await git.readFile(space, path)
  const parsed = parseFrontmatter(note.content)
  const meeting = MeetingFrontmatter.safeParse(parsed.data)
  if (!meeting.success) throw new HearthError('bad_request', `${path} is not a meeting note`)
  const fm = meeting.data
  if (!args.force) await assertUnedited(git, space, path, parsed.body, fm.models)
  // Enhance right after Stop reads the cleaned-up transcript, not the live one it replaces.
  await deps.transcriptSettled?.(fm.id)

  const transcriptPath = transcriptPathFor(path, fm)
  const [rawNotes, transcript, template] = await Promise.all([
    readOrNull(git, space, rawNotesPath(fm.id)),
    transcriptPath ? readOrNull(git, space, transcriptPath) : Promise.resolve(null),
    deps.templates.getTemplate(principal, args.template ?? fm.template ?? DEFAULT_TEMPLATE),
  ])
  if (transcript === null) {
    throw new HearthError('bad_request', `The transcript of this meeting isn't in ${space}`)
  }
  const calendar = fm.calendar_event_id
    ? await calendarContext(deps, principal, fm.calendar_event_id, fm.date)
    : undefined
  const previous =
    fm.calendar_series_id && deps.previousInSeries
      ? await deps.previousInSeries(principal, {
          seriesId: fm.calendar_series_id,
          date: fm.date,
          space,
          path,
          ...(fm.calendar_event_id ? { eventId: fm.calendar_event_id } : {}),
        })
      : []

  const nameIt = template.id === VOICE_NOTE_TEMPLATE && hasPlaceholderTitle(fm.title)
  const {
    markdown,
    usage,
    title: newTitle,
    speakerGuesses,
  } = await deps.enhancer.enhance({
    title: fm.title,
    ...(nameIt ? { nameIt: true } : {}),
    template,
    rawNotes: rawNotes ?? '',
    transcript: segmentsOf(transcript),
    attendees: fm.attendees ?? [],
    noteTaker: await noteTakerOf(git, space, path, principal.name),
    ...(fm.date ? { date: fm.date } : {}),
    ...(calendar ? { calendar } : {}),
    ...(previous.length > 0 ? { previousMeetings: previous } : {}),
  })
  const frontmatterText = note.content.slice(0, note.content.length - parsed.body.length)
  const assembled = assembleEnhancedNote({
    frontmatterText,
    rawNotes: rawNotes ?? '',
    modelMarkdown: markdown,
  })
  const body = assembled.text.slice(frontmatterText.length)
  let content: string
  try {
    content = patchFrontmatter(assembled.text, {
      ...(newTitle ? { title: newTitle } : {}),
      // Fresh guesses replace old ones; none at all clears them.
      speaker_guesses: speakerGuesses,
      template: template.id,
      ai_ranges: assembled.aiRanges,
      models: { ...fm.models, enhance: deps.enhancer.model, enhanced_blob: blobOidOf(body) },
    })
  } catch (err) {
    if (err instanceof FrontmatterError) throw new HearthError('bad_request', err.message)
    throw err
  }

  // The model call takes seconds; don't commit over an edit saved meanwhile.
  if ((await git.readFile(space, path)).blobOid !== note.blobOid) {
    throw new HearthError('conflict', 'The note changed while it was being enhanced; try again')
  }
  const result = await git.commit(space, {
    changes: [{ path, content }],
    author: { name: principal.name, email: principal.email },
    message: formatCommitMessage({
      app: 'meetings',
      verb: 'enhance',
      title: newTitle ?? fm.title,
    }),
    base: { path, blobOid: note.blobOid },
  })
  await deps.afterCommit(space, path, result)
  if (result.status === 'conflict') {
    throw new HearthError('conflict', 'The note changed while it was being enhanced; try again')
  }
  return { path, aiRanges: assembled.aiRanges, usage }
}

/**
 * The title a voice note gets when it starts ("10:12 PM Voice note", in any clock format):
 * Enhance names such a note from what was said. A title the member typed is theirs.
 */
export function hasPlaceholderTitle(title: string): boolean {
  return /^[\d:.\s]+(?:[AaPp]\.?\s?[Mm]\.?)?\s*Voice note$/.test(title.trim())
}

/**
 * Hearth records the git blob oid of the body it wrote in `models.enhanced_blob` (the note's own
 * blob can't be stored inside itself). A note never enhanced must still be exactly as captured:
 * its latest commit is the capture.
 */
async function assertUnedited(
  git: EnhanceNoteDeps['git'],
  space: string,
  path: string,
  body: string,
  models: Record<string, string> | undefined,
): Promise<void> {
  const enhanced = models?.enhanced_blob
  const edited = enhanced
    ? blobOidOf(body) !== enhanced
    : !(await git.log(space, { path, limit: 1 }))[0]?.message.startsWith(CAPTURE_PREFIX)
  if (edited) {
    throw new HearthError(
      'conflict',
      'This note was edited since it was last enhanced; enhancing again would replace those edits',
    )
  }
}

/**
 * Who took the notes: the author of the note's capture commit (a shared note can be enhanced by
 * someone else), else the member enhancing it.
 */
async function noteTakerOf(
  git: Pick<GitStore, 'log'>,
  space: string,
  path: string,
  fallback: string,
): Promise<string> {
  const capture = (await git.log(space, { path })).findLast((c) =>
    c.message.startsWith(CAPTURE_PREFIX),
  )
  return capture?.author.name || fallback
}

/** `git hash-object` of the text: SHA-1 over `blob <bytes>\0<content>`. */
export function blobOidOf(text: string): string {
  const content = Buffer.from(text, 'utf8')
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]))
    .digest('hex')
}

function segmentsOf(transcriptText: string): TranscriptSegment[] {
  return parseTranscript(transcriptText).map((line) => ({
    track: line.speaker === 'Me' ? 'me' : 'them',
    speaker: line.speaker,
    at: line.at * 1000,
    durationMs: 0,
    text: line.text,
    final: true,
  }))
}

async function calendarContext(
  deps: EnhanceNoteDeps,
  principal: Principal,
  eventId: string,
  date: string,
): Promise<{ title: string; description?: string } | undefined> {
  const at = new Date(date)
  if (Number.isNaN(at.getTime())) return undefined
  try {
    const event = await findEvent(deps.calendar, principal, eventId, at)
    if (!event) return undefined
    return event.description
      ? { title: event.title, description: event.description }
      : { title: event.title }
  } catch (err) {
    // The notes are worth more than the event description.
    ;(deps.log ?? console.warn)(`calendar event ${eventId} for ${principal.email}: ${err}`)
    return undefined
  }
}

async function readOrNull(
  git: EnhanceNoteDeps['git'],
  space: string,
  path: string,
): Promise<string | null> {
  try {
    return (await git.readFile(space, path)).content
  } catch (err) {
    if (err instanceof HearthError && err.code === 'not_found') return null
    throw err
  }
}
