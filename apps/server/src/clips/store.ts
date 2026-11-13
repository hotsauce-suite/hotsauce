import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

export type ClipMode = 'screen_camera' | 'screen' | 'camera'
/** recording: chunks arriving. processing: being assembled. ready: playable. failed: never playable. */
export type ClipStatus = 'recording' | 'processing' | 'ready' | 'failed'
/** none: the clip has no sound to transcribe. */
export type TranscriptStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'none'
export type ClipContainer = 'mp4' | 'webm'

/** One line of a clip's transcript; times in seconds from the start of the video. */
export interface TranscriptSegment {
  start: number
  end: number
  text: string
  /** Who said it, from diarization: 0, 1, … in order of first speaking. Absent in older clips. */
  speaker?: number
}

/** pending: the camera is waiting to be put into the video. none: there's no camera track. */
export type CompositeStatus = 'none' | 'pending' | 'processing' | 'ready' | 'failed'

export interface ClipRecord {
  id: string
  ownerId: string
  ownerEmail: string
  ownerName: string
  title: string
  /** The owner chose the title, so the suggested one never replaces it. */
  titleSet: boolean
  summary: string | null
  mode: ClipMode
  container: ClipContainer
  status: ClipStatus
  error: string | null
  durationMs: number | null
  sizeBytes: number | null
  width: number | null
  height: number | null
  hasThumb: boolean
  transcriptStatus: TranscriptStatus
  transcriptError: string | null
  transcript: TranscriptSegment[]
  /** Chunks of the separately recorded camera, or null when there's no camera track. */
  cameraChunks: number | null
  cameraContainer: ClipContainer | null
  /** How much later than the screen the camera started, in ms (negative: earlier). */
  cameraOffsetMs: number
  compositeStatus: CompositeStatus
  /** What the member shared (`monitor`, `window`, `browser`) and its label, for diagnosis. */
  screenSurface: string | null
  screenLabel: string | null
  /** Names the owner gave speakers, by speaker number. */
  speakers: Record<string, string>
  aiSummary: string | null
  aiActions: string | null
  createdAt: string
  updatedAt: string
}

const MIGRATIONS = [
  `
  CREATE TABLE clips (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    owner_name TEXT NOT NULL,
    title TEXT NOT NULL,
    title_set INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    mode TEXT NOT NULL,
    container TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    duration_ms INTEGER,
    size_bytes INTEGER,
    width INTEGER,
    height INTEGER,
    has_thumb INTEGER NOT NULL DEFAULT 0,
    transcript_status TEXT NOT NULL DEFAULT 'pending',
    transcript_error TEXT,
    transcript TEXT NOT NULL DEFAULT '[]',
    transcript_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX clips_owner ON clips (owner_id, created_at);
  CREATE INDEX clips_created ON clips (created_at);
  `,
  `
  ALTER TABLE clips ADD COLUMN camera_chunks INTEGER;
  ALTER TABLE clips ADD COLUMN camera_container TEXT;
  ALTER TABLE clips ADD COLUMN camera_offset_ms INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE clips ADD COLUMN composite_status TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE clips ADD COLUMN screen_surface TEXT;
  ALTER TABLE clips ADD COLUMN screen_label TEXT;
  ALTER TABLE clips ADD COLUMN speakers TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE clips ADD COLUMN ai_summary TEXT;
  ALTER TABLE clips ADD COLUMN ai_actions TEXT;
  `,
]

interface Row {
  id: string
  owner_id: string
  owner_email: string
  owner_name: string
  title: string
  title_set: number
  summary: string | null
  mode: ClipMode
  container: ClipContainer
  status: ClipStatus
  error: string | null
  duration_ms: number | null
  size_bytes: number | null
  width: number | null
  height: number | null
  has_thumb: number
  transcript_status: TranscriptStatus
  transcript_error: string | null
  transcript: string
  created_at: string
  updated_at: string
  camera_chunks: number | null
  camera_container: ClipContainer | null
  camera_offset_ms: number
  composite_status: CompositeStatus
  screen_surface: string | null
  screen_label: string | null
  speakers: string
  ai_summary: string | null
  ai_actions: string | null
}

function toRecord(r: Row): ClipRecord {
  return {
    id: r.id,
    ownerId: r.owner_id,
    ownerEmail: r.owner_email,
    ownerName: r.owner_name,
    title: r.title,
    titleSet: r.title_set === 1,
    summary: r.summary,
    mode: r.mode,
    container: r.container,
    status: r.status,
    error: r.error,
    durationMs: r.duration_ms,
    sizeBytes: r.size_bytes,
    width: r.width,
    height: r.height,
    hasThumb: r.has_thumb === 1,
    transcriptStatus: r.transcript_status,
    transcriptError: r.transcript_error,
    transcript: JSON.parse(r.transcript) as TranscriptSegment[],
    cameraChunks: r.camera_chunks,
    cameraContainer: r.camera_container,
    cameraOffsetMs: r.camera_offset_ms,
    compositeStatus: r.composite_status,
    screenSurface: r.screen_surface,
    screenLabel: r.screen_label,
    speakers: JSON.parse(r.speakers) as Record<string, string>,
    aiSummary: r.ai_summary,
    aiActions: r.ai_actions,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export type ClipPatch = Partial<
  Pick<
    ClipRecord,
    | 'title'
    | 'titleSet'
    | 'summary'
    | 'status'
    | 'error'
    | 'durationMs'
    | 'sizeBytes'
    | 'width'
    | 'height'
    | 'hasThumb'
    | 'transcriptStatus'
    | 'transcriptError'
    | 'transcript'
    | 'cameraChunks'
    | 'cameraContainer'
    | 'cameraOffsetMs'
    | 'compositeStatus'
    | 'screenSurface'
    | 'screenLabel'
    | 'speakers'
    | 'aiSummary'
    | 'aiActions'
  >
>

const COLUMN: Record<keyof ClipPatch, string> = {
  title: 'title',
  titleSet: 'title_set',
  summary: 'summary',
  status: 'status',
  error: 'error',
  durationMs: 'duration_ms',
  sizeBytes: 'size_bytes',
  width: 'width',
  height: 'height',
  hasThumb: 'has_thumb',
  transcriptStatus: 'transcript_status',
  transcriptError: 'transcript_error',
  transcript: 'transcript',
  cameraChunks: 'camera_chunks',
  cameraContainer: 'camera_container',
  cameraOffsetMs: 'camera_offset_ms',
  compositeStatus: 'composite_status',
  screenSurface: 'screen_surface',
  screenLabel: 'screen_label',
  speakers: 'speakers',
  aiSummary: 'ai_summary',
  aiActions: 'ai_actions',
}

/** `%` and `_` match themselves in a LIKE pattern built from what a member typed. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
}

/**
 * Hearth Clips' metadata and transcripts (ARCHITECTURE §10.1). Its own SQLite file beside the
 * index, like Dictate's: the index is rebuilt from Git, and clips aren't in Git.
 */
export class ClipStore {
  readonly #db: Database.Database

  /** `file` is a path, or ':memory:'. */
  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#db = new Database(file)
    this.#db.pragma('journal_mode = WAL')
    this.#db.pragma('busy_timeout = 5000')
    this.#migrate()
  }

  close(): void {
    this.#db.close()
  }

  #migrate(): void {
    this.#db
      .transaction(() => {
        this.#db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
        const row = this.#db.prepare('SELECT version FROM schema_version').get() as
          | { version: number }
          | undefined
        const current = row?.version ?? 0
        if (!row) this.#db.prepare('INSERT INTO schema_version (version) VALUES (0)').run()
        for (const sql of MIGRATIONS.slice(current)) this.#db.exec(sql)
        this.#db.prepare('UPDATE schema_version SET version = ?').run(MIGRATIONS.length)
      })
      .immediate()
  }

  create(clip: {
    id: string
    owner: { userId: string; email: string; name: string }
    title: string
    mode: ClipMode
    container: ClipContainer
    now: string
  }): ClipRecord {
    this.#db
      .prepare(
        `INSERT INTO clips (id, owner_id, owner_email, owner_name, title, mode, container, status,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'recording', ?, ?)`,
      )
      .run(
        clip.id,
        clip.owner.userId,
        clip.owner.email,
        clip.owner.name,
        clip.title,
        clip.mode,
        clip.container,
        clip.now,
        clip.now,
      )
    return this.get(clip.id) as ClipRecord
  }

  get(id: string): ClipRecord | null {
    const row = this.#db.prepare('SELECT * FROM clips WHERE id = ?').get(id) as Row | undefined
    return row ? toRecord(row) : null
  }

  /** Applies `patch`; returns the clip after it, or null when it's gone (deleted meanwhile). */
  update(id: string, patch: ClipPatch, now: string): ClipRecord | null {
    const sets: string[] = ['updated_at = @updated_at']
    const values: Record<string, unknown> = { id, updated_at: now }
    for (const [key, value] of Object.entries(patch) as Array<[keyof ClipPatch, unknown]>) {
      if (value === undefined) continue
      const column = COLUMN[key]
      sets.push(`${column} = @${column}`)
      if (key === 'transcript') {
        const segments = value as TranscriptSegment[]
        values[column] = JSON.stringify(segments)
        sets.push('transcript_text = @transcript_text')
        values.transcript_text = segments.map((s) => s.text).join(' ')
      } else if (key === 'speakers') {
        values[column] = JSON.stringify(value)
      } else if (typeof value === 'boolean') {
        values[column] = value ? 1 : 0
      } else {
        values[column] = value
      }
    }
    this.#db.prepare(`UPDATE clips SET ${sets.join(', ')} WHERE id = @id`).run(values)
    return this.get(id)
  }

  delete(id: string): void {
    this.#db.prepare('DELETE FROM clips WHERE id = ?').run(id)
  }

  /**
   * Newest first. `mine` is the member's own clips, `team` everyone's. Clips still recording are
   * never listed; another member's are listed once they're processing or ready. `q` matches the
   * title, summary or transcript, ignoring case.
   */
  list(opts: {
    userId: string
    scope: 'mine' | 'team'
    q?: string | undefined
    /** ISO timestamps: only clips created at or after `from` and before `to`. */
    from?: string | undefined
    to?: string | undefined
    limit: number
  }): ClipRecord[] {
    const where = [`status != 'recording'`]
    const values: Record<string, unknown> = { user: opts.userId, limit: opts.limit }
    if (opts.scope === 'mine') where.push('owner_id = @user')
    else where.push(`(owner_id = @user OR status IN ('processing', 'ready'))`)
    if (opts.from) {
      where.push('created_at >= @from')
      values.from = opts.from
    }
    if (opts.to) {
      where.push('created_at < @to')
      values.to = opts.to
    }
    const q = opts.q?.trim()
    if (q) {
      where.push(
        `(title LIKE @q ESCAPE '\\' OR summary LIKE @q ESCAPE '\\' OR transcript_text LIKE @q ESCAPE '\\')`,
      )
      values.q = likePattern(q)
    }
    const rows = this.#db
      .prepare(
        `SELECT * FROM clips WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT @limit`,
      )
      .all(values) as Row[]
    return rows.map(toRecord)
  }

  /** Clips in one of `statuses`, oldest first (startup recovery and the abandoned-upload sweep). */
  withStatus(statuses: ClipStatus[]): ClipRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM clips WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY created_at`,
      )
      .all(...statuses) as Row[]
    return rows.map(toRecord)
  }

  /** Ready clips whose camera bubble wasn't added yet (a restart interrupted it). */
  compositesInterrupted(): ClipRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM clips WHERE status = 'ready' AND composite_status IN ('pending', 'processing')`,
      )
      .all() as Row[]
    return rows.map(toRecord)
  }

  /** Ready clips whose transcript was interrupted by a restart. */
  transcriptsInterrupted(): ClipRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM clips WHERE status = 'ready' AND transcript_status IN ('pending', 'processing')`,
      )
      .all() as Row[]
    return rows.map(toRecord)
  }
}
