import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { type Cut, cutTranscript } from './cuts.js'

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
/** The owner's trim: none (never edited or reverted), pending/processing (being made), ready, failed. */
export type EditStatus = 'none' | 'pending' | 'processing' | 'ready' | 'failed'

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
  /** The transcript of the video that plays: the edited one's when there is an edit. */
  transcript: TranscriptSegment[]
  /** The transcript of the whole recording, as transcribed (times in the original video). */
  fullTranscript: TranscriptSegment[]
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
  /** The cuts the owner last saved (being made, or made), in the original video's time. */
  cuts: Cut[]
  editStatus: EditStatus
  /** Raised on every save and revert, so a superseded render knows to throw its work away. */
  editVersion: number
  /** The cuts in the edited video that plays, and its version (0: no edit, the original plays). */
  appliedCuts: Cut[]
  appliedVersion: number
  editedDurationMs: number | null
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
  `
  ALTER TABLE clips ADD COLUMN cuts TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE clips ADD COLUMN edit_status TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE clips ADD COLUMN edit_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE clips ADD COLUMN applied_cuts TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE clips ADD COLUMN applied_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE clips ADD COLUMN edited_duration_ms INTEGER;
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
  cuts: string
  edit_status: EditStatus
  edit_version: number
  applied_cuts: string
  applied_version: number
  edited_duration_ms: number | null
}

function toRecord(r: Row): ClipRecord {
  const full = JSON.parse(r.transcript) as TranscriptSegment[]
  const appliedCuts = JSON.parse(r.applied_cuts) as Cut[]
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
    transcript: r.applied_version > 0 ? cutTranscript(full, appliedCuts) : full,
    fullTranscript: full,
    cameraChunks: r.camera_chunks,
    cameraContainer: r.camera_container,
    cameraOffsetMs: r.camera_offset_ms,
    compositeStatus: r.composite_status,
    screenSurface: r.screen_surface,
    screenLabel: r.screen_label,
    speakers: JSON.parse(r.speakers) as Record<string, string>,
    aiSummary: r.ai_summary,
    aiActions: r.ai_actions,
    cuts: JSON.parse(r.cuts) as Cut[],
    editStatus: r.edit_status,
    editVersion: r.edit_version,
    appliedCuts,
    appliedVersion: r.applied_version,
    editedDurationMs: r.edited_duration_ms,
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
    | 'cuts'
    | 'editStatus'
    | 'editVersion'
    | 'appliedCuts'
    | 'appliedVersion'
    | 'editedDurationMs'
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
  cuts: 'cuts',
  editStatus: 'edit_status',
  editVersion: 'edit_version',
  appliedCuts: 'applied_cuts',
  appliedVersion: 'applied_version',
  editedDurationMs: 'edited_duration_ms',
}

/** `%` and `_` match themselves in a LIKE pattern built from what a member typed. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
}

/**
 * Hotsauce Clips' metadata and transcripts (ARCHITECTURE §10.1). Its own SQLite file beside the
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
      } else if (key === 'speakers' || key === 'cuts' || key === 'appliedCuts') {
        values[column] = JSON.stringify(value)
      } else if (typeof value === 'boolean') {
        values[column] = value ? 1 : 0
      } else {
        values[column] = value
      }
    }
    this.#db.prepare(`UPDATE clips SET ${sets.join(', ')} WHERE id = @id`).run(values)
    const updated = this.get(id)
    // Search reads what plays: the transcript as trimmed, never the parts that were cut.
    const trimChanged = patch.appliedCuts !== undefined || patch.appliedVersion !== undefined
    if (updated && (trimChanged || (patch.transcript && updated.appliedVersion > 0))) {
      this.#db
        .prepare('UPDATE clips SET transcript_text = ? WHERE id = ?')
        .run(updated.transcript.map((s) => s.text).join(' '), id)
    }
    return updated
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

  /** Every clip created at or after `from` (any owner, any status), for the usage report. */
  createdSince(from: string): Array<{ id: string; ownerEmail: string; createdAt: string }> {
    return this.#db
      .prepare(
        'SELECT id, owner_email AS ownerEmail, created_at AS createdAt FROM clips WHERE created_at >= ?',
      )
      .all(from) as Array<{ id: string; ownerEmail: string; createdAt: string }>
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

  /** Ready clips whose edit was waiting or being made when the server stopped. */
  editsInterrupted(): ClipRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM clips WHERE status = 'ready' AND edit_status IN ('pending', 'processing')`,
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
