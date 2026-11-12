import { MeetingFrontmatter, parseFrontmatter, transcriptPathFor } from '@hearth/format'
import { parse as parseYaml } from 'yaml'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import {
  type Change,
  type CommitResult,
  formatCommitMessage,
  type GitStore,
  withVia,
} from '../git/index.js'
import type { AudioStore } from './audio/index.js'
import { KeptAudioSchema, keptAudioKey, keptAudioPath, rawNotesPath } from './files.js'
import type { MeetingSessions } from './sessions.js'

export interface DeleteMeetingDeps {
  git: Pick<GitStore, 'readFile' | 'commit'>
  /** Where kept audio lives; null when this server keeps none. */
  audioStore: AudioStore | null
  /** Serializes the delete with a kept-audio upload still under way for the same meeting. */
  sessions: Pick<MeetingSessions, 'deleting'>
  /** Refuses a path Hearth must never change (`.hearth/space.yaml`); returns it normalized. */
  writablePath: (path: string) => string
  afterCommit: (space: string, path: string, result: CommitResult) => Promise<void>
  log?: (message: string) => void
}

/** Meeting ids are ULIDs; anything else didn't come from Hearth and names no files of ours. */
const MEETING_ID = /^[0-9A-Z]{26}$/

/**
 * `POST /api/meetings/delete`: removes a meeting note and everything Hearth saved with it (the
 * transcript, the raw notes, the kept-audio pointer) in one commit, `meetings: delete "<title>"`,
 * then the kept audio itself. Git history still has the files; the audio is gone for good.
 * `blobOid`, when given, is the note as the member saw it: a note changed since is refused.
 */
export async function deleteMeeting(
  deps: DeleteMeetingDeps,
  principal: Principal,
  args: { space: string; path: string; blobOid?: string | undefined; via?: string | undefined },
): Promise<{ deleted: string[] }> {
  const { git } = deps
  const { space } = args
  const path = deps.writablePath(args.path)
  const note = await git.readFile(space, path)
  const meeting = MeetingFrontmatter.safeParse(parseFrontmatter(note.content).data)
  if (!meeting.success || !MEETING_ID.test(meeting.data.id)) {
    throw new HearthError('bad_request', `${path} is not a meeting note`)
  }
  const fm = meeting.data
  if (args.blobOid && args.blobOid !== note.blobOid) {
    throw new HearthError('conflict', 'This note changed since you opened it; reload and try again')
  }

  // The transcript is named in the note's frontmatter, which anyone can edit: only a transcript
  // file beside it is ever deleted, never another note or Hearth's own files.
  const named = transcriptPathFor(path, fm)
  const transcript = named?.endsWith('.transcript.md') ? deps.writablePath(named) : null
  const rawPath = rawNotesPath(fm.id)
  const pointerPath = keptAudioPath(fm.id)
  const title = fm.title.replace(/\s+/g, ' ').trim()

  return deps.sessions.deleting(space, fm.id, async () => {
    const [transcriptText, rawText, pointerText] = await Promise.all([
      transcript ? readOrNull(git, space, transcript) : Promise.resolve(null),
      readOrNull(git, space, rawPath),
      readOrNull(git, space, pointerPath),
    ])
    const changes: Change[] = [{ path, content: null }]
    if (transcript && transcriptText !== null && !isMeetingNote(transcriptText)) {
      changes.push({ path: transcript, content: null })
    }
    if (rawText !== null) changes.push({ path: rawPath, content: null })
    // Only audio a pointer Hearth wrote for this very meeting names is deleted; a pointer to
    // audio this server can't reach stays, so the audio isn't left with no trace.
    const audioKeys: string[] = []
    if (pointerText !== null) {
      const pointer = KeptAudioSchema.safeParse(safeYaml(pointerText))
      const reachable = pointer.success && deps.audioStore?.kind === pointer.data.store
      if (!pointer.success || pointer.data.id !== fm.id || reachable) {
        changes.push({ path: pointerPath, content: null })
      }
      if (pointer.success && pointer.data.id === fm.id && reachable) {
        for (const track of ['me', 'them'] as const) {
          const key = pointer.data.tracks[track]?.key
          if (key && key === keptAudioKey(space, fm.id, track)) audioKeys.push(key)
        }
      }
    }

    const result = await git.commit(space, {
      changes,
      author: { name: principal.name, email: principal.email },
      message: withVia(formatCommitMessage({ app: 'meetings', verb: 'delete', title }), args.via),
      // A deletion isn't merged: the note must still be exactly what was read above.
      unchanged: { path, blobOid: note.blobOid },
    })
    await deps.afterCommit(space, path, result)
    if (result.status === 'conflict') {
      throw new HearthError('conflict', 'The note changed while it was being deleted; try again')
    }

    const store = deps.audioStore
    if (store) {
      for (const key of audioKeys) {
        // The note is already gone; leftover audio is only storage, so a failure is logged.
        await store.delete(key).catch((err: unknown) => {
          ;(deps.log ?? console.warn)(`couldn't delete kept audio ${key}: ${err}`)
        })
      }
    }
    return { deleted: changes.map((c) => c.path) }
  })
}

function isMeetingNote(text: string): boolean {
  try {
    return parseFrontmatter(text).data.type === 'meeting'
  } catch {
    return false
  }
}

function safeYaml(text: string): unknown {
  try {
    return parseYaml(text)
  } catch {
    return null
  }
}

async function readOrNull(
  git: Pick<GitStore, 'readFile'>,
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
