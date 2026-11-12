import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, statfs } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ulid } from 'ulid'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import { type AudioStore, LocalAudioStore, R2AudioStore } from '../meetings/audio/index.js'
import type { LLM } from '../meetings/llm/types.js'
import { extractAudio, type FfmpegPaths, probe, remux, thumbnail } from './media.js'
import type { ClipContainer, ClipMode, ClipRecord, ClipStore, TranscriptSegment } from './store.js'
import type { ClipTranscriber } from './transcriber.js'

/** A chunk is a few seconds of video; the API's body limit (12 MB) is the real cap. */
export const MAX_CHUNKS = 3600
export const MAX_CLIP_BYTES = 2 * 1024 ** 3
export const MAX_TITLE_LENGTH = 200
/** A recording nobody finished in this long was abandoned (tab closed); its chunks are removed. */
const ABANDONED_MS = 24 * 3_600_000
/** Recordings a member can have open at once (each may hold up to 2 GB of chunks on the volume). */
export const MAX_OPEN_RECORDINGS = 3
/**
 * Free space the data volume keeps for git, SQLite and settings: recording stops below it.
 * Chunks always land on the volume, and so do videos without R2.
 */
export const MIN_FREE_BYTES = 1024 ** 3
/** Playback URLs are signed for a fixed window and valid for two (so they're cacheable). */
const URL_WINDOW_SECONDS = 3 * 3600
const CONTENT_TYPE: Record<ClipContainer, string> = { mp4: 'video/mp4', webm: 'video/webm' }
const SUMMARY_TRANSCRIPT_CHARS = 12_000

export type MediaFile = 'video' | 'thumb'

/** What the API returns for a clip. URLs are null until the clip is ready. */
export interface ClipView {
  id: string
  title: string
  summary: string | null
  mode: ClipMode
  status: ClipRecord['status']
  error: string | null
  durationMs: number | null
  sizeBytes: number | null
  width: number | null
  height: number | null
  mimeType: string
  owner: { name: string; email: string }
  isOwner: boolean
  createdAt: string
  updatedAt: string
  transcriptStatus: ClipRecord['transcriptStatus']
  transcriptError: string | null
  videoUrl: string | null
  thumbUrl: string | null
  downloadUrl: string | null
}

export interface ClipsOptions {
  store: ClipStore
  /** Where videos and thumbnails go; null means Clips isn't available on this server. */
  media: AudioStore | null
  dataDir: string
  transcriber: ClipTranscriber
  llm: LLM
  model: string
  /** The words to bias the owner's transcript toward. */
  keyterms: (userId: string) => string[]
  ffmpeg: FfmpegPaths
  log?: (message: string) => void
  now?: () => Date
  /** Free bytes on the data volume (tests stand in for statfs). */
  freeBytes?: () => Promise<number>
}

/** A file name for a download: the title without characters file systems refuse. */
function fileName(title: string, container: ClipContainer): string {
  const base =
    title
      .replace(/[\\/:*?"<>|]+/g, ' ')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
      .replace(/[\u0000-\u001f]+/g, ' ')
      .trim()
      .slice(0, 120) || 'clip'
  return `${base}.${container}`
}

function tagged(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)
  return match?.[1]?.trim() || null
}

/** `[m:ss] text` lines, the shape the summary prompt reads. */
function transcriptText(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => {
      const m = Math.floor(s.start / 60)
      const sec = Math.floor(s.start % 60)
      return `[${m}:${String(sec).padStart(2, '0')}] ${s.text}`
    })
    .join('\n')
}

/**
 * Hearth Clips on the server (ARCHITECTURE §10): recordings arrive as numbered chunks while they're
 * made; Stop assembles them into a seekable video, stores it with a thumbnail, then transcribes.
 * One clip is processed at a time, in arrival order.
 */
export class Clips {
  readonly store: ClipStore
  readonly #opts: ClipsOptions
  readonly #log: (message: string) => void
  readonly #now: () => Date
  /** Signs locally served media URLs. Per process: a restart only expires open pages' URLs. */
  readonly #mediaKey = randomBytes(32)
  /** Assembly, one clip at a time; transcripts on their own queue so a slow one never holds up
   *  the next video. */
  #queue: Promise<void> = Promise.resolve()
  #transcripts: Promise<void> = Promise.resolve()
  /** Bytes of chunks stored per recording, so the 2 GB check doesn't re-read the folder. */
  readonly #uploaded = new Map<string, number>()
  #sweepTimer: NodeJS.Timeout | null = null

  constructor(opts: ClipsOptions) {
    this.#opts = opts
    this.store = opts.store
    this.#log = opts.log ?? ((m) => console.log(m))
    this.#now = opts.now ?? (() => new Date())
  }

  get available(): boolean {
    return this.#opts.media !== null
  }

  #nowIso(): string {
    return this.#now().toISOString()
  }

  #uploadDir(id: string): string {
    return path.join(this.#opts.dataDir, 'clips', 'uploads', id)
  }

  #workDir(id: string): string {
    return path.join(this.#opts.dataDir, 'clips', 'work', id)
  }

  #media(): AudioStore {
    if (!this.#opts.media) {
      throw new HearthError(
        'not_found',
        'Clips needs video storage, which isn’t set up (AUDIO_STORE=none)',
      )
    }
    return this.#opts.media
  }

  /** The clip, or not_found. */
  #get(id: string): ClipRecord {
    const clip = /^[0-9A-Z]{26}$/.test(id) ? this.store.get(id) : null
    if (!clip) throw new HearthError('not_found', 'No such clip')
    return clip
  }

  /** The clip if `principal` owns it; forbidden otherwise. */
  #owned(principal: Principal, id: string): ClipRecord {
    const clip = this.#get(id)
    if (clip.ownerId !== principal.userId) {
      throw new HearthError('forbidden', 'Only the person who recorded this clip can change it')
    }
    return clip
  }

  async create(
    principal: Principal,
    req: { mode: ClipMode; container: ClipContainer; title?: string | undefined },
  ): Promise<ClipView> {
    this.#media()
    await this.#ensureRoom()
    const open = this.store
      .withStatus(['recording'])
      .filter((c) => c.ownerId === principal.userId).length
    if (open >= MAX_OPEN_RECORDINGS) {
      throw new HearthError(
        'conflict',
        'You have recordings open in other tabs; stop or discard one first',
      )
    }
    const clip = this.store.create({
      id: ulid(),
      owner: { userId: principal.userId, email: principal.email, name: principal.name },
      title: req.title?.trim() || 'Untitled clip',
      mode: req.mode,
      container: req.container,
      now: this.#nowIso(),
    })
    return this.view(clip, principal)
  }

  /** Stores chunk `seq` of a recording. Sending the same chunk again replaces it. */
  async putChunk(principal: Principal, id: string, seq: number, bytes: Uint8Array): Promise<void> {
    const clip = this.#owned(principal, id)
    if (clip.status !== 'recording') {
      throw new HearthError('conflict', 'This recording has already been finished')
    }
    if (!Number.isInteger(seq) || seq < 0 || seq >= MAX_CHUNKS) {
      throw new HearthError('bad_request', `A chunk number is from 0 to ${MAX_CHUNKS - 1}`)
    }
    if (bytes.length === 0) throw new HearthError('bad_request', 'An empty chunk')
    await this.#ensureRoom()
    const dir = this.#uploadDir(id)
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, chunkName(seq))
    // Counted before writing (a resend replaces its chunk), so parallel requests can't each pass.
    const replaced = (await stat(file).catch(() => null))?.size ?? 0
    const total = (this.#uploaded.get(id) ?? (await this.#uploadedBytes(dir))) - replaced
    if (total + bytes.length > MAX_CLIP_BYTES) {
      throw new HearthError('bad_request', 'A clip can be at most 2 GB', { status: 413 })
    }
    this.#uploaded.set(id, total + bytes.length)
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await pipeline(Readable.from([bytes]), createWriteStream(tmp))
      await rename(tmp, file)
    } catch (err) {
      this.#uploaded.set(id, (this.#uploaded.get(id) ?? bytes.length) - bytes.length)
      await rm(tmp, { force: true })
      throw err
    }
    // Discarded while this chunk was being written: don't leave a folder nothing points at.
    if (!this.store.get(id)) {
      await rm(dir, { recursive: true, force: true })
      this.#uploaded.delete(id)
      throw new HearthError('not_found', 'No such clip')
    }
    // Recording activity keeps the clip from being swept as abandoned.
    this.store.update(id, {}, this.#nowIso())
  }

  /** Refuses new video when the data volume is nearly full, before git and SQLite run out. */
  async #ensureRoom(): Promise<void> {
    const free = this.#opts.freeBytes
      ? await this.#opts.freeBytes()
      : await statfs(this.#opts.dataDir).then(
          (s) => s.bavail * s.bsize,
          () => Number.POSITIVE_INFINITY,
        )
    if (free < MIN_FREE_BYTES) {
      throw new HearthError(
        'conflict',
        'The server’s disk is nearly full, so recording is paused. Delete old clips, or ask an admin to add storage.',
      )
    }
  }

  async #uploadedBytes(dir: string): Promise<number> {
    let total = 0
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (name.endsWith('.part')) total += (await stat(path.join(dir, name))).size
    }
    return total
  }

  /**
   * The recording is over: `chunks` chunks, numbered from 0, make the whole video. Starts
   * processing. Finishing a clip that's already past recording returns it as it is.
   */
  async finish(principal: Principal, id: string, chunks: number): Promise<ClipView> {
    const clip = this.#owned(principal, id)
    if (clip.status !== 'recording') return this.view(clip, principal)
    if (!Number.isInteger(chunks) || chunks < 1 || chunks > MAX_CHUNKS) {
      throw new HearthError('bad_request', 'A recording has at least one chunk')
    }
    const present = new Set(await readdir(this.#uploadDir(id)).catch(() => [] as string[]))
    const missing: number[] = []
    for (let seq = 0; seq < chunks; seq++) {
      if (!present.has(chunkName(seq))) missing.push(seq)
    }
    if (missing.length > 0) {
      throw new HearthError('conflict', `Chunks ${missing.slice(0, 10).join(', ')} haven’t arrived`)
    }
    const updated = this.store.update(id, { status: 'processing' }, this.#nowIso())
    this.#enqueue(() => this.#process(id, chunks))
    return this.view(updated ?? clip, principal)
  }

  rename(principal: Principal, id: string, title: string): Promise<ClipView> {
    this.#owned(principal, id)
    const trimmed = title.trim()
    if (!trimmed) throw new HearthError('bad_request', 'A title can’t be empty')
    const clip = this.store.update(
      id,
      { title: trimmed.slice(0, MAX_TITLE_LENGTH), titleSet: true },
      this.#nowIso(),
    )
    return this.view(clip ?? this.#get(id), principal)
  }

  /** Removes the clip, its uploads and its stored files. Also how a recording is cancelled. */
  async delete(principal: Principal, id: string): Promise<void> {
    const clip = this.#owned(principal, id)
    this.store.delete(id)
    await this.#removeFiles(clip.id, clip.container)
    this.#log(`clip ${id} deleted by ${principal.email}`)
  }

  async #removeFiles(id: string, container: ClipContainer): Promise<void> {
    this.#uploaded.delete(id)
    await rm(this.#uploadDir(id), { recursive: true, force: true })
    await rm(this.#workDir(id), { recursive: true, force: true })
    const media = this.#opts.media
    if (!media) return
    for (const key of [videoKey(id, container), thumbKey(id)]) {
      try {
        await media.delete(key)
      } catch (err) {
        this.#log(`clip ${id}: couldn't delete ${key}: ${(err as Error).message}`)
      }
    }
  }

  /** Transcribes a ready clip again, after a failure. */
  retryTranscript(principal: Principal, id: string): Promise<ClipView> {
    const clip = this.#owned(principal, id)
    if (clip.status !== 'ready') throw new HearthError('conflict', 'This clip isn’t ready yet')
    if (clip.transcriptStatus !== 'failed') return this.view(clip, principal)
    const updated = this.store.update(
      id,
      { transcriptStatus: 'pending', transcriptError: null },
      this.#nowIso(),
    )
    this.#enqueueTranscript(id)
    return this.view(updated ?? clip, principal)
  }

  async get(
    principal: Principal,
    id: string,
  ): Promise<{ clip: ClipView; transcript: TranscriptSegment[] }> {
    const clip = this.#get(id)
    // Another member's recording in progress isn't anything to watch yet.
    if (clip.status === 'recording' && clip.ownerId !== principal.userId) {
      throw new HearthError('not_found', 'No such clip')
    }
    return { clip: await this.view(clip, principal), transcript: clip.transcript }
  }

  list(
    principal: Principal,
    opts: { scope: 'mine' | 'team'; q?: string | undefined; limit: number },
  ): Promise<ClipView[]> {
    return Promise.all(
      this.store
        .list({ userId: principal.userId, ...opts })
        .map((clip) => this.view(clip, principal)),
    )
  }

  async view(clip: ClipRecord, principal: Principal): Promise<ClipView> {
    const ready = clip.status === 'ready'
    const [videoUrl, thumbUrl, downloadUrl] = ready
      ? await Promise.all([
          this.#url(clip, 'video'),
          clip.hasThumb ? this.#url(clip, 'thumb') : null,
          this.#url(clip, 'video', fileName(clip.title, clip.container)),
        ])
      : [null, null, null]
    return {
      id: clip.id,
      title: clip.title,
      summary: clip.summary,
      mode: clip.mode,
      status: clip.status,
      error: clip.error,
      durationMs: clip.durationMs,
      sizeBytes: clip.sizeBytes,
      width: clip.width,
      height: clip.height,
      mimeType: CONTENT_TYPE[clip.container],
      owner: { name: clip.ownerName, email: clip.ownerEmail },
      isOwner: clip.ownerId === principal.userId,
      createdAt: clip.createdAt,
      updatedAt: clip.updatedAt,
      transcriptStatus: clip.transcriptStatus,
      transcriptError: clip.transcriptError,
      videoUrl,
      thumbUrl,
      downloadUrl,
    }
  }

  /**
   * A URL the browser can stream and seek without Hearth's credentials: presigned R2 in
   * production, so playback never passes through this server; HMAC-signed and served here with
   * the local store.
   */
  async #url(clip: ClipRecord, file: MediaFile, download?: string): Promise<string | null> {
    const media = this.#opts.media
    if (media instanceof LocalAudioStore) return this.#localUrl(clip.id, file, download)
    if (media instanceof R2AudioStore) {
      const key = file === 'thumb' ? thumbKey(clip.id) : videoKey(clip.id, clip.container)
      return media.presignGet(key, {
        windowSeconds: URL_WINDOW_SECONDS,
        ...(download !== undefined ? { download } : {}),
        now: this.#now(),
      })
    }
    return null
  }

  #localUrl(id: string, file: MediaFile, download?: string): string {
    const windowMs = URL_WINDOW_SECONDS * 1000
    const exp = (Math.floor(this.#now().getTime() / windowMs) + 2) * (windowMs / 1000)
    const params = new URLSearchParams({ exp: String(exp) })
    if (download !== undefined) params.set('download', download)
    params.set('sig', this.#sign(id, file, exp, download))
    return `/api/clips/media/${id}/${file}?${params.toString()}`
  }

  #sign(id: string, file: string, exp: number, download?: string): string {
    return createHmac('sha256', this.#mediaKey)
      .update(`${id}\n${file}\n${exp}\n${download ?? ''}`)
      .digest('base64url')
  }

  /**
   * A locally stored file for a signed URL from `#localUrl`: its path, type and download name.
   * not_found for a bad or expired signature, so a URL can't be guessed or kept forever.
   */
  async localMedia(req: {
    id: string
    file: string
    exp: number
    sig: string
    download?: string | undefined
  }): Promise<{ path: string; contentType: string; size: number; download?: string }> {
    const media = this.#opts.media
    const refused = new HearthError('not_found', 'This link has expired; reload the page')
    if (!(media instanceof LocalAudioStore)) throw refused
    if (req.file !== 'video' && req.file !== 'thumb') throw refused
    const expected = Buffer.from(this.#sign(req.id, req.file, req.exp, req.download))
    const given = Buffer.from(req.sig)
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw refused
    if (req.exp * 1000 < this.#now().getTime()) throw refused
    const clip = this.store.get(req.id)
    if (clip?.status !== 'ready') throw refused
    const key = req.file === 'thumb' ? thumbKey(clip.id) : videoKey(clip.id, clip.container)
    const file = media.pathOf(key)
    const size = (await stat(file).catch(() => null))?.size
    if (size === undefined) throw refused
    return {
      path: file,
      contentType: req.file === 'thumb' ? 'image/jpeg' : CONTENT_TYPE[clip.container],
      size,
      ...(req.download !== undefined ? { download: req.download } : {}),
    }
  }

  // ---- processing ----

  #enqueue(job: () => Promise<void>): void {
    this.#queue = this.#queue.then(job).catch((err: unknown) => {
      this.#log(`clip job failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  #enqueueTranscript(id: string): void {
    this.#transcripts = this.#transcripts
      .then(() => this.#transcribe(id))
      .catch((err: unknown) => {
        this.#log(`clip transcript job failed: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  /** Resolves once every queued job, on both queues, has run (tests). */
  async idle(): Promise<void> {
    for (;;) {
      const [videos, transcripts] = [this.#queue, this.#transcripts]
      await Promise.all([videos, transcripts])
      if (videos === this.#queue && transcripts === this.#transcripts) return
    }
  }

  /** At startup: picks up clips a restart interrupted, and sweeps abandoned recordings hourly. */
  recover(): number {
    let resumed = 0
    for (const clip of this.store.withStatus(['processing'])) {
      resumed++
      this.#enqueue(() => this.#process(clip.id, null))
    }
    for (const clip of this.store.transcriptsInterrupted()) {
      resumed++
      this.#enqueueTranscript(clip.id)
    }
    void this.sweep()
    this.#sweepTimer = setInterval(() => void this.sweep(), 3_600_000)
    this.#sweepTimer.unref()
    return resumed
  }

  close(): void {
    if (this.#sweepTimer) clearInterval(this.#sweepTimer)
    this.#sweepTimer = null
  }

  /**
   * Removes recordings nobody has sent a chunk to, or finished, for a day, and upload or work
   * folders whose clip is gone or failed.
   */
  async sweep(): Promise<number> {
    const cutoff = this.#now().getTime() - ABANDONED_MS
    let removed = 0
    for (const clip of this.store.withStatus(['recording'])) {
      if (Date.parse(clip.updatedAt) > cutoff) continue
      this.store.delete(clip.id)
      await this.#removeFiles(clip.id, clip.container)
      removed++
    }
    for (const kind of ['uploads', 'work']) {
      const root = path.join(this.#opts.dataDir, 'clips', kind)
      for (const id of await readdir(root).catch(() => [] as string[])) {
        const clip = this.store.get(id)
        if (clip && clip.status !== 'failed') continue
        await rm(path.join(root, id), { recursive: true, force: true })
      }
    }
    if (removed > 0) this.#log(`clips: removed ${removed} abandoned recording(s)`)
    return removed
  }

  /** Chunks → seekable video and thumbnail in the store → ready; then the transcript. */
  async #process(id: string, chunks: number | null): Promise<void> {
    const clip = this.store.get(id)
    if (clip?.status !== 'processing') return
    const started = Date.now()
    const work = this.#workDir(id)
    await rm(work, { recursive: true, force: true })
    await mkdir(work, { recursive: true })
    const ext = clip.container
    const raw = path.join(work, `raw.${ext}`)
    const video = path.join(work, `video.${ext}`)
    const thumb = path.join(work, 'thumb.jpg')
    try {
      const count =
        chunks ?? (await readdir(this.#uploadDir(id))).filter((n) => n.endsWith('.part')).length
      await this.#concat(id, count, raw)
      await remux(this.#opts.ffmpeg, raw, video, ext)
      await rm(raw, { force: true })
      const info = await probe(this.#opts.ffmpeg, video)
      if (!info.hasVideo && !info.hasAudio) throw new Error('the recording has no video or sound')
      let hasThumb = false
      if (info.hasVideo) {
        try {
          await thumbnail(this.#opts.ffmpeg, video, thumb, info.durationMs)
          hasThumb = true
        } catch (err) {
          this.#log(`clip ${id}: no thumbnail: ${(err as Error).message}`)
        }
      }
      const size = (await stat(video)).size
      const media = this.#media()
      await media.put(videoKey(id, ext), createReadStream(video), size, CONTENT_TYPE[ext])
      if (hasThumb) {
        const thumbSize = (await stat(thumb)).size
        await media.put(thumbKey(id), createReadStream(thumb), thumbSize, 'image/jpeg')
      }
      const updated = this.store.update(
        id,
        {
          status: 'ready',
          error: null,
          durationMs: info.durationMs,
          sizeBytes: size,
          width: info.width,
          height: info.height,
          hasThumb,
          transcriptStatus: info.hasAudio ? 'pending' : 'none',
        },
        this.#nowIso(),
      )
      if (!updated) {
        // Deleted while it was being processed: what was just stored goes too.
        await this.#removeFiles(id, ext)
        return
      }
      await rm(this.#uploadDir(id), { recursive: true, force: true })
      this.#uploaded.delete(id)
      this.#log(
        `clip ${JSON.stringify({ id, ms: Date.now() - started, durationMs: info.durationMs, bytes: size })}`,
      )
      if (info.hasAudio) this.#enqueueTranscript(id)
      else await rm(work, { recursive: true, force: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.#log(`clip ${id} failed to process: ${message}`)
      if (this.store.get(id)) {
        this.store.update(
          id,
          { status: 'failed', error: 'This recording couldn’t be turned into a video' },
          this.#nowIso(),
        )
      }
      // Nothing can use the chunks again: a failed clip is recorded anew.
      await rm(work, { recursive: true, force: true })
      await rm(this.#uploadDir(id), { recursive: true, force: true })
      this.#uploaded.delete(id)
    }
  }

  /** Appends chunks 0…count−1, in order, into one file. */
  async #concat(id: string, count: number, output: string): Promise<void> {
    const out = createWriteStream(output)
    try {
      for (let seq = 0; seq < count; seq++) {
        const part = path.join(this.#uploadDir(id), chunkName(seq))
        await pipeline(createReadStream(part), out, { end: false })
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        out.end((err?: Error | null) => (err ? reject(err) : resolve())),
      )
    }
  }

  /** The clip's video on disk: kept from processing, or fetched back from the store. */
  async #localVideo(clip: ClipRecord): Promise<string> {
    const work = this.#workDir(clip.id)
    const file = path.join(work, `video.${clip.container}`)
    if (await stat(file).catch(() => null)) return file
    const object = await this.#media().get(videoKey(clip.id, clip.container))
    if (!object) throw new Error('the video is missing from storage')
    await mkdir(work, { recursive: true })
    await pipeline(Readable.fromWeb(object.body as never), createWriteStream(file))
    return file
  }

  async #transcribe(id: string): Promise<void> {
    let clip = this.store.get(id)
    if (clip?.status !== 'ready') return
    clip = this.store.update(
      id,
      { transcriptStatus: 'processing', transcriptError: null },
      this.#nowIso(),
    )
    if (!clip) return
    const work = this.#workDir(id)
    try {
      const video = await this.#localVideo(clip)
      const audioFile = path.join(work, 'audio.flac')
      await extractAudio(this.#opts.ffmpeg, video, audioFile)
      const audio = await readFile(audioFile)
      const started = Date.now()
      const transcript = await this.#opts.transcriber.transcribe(audio, {
        mimeType: 'audio/flac',
        keyterms: this.#opts.keyterms(clip.ownerId),
        durationMs: clip.durationMs ?? 0,
      })
      const asrMs = Date.now() - started
      const saved = this.store.update(
        id,
        { transcriptStatus: 'ready', transcript, transcriptError: null },
        this.#nowIso(),
      )
      this.#log(`clip transcript ${JSON.stringify({ id, asrMs, lines: transcript.length })}`)
      if (saved && transcript.length > 0) await this.#suggest(saved)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.#log(`clip ${id} transcript failed: ${message}`)
      if (this.store.get(id)) {
        this.store.update(
          id,
          {
            transcriptStatus: 'failed',
            transcriptError:
              err instanceof HearthError && err.code === 'asr_error'
                ? err.message
                : 'The transcript couldn’t be made',
          },
          this.#nowIso(),
        )
      }
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }

  /** A suggested title (unless the owner chose one) and a short summary. Failure is only logged. */
  async #suggest(clip: ClipRecord): Promise<void> {
    try {
      const { text } = await this.#opts.llm.complete({
        model: this.#opts.model,
        maxTokens: 300,
        system:
          'You name and summarize short screen recordings that colleagues send each other. ' +
          'Use only what the transcript says. Plain words, no marketing tone, no quotes around the title.',
        messages: [
          {
            role: 'user',
            content:
              `<clip_transcript>\n${transcriptText(clip.transcript).slice(0, SUMMARY_TRANSCRIPT_CHARS)}\n</clip_transcript>\n\n` +
              'Reply with <title>…</title>, at most eight words, and <summary>…</summary>, one or two sentences on what the clip shows or asks.',
          },
        ],
      })
      const title = tagged(text, 'title')
        ?.replace(/^["“]|["”]$/g, '')
        .slice(0, MAX_TITLE_LENGTH)
      const summary = tagged(text, 'summary')?.slice(0, 1000)
      const current = this.store.get(clip.id)
      if (!current) return
      this.store.update(
        clip.id,
        {
          ...(title && !current.titleSet ? { title } : {}),
          ...(summary ? { summary } : {}),
        },
        this.#nowIso(),
      )
    } catch (err) {
      this.#log(`clip ${clip.id}: no title or summary: ${(err as Error).message}`)
    }
  }
}

export function chunkName(seq: number): string {
  return `${String(seq).padStart(6, '0')}.part`
}

export function videoKey(id: string, container: ClipContainer): string {
  return `clips/${id}/video.${container}`
}

export function thumbKey(id: string): string {
  return `clips/${id}/thumb.jpg`
}
