import { fixTranscriptWords, parseTranscript } from '@hearth/format'
import { HearthError } from '../../errors.js'
import { formatCommitMessage, type GitStore } from '../../git/index.js'
import { transcriptText } from '../files.js'
import type { LLM } from '../llm/types.js'
import { TRACKS, type Track, type TranscriptSegment } from '../transcriber/types.js'
import type { MeetingRetranscriber } from './retranscriber.js'
import { spellingFixes } from './spelling.js'

/** How long Enhance waits for a meeting's cleanup before going ahead without it. */
export const CLEANUP_WAIT_MS = 120_000
/**
 * A re-transcription with fewer words than this share of the live transcript's is taken as a
 * failure (a truncated upload, a silent track) and the live transcript stays.
 */
const MIN_WORD_SHARE = 0.5

export interface CleanupJob {
  /** The meeting's id. */
  id: string
  space: string
  title: string
  transcriptPath: string
  author: { name: string; email: string }
  /** Attendees' names and the word lists the meeting was transcribed with. */
  vocabulary: string[]
  /** The kept audio's PCM per track, still on disk: re-transcribe it. Absent: spelling pass. */
  audio?: Partial<Record<Track, { file: string; bytes: number }>>
}

export interface TranscriptCleanupOptions {
  git: Pick<GitStore, 'readFile' | 'commit'>
  afterCommit: (space: string) => Promise<void>
  /** Null: kept audio isn't re-transcribed (fake ASR), and gets the spelling pass instead. */
  retranscriber: MeetingRetranscriber | null
  /** Null: no spelling pass. */
  llm: LLM | null
  model: string
  log?: (message: string) => void
}

export type CleanupOutcome = 'retranscribed' | 'spelling' | 'unchanged' | 'skipped'

interface Job {
  done: Promise<CleanupOutcome>
  abort: AbortController
  /** Past its last abort check and committing: an abort can no longer stop it, so wait. */
  committing: boolean
}

/**
 * After-call transcript cleanup (ARCHITECTURE §7.11). Once a meeting is saved, its transcript is
 * transcribed again from the kept audio in one pass, or, without kept audio, Claude fixes names
 * and terms from the word list. The result is one commit as the owner, made only if the
 * transcript is still exactly what was saved; Git keeps the live version. Best effort: any
 * failure leaves the live transcript, and Enhance waits for a running cleanup (`settled`).
 */
export class TranscriptCleanup {
  readonly #opts: TranscriptCleanupOptions
  readonly #log: (message: string) => void
  readonly #jobs = new Map<string, Job>()

  constructor(opts: TranscriptCleanupOptions) {
    this.#opts = opts
    this.#log = opts.log ?? console.error
  }

  /** Starts cleaning one meeting's transcript; the promise never rejects. */
  start(job: CleanupJob): Promise<CleanupOutcome> {
    const abort = new AbortController()
    const state: Job = { done: Promise.resolve('skipped'), abort, committing: false }
    const done = this.#run(job, state)
      .catch((err: unknown) => {
        this.#log(`meeting ${job.id}: transcript cleanup failed, the live one stays: ${err}`)
        return 'skipped' as const
      })
      .finally(() => {
        if (this.#jobs.get(job.id)?.done === done) this.#jobs.delete(job.id)
      })
    state.done = done
    this.#jobs.set(job.id, state)
    return done
  }

  /** Whether a cleanup of this meeting is under way. */
  running(id: string): boolean {
    return this.#jobs.has(id)
  }

  /**
   * Waits for this meeting's cleanup, if one is running, at most `timeoutMs`; past that it is
   * stopped, so it can't change the transcript under a note enhanced without it.
   */
  async settled(id: string, timeoutMs = CLEANUP_WAIT_MS): Promise<void> {
    const job = this.#jobs.get(id)
    if (!job) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = await Promise.race([
      job.done.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs)
      }),
    ])
    clearTimeout(timer)
    if (!late) return
    if (job.committing) {
      // Its commit is under way and can't be called back: wait for it, so Enhance reads it.
      await job.done
      return
    }
    this.#log(`meeting ${id}: transcript cleanup took too long; Enhance goes ahead without it`)
    job.abort.abort()
  }

  /** Stops one meeting's cleanup (it was deleted) unless it is already committing. */
  abort(id: string): void {
    this.#jobs.get(id)?.abort.abort()
  }

  /** Every cleanup started so far has finished (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.#jobs.size > 0)
      await Promise.allSettled([...this.#jobs.values()].map((j) => j.done))
  }

  /** Stops every running cleanup (shutdown); the live transcripts stay. */
  abortAll(): void {
    for (const job of this.#jobs.values()) job.abort.abort()
  }

  async #run(job: CleanupJob, state: Job): Promise<CleanupOutcome> {
    const signal = state.abort.signal
    const { git } = this.#opts
    const saved = await git.readFile(job.space, job.transcriptPath)
    let next: string | null = null
    let outcome: CleanupOutcome = 'unchanged'
    if (job.audio && this.#opts.retranscriber) {
      next = await this.#retranscribe(job, saved.content, signal)
      if (next !== null) outcome = 'retranscribed'
    }
    if (signal.aborted) return 'skipped'
    if (next === null && this.#opts.llm) {
      const fixes = await spellingFixes(
        this.#opts.llm,
        this.#opts.model,
        saved.content,
        job.vocabulary,
      )
      if (fixes.length > 0) {
        next = fixTranscriptWords(saved.content, fixes)
        outcome = 'spelling'
      }
    }
    if (signal.aborted) return 'skipped'
    if (next === null || next === saved.content) return 'unchanged'
    // Synchronously after the last check: from here `settled` waits instead of aborting.
    state.committing = true
    try {
      await git.commit(job.space, {
        changes: [{ path: job.transcriptPath, content: next }],
        author: job.author,
        message: formatCommitMessage({
          app: 'meetings',
          verb: 'clean up transcript of',
          title: job.title,
        }),
        // Renamed speakers, an edit or a delete since the save win: the cleanup is dropped.
        unchanged: { path: job.transcriptPath, blobOid: saved.blobOid },
      })
    } catch (err) {
      if (err instanceof HearthError && err.code === 'conflict') {
        this.#log(`meeting ${job.id}: the transcript changed since it was saved; cleanup dropped`)
        return 'skipped'
      }
      throw err
    }
    try {
      await this.#opts.afterCommit(job.space)
    } catch (err) {
      // Committed; the poller will index it.
      this.#log(`meeting ${job.id}: indexing after transcript cleanup failed: ${err}`)
    }
    return outcome
  }

  /** The whole transcript again from the kept audio, or null to keep the live one. */
  async #retranscribe(job: CleanupJob, live: string, signal: AbortSignal): Promise<string | null> {
    const retranscriber = this.#opts.retranscriber
    const audio = job.audio
    if (!retranscriber || !audio) return null
    const tracks = TRACKS.flatMap((track) => {
      const a = audio[track]
      return a && a.bytes > 0 ? [{ track, ...a }] : []
    })
    if (tracks.length === 0) return null
    const liveLines = parseTranscript(live)
    let segments: TranscriptSegment[]
    try {
      const results = await Promise.all(
        tracks.map((t) =>
          retranscriber.transcribe({
            track: t.track,
            file: t.file,
            bytes: t.bytes,
            vocabulary: job.vocabulary,
            signal,
          }),
        ),
      )
      // Each side on its own: a track Deepgram heard little of keeps the whole live transcript,
      // rather than silently losing that side.
      for (const [i, t] of tracks.entries()) {
        const heard = words((results[i] ?? []).map((s) => s.text))
        const before = words(
          liveLines.filter((l) => onTrack(l.speaker, t.track)).map((l) => l.text),
        )
        if (before > 0 && heard < before * MIN_WORD_SHARE) {
          this.#log(
            `meeting ${job.id}: the re-transcription heard much less on ${t.track}; kept live`,
          )
          return null
        }
      }
      segments = results.flat()
    } catch (err) {
      if (signal.aborted) return null
      const why = err instanceof HearthError ? err.message : String(err)
      this.#log(
        `meeting ${job.id}: re-transcribing kept audio failed (${why}); spelling pass instead`,
      )
      return null
    }
    const text = transcriptText(job.title, segments)
    return parseTranscript(text).length > 0 ? text : null
  }
}

function words(texts: string[]): number {
  return texts.reduce((n, t) => n + t.split(/\s+/).filter(Boolean).length, 0)
}

/** Whether a live transcript line came from this track: "Me" is the mic, every other label the call. */
function onTrack(speaker: string, track: Track): boolean {
  return (speaker === 'Me') === (track === 'me')
}
