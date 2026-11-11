import { createWriteStream, type WriteStream } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { KeyedMutex } from '../git/mutex.js'
import { TRACKS, type Track, type TranscriptSegment } from './transcriber/types.js'

export type SessionState = 'recording' | 'paused' | 'stopped' | 'saved'

export interface SavedMeeting {
  space: string
  path: string
  transcriptPath: string
}

const SessionMeta = z.object({
  id: z.string(),
  owner: z.string(),
  ownerName: z.string(),
  space: z.string(),
  title: z.string(),
  template: z.string(),
  templateHeadings: z.array(z.string()),
  calendarEventId: z.string().optional(),
  /** The recurring series the calendar event belongs to (`calendar_series_id`, §7.8). */
  calendarSeriesId: z.string().optional(),
  /** The Google Meet call it records ("abc-defg-hij"), so a resumed capture finds that tab. */
  meetCode: z.string().optional(),
  startedAt: z.string(),
  tz: z.string(),
  state: z.enum(['recording', 'paused', 'stopped', 'saved']),
  rawNotes: z.string(),
  attendees: z.array(z.string()),
  companies: z.array(z.string()),
  saved: z.object({ space: z.string(), path: z.string(), transcriptPath: z.string() }).optional(),
  /** The member's Keep audio choice, set while recording; unset means the server's default. */
  keepAudio: z.boolean().optional(),
  /** Saved with Keep audio, and the upload hasn't finished: the PCM is still on disk. */
  audioPending: z.boolean().optional(),
})
export type SessionMeta = z.infer<typeof SessionMeta>

const Segment = z.object({
  track: z.enum(['me', 'them']),
  speaker: z.string(),
  at: z.number(),
  durationMs: z.number(),
  text: z.string(),
  final: z.boolean(),
})

export interface RecoveredSession {
  meta: SessionMeta
  bytes: Record<Track, number>
  segments: TranscriptSegment[]
  /** When its files were last written (ms since the epoch): about when it was last in use. */
  lastActive: number
}

/**
 * A session on disk, so a server restart mid-meeting loses nothing:
 * `DATA_DIR/sessions/<id>/{meta.json, me.pcm, them.pcm, segments.jsonl}`. The audio files are
 * the truth for how much audio arrived; meta.json is replaced atomically on every change.
 */
export class SessionStore {
  readonly #root: string
  readonly #writes = new KeyedMutex()

  constructor(dataDir: string) {
    this.#root = path.join(dataDir, 'sessions')
  }

  dir(id: string): string {
    return path.join(this.#root, id)
  }

  async create(meta: SessionMeta): Promise<void> {
    await mkdir(this.dir(meta.id), { recursive: true })
    await this.writeMeta(meta)
  }

  /** Writes are serialized per session, so an older version never lands last. */
  writeMeta(meta: SessionMeta): Promise<void> {
    const snapshot = JSON.stringify(meta)
    return this.#writes.run(meta.id, async () => {
      const file = path.join(this.dir(meta.id), 'meta.json')
      await writeFile(`${file}.tmp`, snapshot)
      await rename(`${file}.tmp`, file)
    })
  }

  /** An append stream for one track's PCM; the caller ends it. */
  openAudio(id: string, track: Track): WriteStream {
    return createWriteStream(this.#audioFile(id, track), { flags: 'a' })
  }

  appendSegment(id: string, segment: TranscriptSegment): Promise<void> {
    return appendFile(path.join(this.dir(id), 'segments.jsonl'), `${JSON.stringify(segment)}\n`)
  }

  /** After a save: the audio goes unless kept, and the segments are in Git now. */
  async cleanUp(id: string, opts: { keepAudio: boolean }): Promise<void> {
    await rm(path.join(this.dir(id), 'segments.jsonl'), { force: true })
    if (opts.keepAudio) return
    for (const track of TRACKS) await rm(this.#audioFile(id, track), { force: true })
  }

  /**
   * Every session that wasn't saved, for recovery at startup. Saved sessions are left on disk
   * (only meta.json, plus kept audio) but not loaded.
   */
  async loadUnsaved(log: (message: string) => void): Promise<RecoveredSession[]> {
    let ids: string[]
    try {
      ids = await readdir(this.#root)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const sessions: RecoveredSession[] = []
    for (const id of ids.sort()) {
      try {
        const meta = SessionMeta.parse(
          JSON.parse(await readFile(path.join(this.dir(id), 'meta.json'), 'utf8')),
        )
        if (meta.state === 'saved') continue
        sessions.push({
          meta,
          bytes: await this.#audioBytes(id),
          segments: await this.#segments(id),
          lastActive: await this.#lastWritten(id),
        })
      } catch (err) {
        log(`meeting session ${id} could not be recovered: ${err}`)
      }
    }
    return sessions
  }

  /** Saved sessions whose kept audio is still waiting to upload, for a retry at startup. */
  async loadPendingAudio(log: (message: string) => void): Promise<SessionMeta[]> {
    let ids: string[]
    try {
      ids = await readdir(this.#root)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const pending: SessionMeta[] = []
    for (const id of ids.sort()) {
      try {
        const meta = SessionMeta.parse(
          JSON.parse(await readFile(path.join(this.dir(id), 'meta.json'), 'utf8')),
        )
        if (meta.state === 'saved' && meta.audioPending) pending.push(meta)
      } catch (err) {
        log(`meeting session ${id}: unreadable while looking for audio to keep: ${err}`)
      }
    }
    return pending
  }

  /** The track's PCM file, whether or not it exists yet. */
  audioPath(id: string, track: Track): string {
    return this.#audioFile(id, track)
  }

  #audioFile(id: string, track: Track): string {
    return path.join(this.dir(id), `${track}.pcm`)
  }

  async #audioBytes(id: string): Promise<Record<Track, number>> {
    const bytes: Record<Track, number> = { me: 0, them: 0 }
    for (const track of TRACKS) {
      try {
        bytes[track] = (await stat(this.#audioFile(id, track))).size
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }
    return bytes
  }

  /** The newest modification time among the session's files: audio, segments, notes, state. */
  async #lastWritten(id: string): Promise<number> {
    let latest = 0
    for (const name of await readdir(this.dir(id))) {
      latest = Math.max(latest, (await stat(path.join(this.dir(id), name))).mtimeMs)
    }
    return latest
  }

  async #segments(id: string): Promise<TranscriptSegment[]> {
    let text: string
    try {
      text = await readFile(path.join(this.dir(id), 'segments.jsonl'), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const segments: TranscriptSegment[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      // A crash can cut the last line short.
      const parsed = Segment.safeParse(safeJson(line))
      if (parsed.success) segments.push(parsed.data)
    }
    return segments
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
