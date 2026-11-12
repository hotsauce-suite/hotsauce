import {
  cleanSpeakerName,
  FrontmatterError,
  MeetingFrontmatter,
  parseFrontmatter,
  parseTranscript,
  patchFrontmatter,
  renameSpeakers,
  transcriptPathFor,
} from '@hearth/format'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import { type CommitResult, formatCommitMessage, type GitStore } from '../git/index.js'
import { blobOidOf } from './enhance/note.js'

export interface NameSpeakersDeps {
  git: Pick<GitStore, 'readFile' | 'commit'>
  afterCommit: (space: string, path: string, result: CommitResult) => Promise<void>
  /** Whether the meeting's transcript is being cleaned up after the call (§7.11). */
  transcriptBusy?: (meetingId: string) => boolean
}

/**
 * `POST /api/meetings/speakers`: gives speaker labels names ("Speaker 1" → "Priya Shah") in the
 * meeting's transcript and on the note's AI lines, in one commit as the member. The member's own
 * lines are never touched, "Me" can't be renamed, and a label not in the transcript is refused.
 * Each renamed label leaves `speaker_guesses`. A note Hearth last wrote stays "unedited" for the
 * next Enhance (its `models.enhanced_blob` follows the new body).
 */
export async function nameSpeakers(
  deps: NameSpeakersDeps,
  principal: Principal,
  args: {
    space: string
    path: string
    names: Record<string, string>
    /** The transcript the member looked at; a different one is refused (labels may differ). */
    transcriptBlobOid?: string | undefined
  },
): Promise<{ transcriptPath: string; renamed: Record<string, string> }> {
  const { git } = deps
  const { space, path } = args
  const note = await git.readFile(space, path)
  const parsed = parseFrontmatter(note.content)
  const meeting = MeetingFrontmatter.safeParse(parsed.data)
  if (!meeting.success) throw new HearthError('bad_request', `${path} is not a meeting note`)
  const fm = meeting.data
  const transcriptPath = transcriptPathFor(path, fm)
  // Like delete: only a transcript beside the note, never a Hearth file.
  if (
    !transcriptPath?.endsWith('.transcript.md') ||
    transcriptPath.split('/').includes('.hearth')
  ) {
    throw new HearthError('bad_request', 'This meeting has no transcript')
  }
  if (deps.transcriptBusy?.(fm.id)) {
    throw new HearthError('conflict', 'The transcript is being cleaned up; try again in a moment')
  }
  const transcript = await git.readFile(space, transcriptPath)
  if (args.transcriptBlobOid !== undefined && args.transcriptBlobOid !== transcript.blobOid) {
    throw new HearthError('conflict', 'The transcript changed since you looked; try again')
  }
  const labels = new Set(parseTranscript(transcript.content).map((l) => l.speaker))

  const renamed: Record<string, string> = Object.create(null)
  for (const [from, raw] of Object.entries(args.names)) {
    if (from === 'Me') throw new HearthError('bad_request', '“Me” is always the note-taker')
    if (!labels.has(from)) {
      throw new HearthError('bad_request', `No one is called “${from}” in this transcript`)
    }
    const to = cleanSpeakerName(raw)
    if (to === null) throw new HearthError('bad_request', `“${raw}” can’t be a speaker’s name`)
    if (to !== from) renamed[from] = to
  }
  if (Object.keys(renamed).length === 0) return { transcriptPath, renamed: { ...renamed } }

  // `ai_ranges` drift once the member edits the note, so Claude's lines are only known in a note
  // as Hearth last wrote it; an edited note keeps its text and only the transcript is renamed.
  const wasUnedited = fm.models?.enhanced_blob === blobOidOf(parsed.body)
  const body = wasUnedited ? renameInAiLines(parsed.body, fm.ai_ranges ?? [], renamed) : parsed.body
  const guesses = Object.fromEntries(
    Object.entries(fm.speaker_guesses ?? {}).filter(([label]) => !Object.hasOwn(renamed, label)),
  )
  const frontmatterText = note.content.slice(0, note.content.length - parsed.body.length)
  let content: string
  try {
    content = patchFrontmatter(`${frontmatterText}${body}`, {
      speaker_guesses: Object.keys(guesses).length > 0 ? guesses : undefined,
      ...(wasUnedited && fm.models
        ? { models: { ...fm.models, enhanced_blob: blobOidOf(body) } }
        : {}),
    })
  } catch (err) {
    if (err instanceof FrontmatterError) throw new HearthError('bad_request', err.message)
    throw err
  }

  // Both files are written whole from what was read: refuse rather than merge over a change
  // made meanwhile (another rename in a second tab, an edit to the transcript).
  const [noteNow, transcriptNow] = await Promise.all([
    git.readFile(space, path),
    git.readFile(space, transcriptPath),
  ])
  if (noteNow.blobOid !== note.blobOid || transcriptNow.blobOid !== transcript.blobOid) {
    throw new HearthError('conflict', 'The meeting changed meanwhile; try again')
  }
  const result = await git.commit(space, {
    changes: [
      { path, content },
      { path: transcriptPath, content: renameSpeakers(transcript.content, renamed) },
    ],
    author: { name: principal.name, email: principal.email },
    message: formatCommitMessage({ app: 'meetings', verb: 'name speakers in', title: fm.title }),
    base: { path, blobOid: note.blobOid },
  })
  await deps.afterCommit(space, path, result)
  if (result.status === 'conflict') {
    throw new HearthError('conflict', 'The note changed meanwhile; try again')
  }
  return { transcriptPath, renamed: { ...renamed } }
}

/**
 * The note body with each label replaced, as a whole word, on the lines `aiRanges` marks as
 * written by Claude (1-based, inclusive, counted in the body). Other lines keep every byte.
 */
export function renameInAiLines(
  body: string,
  aiRanges: Array<[number, number]>,
  names: Record<string, string>,
): string {
  const labels = Object.keys(names)
  if (labels.length === 0 || aiRanges.length === 0) return body
  const isAi = (n: number) => aiRanges.some(([a, b]) => n >= a && n <= b)
  // One pass over all labels, so a swap ("Speaker 1" ⇄ "Speaker 2") or a chain can't rename twice.
  const pattern = new RegExp(
    `(?<![\\w])(?:${labels
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|')})(?![\\w])`,
    'g',
  )
  const parts = body.split(/(\r?\n)/)
  let line = 0
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part
      line++
      if (!isAi(line)) return part
      return part.replace(
        pattern,
        (label) => (Object.hasOwn(names, label) ? names[label] : label) ?? label,
      )
    })
    .join('')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
