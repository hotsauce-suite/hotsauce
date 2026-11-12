import {
  cleanLabels,
  FrontmatterError,
  isChecklist,
  type KeepNote,
  mapKeepNote,
  type NewNote,
  NOTE_COLORS,
  type NoteColor,
  NoteFrontmatter,
  type NoteSource,
  newNoteFile,
  noteBodyText,
  noteIdOf,
  notePath,
  noteTextOf,
  noteTitle,
  parseFrontmatter,
  patchFrontmatter,
  SPACE_LAYOUT,
} from '@hearth/format'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import { type CommitResult, formatCommitMessage, type GitStore, withVia } from '../git/index.js'
import type { Index } from '../index/index.js'
import { type Space, type SpaceService, TEAM_SPACE } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'

export const MAX_NOTE_LIST = 1000
export const MAX_IMPORT_NOTES = 5000
/** Notes in the trash longer than this are deleted for good (ARCHITECTURE §14.2). */
export const TRASH_DAYS = 30
const WRITE_ATTEMPTS = 3
const NOTE_ID = /^[0-9A-Z]{26}$/
const DAY_MS = 86_400_000

export interface NoteView {
  space: string
  path: string
  id: string
  blobOid: string
  title: string
  /** The note's text: Markdown, or only `- [ ]` lines for a checklist. */
  body: string
  checklist: boolean
  color: NoteColor | null
  pinned: boolean
  archived: boolean
  /** ISO instant it went to the trash, else null. */
  trashed: string | null
  labels: string[]
  created: string
  createdBy: string
  updated: string
  order: number | null
  source: NoteSource | null
}

export type NoteListView = 'board' | 'archive' | 'trash'

export interface NoteFilter {
  /** board (default): not archived or trashed; archive: archived, not trashed; trash: trashed. */
  view?: NoteListView | undefined
  label?: string | undefined
  space?: string | undefined
  q?: string | undefined
  limit?: number | undefined
}

export interface NoteInput {
  title?: string | undefined
  body?: string | undefined
  color?: NoteColor | null | undefined
  pinned?: boolean | undefined
  archived?: boolean | undefined
  labels?: string[] | undefined
  order?: number | null | undefined
}

interface NoteRecord {
  space: string
  path: string
  id: string
  blobOid: string
  fm: NoteFrontmatter
}

type NotesGit = Pick<GitStore, 'readFile' | 'commit' | 'readBlobText'>
type NotesIndex = Pick<Index, 'listFiles' | 'search' | 'bodies'>

export interface NotesDeps {
  git: NotesGit
  index: NotesIndex
  spaces: Pick<SpaceService, 'visibleSpaces' | 'canAccess'>
  syncer: Pick<Syncer, 'afterHeadChanged'>
  now?: () => Date
  log?: (message: string) => void
}

/** Board order: pinned first, then manual order or creation time (newest first), then id. */
export function compareNotes(a: NoteView, b: NoteView): number {
  if (a.trashed || b.trashed) {
    const t = (b.trashed ?? '').localeCompare(a.trashed ?? '')
    if (t !== 0) return t
  }
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  return sortKey(b) - sortKey(a) || b.id.localeCompare(a.id)
}

/** A note's place on the board: its `order`, else when it was made (ms). */
export function sortKey(n: Pick<NoteView, 'order' | 'created'>): number {
  if (n.order !== null) return n.order
  const t = Date.parse(n.created)
  return Number.isNaN(t) ? 0 : t
}

/** What a commit calls a note: its title, else its first words, else "Untitled note". */
export function noteName(title: string, body: string): string {
  const name = title || noteTitle(body.split('\n').find((l) => l.trim() !== '') ?? '')
  const clean = name.replace(/^[-*+]\s+\[[ xX]\]\s*/, '').replace(/"/g, "'")
  if (!clean) return 'Untitled note'
  return clean.length > 60 ? `${clean.slice(0, 59)}…` : clean
}

function isoNow(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function parseNote(data: unknown): NoteFrontmatter | null {
  const parsed = NoteFrontmatter.safeParse(data)
  return parsed.success ? parsed.data : null
}

function toView(rec: NoteRecord, body: string): NoteView {
  const fm = rec.fm
  return {
    space: rec.space,
    path: rec.path,
    id: rec.id,
    blobOid: rec.blobOid,
    title: fm.title ?? '',
    body,
    checklist: isChecklist(body),
    color: fm.color ?? null,
    pinned: fm.pinned === true,
    archived: fm.archived === true,
    trashed: fm.trashed ?? null,
    labels: fm.labels ?? [],
    created: fm.created,
    createdBy: fm.created_by.toLowerCase(),
    updated: fm.updated ?? fm.created,
    order: fm.order ?? null,
    source: fm.source ?? null,
  }
}

function personalOf(spaces: Space[]): Space | undefined {
  return spaces.find((s) => s.kind === 'personal')
}

/**
 * Hearth Notes on the server (ARCHITECTURE §14.2): one Markdown file per note, listed from the
 * index, every write a read → patch → commit retried on a concurrent change.
 */
export class Notes {
  readonly #importing = new Map<string, Promise<unknown>>()
  readonly #git: NotesGit
  readonly #index: NotesIndex
  readonly #spaces: NotesDeps['spaces']
  readonly #syncer: NotesDeps['syncer']
  readonly #now: () => Date
  readonly #log: (message: string) => void

  constructor(deps: NotesDeps) {
    this.#git = deps.git
    this.#index = deps.index
    this.#spaces = deps.spaces
    this.#syncer = deps.syncer
    this.#now = deps.now ?? (() => new Date())
    this.#log = deps.log ?? console.warn
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** Notes in the member's visible spaces, from the index (no Git reads). */
  async list(principal: Principal, filter: NoteFilter = {}): Promise<NoteView[]> {
    const visible = await this.#spaces.visibleSpaces(principal)
    if (filter.space) this.#assertAccess(principal, filter.space)
    const scope = filter.space ? visible.filter((s) => s.name === filter.space) : visible
    const view = filter.view ?? 'board'
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? MAX_NOTE_LIST), 1), MAX_NOTE_LIST)
    const matching = filter.q?.trim() ? this.#searchPaths(filter.q, scope) : null
    const label = filter.label?.trim().toLowerCase()
    const cutoff = this.#trashCutoff()

    const records = this.#records(scope)
      .filter((r) => matching === null || matching.has(`${r.space}\n${r.path}`))
      .filter((r) => {
        const trashed = r.fm.trashed
        if (view === 'trash') return !!trashed && trashed >= cutoff
        if (trashed) return false
        if ((r.fm.archived === true) !== (view === 'archive')) return false
        if (label && !(r.fm.labels ?? []).some((l) => l.toLowerCase() === label)) return false
        return true
      })
    const views = records
      .map((r) => toView(r, ''))
      .sort(compareNotes)
      .slice(0, limit)

    const bySpace = new Map<string, string[]>()
    for (const n of views) bySpace.set(n.space, [...(bySpace.get(n.space) ?? []), n.path])
    const bodies = new Map<string, string>()
    for (const [space, paths] of bySpace) {
      for (const [path, body] of this.#index.bodies(space, paths)) {
        bodies.set(`${space}\n${path}`, body)
      }
    }
    return views.map((n) => {
      const body = noteTextOf(bodies.get(`${n.space}\n${n.path}`) ?? '')
      return { ...n, body, checklist: isChecklist(body) }
    })
  }

  async get(principal: Principal, space: string, id: string): Promise<NoteView> {
    this.#assertAccess(principal, space)
    const file = await this.#read(space, id)
    return toView(file.record, file.body)
  }

  /** Every label on the member's notes (not trashed), with how many notes carry it. */
  async labels(principal: Principal): Promise<Array<{ name: string; count: number }>> {
    const visible = await this.#spaces.visibleSpaces(principal)
    const counts = new Map<string, { name: string; count: number }>()
    for (const r of this.#records(visible)) {
      if (r.fm.trashed) continue
      for (const l of r.fm.labels ?? []) {
        const key = l.toLowerCase()
        const entry = counts.get(key) ?? { name: l, count: 0 }
        entry.count++
        counts.set(key, entry)
      }
    }
    return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  // ── writes ───────────────────────────────────────────────────────────────

  /** A new note, in the member's personal space unless `space` says otherwise. */
  async create(
    principal: Principal,
    input: NoteInput & { space?: string | undefined; source?: NoteSource | undefined },
    via?: string,
  ): Promise<NoteView> {
    const space = input.space ?? (await this.#personalSpace(principal)) ?? TEAM_SPACE
    this.#assertAccess(principal, space)
    const now = isoNow(this.#now())
    const file = newNoteFile({
      title: input.title,
      body: input.body,
      color: input.color ?? undefined,
      pinned: input.pinned,
      archived: input.archived,
      labels: input.labels,
      order: input.order ?? undefined,
      source: input.source,
      createdBy: principal.email,
      created: now,
      updated: now,
    })
    const result = await this.#commit(principal, space, {
      changes: [{ path: file.path, content: file.text }],
      verb: 'create',
      title: noteName(noteTitle(input.title ?? ''), noteTextOf(input.body ?? '')),
      via,
    })
    return this.#viewOf(space, file.path, file.text, result)
  }

  /**
   * Changes the fields in `patch`. `baseBlobOid` asks for a 409 when the title or text being
   * replaced changed since that version; other fields never conflict.
   */
  async update(
    principal: Principal,
    space: string,
    id: string,
    patch: NoteInput,
    via?: string,
    opts: { baseBlobOid?: string | undefined } = {},
  ): Promise<NoteView> {
    this.#assertAccess(principal, space)
    const touchesText = patch.title !== undefined || patch.body !== undefined
    let base: { title: string; body: string } | null | undefined
    return this.#edit(principal, space, id, verbFor(patch), via, async (cur, blobOid) => {
      if (opts.baseBlobOid && opts.baseBlobOid !== blobOid && touchesText) {
        base ??= await this.#textAt(space, opts.baseBlobOid)
        const titleChanged = patch.title !== undefined && base?.title !== (cur.fm.title ?? '')
        const bodyChanged = patch.body !== undefined && base?.body !== cur.body
        if (base === null || titleChanged || bodyChanged) {
          throw new HearthError(
            'conflict',
            'Someone else changed this note; reload to see their version',
          )
        }
      }
      const fields: Record<string, unknown> = {}
      let contentChanged = false
      if (patch.title !== undefined) {
        const title = noteTitle(patch.title)
        if (title !== (cur.fm.title ?? '')) contentChanged = true
        fields.title = title || undefined
      }
      if (patch.color !== undefined) {
        if (patch.color !== null && !(NOTE_COLORS as readonly string[]).includes(patch.color)) {
          throw new HearthError('bad_request', `Unknown color "${patch.color}"`)
        }
        fields.color = patch.color ?? undefined
      }
      if (patch.pinned !== undefined) fields.pinned = patch.pinned || undefined
      if (patch.archived !== undefined) fields.archived = patch.archived || undefined
      if (patch.labels !== undefined) {
        const labels = cleanLabels(patch.labels)
        fields.labels = labels.length > 0 ? labels : undefined
      }
      if (patch.order !== undefined) fields.order = patch.order ?? undefined
      const newBody = patch.body !== undefined ? noteTextOf(patch.body) : cur.body
      if (newBody !== cur.body) contentChanged = true
      if (contentChanged) fields.updated = isoNow(this.#now())
      let text = patchFrontmatter(cur.content, fields)
      if (newBody !== cur.body) {
        const { body } = parseFrontmatter(text)
        text = text.slice(0, text.length - body.length) + noteBodyText(newBody)
      }
      return text === cur.content ? null : text
    })
  }

  /** To the trash: hidden from the board and archive, restorable for 30 days. */
  async trash(principal: Principal, space: string, id: string, via?: string): Promise<NoteView> {
    this.#assertAccess(principal, space)
    const now = isoNow(this.#now())
    return this.#edit(principal, space, id, 'trash', via, async (cur) =>
      cur.fm.trashed ? null : patchFrontmatter(cur.content, { trashed: now, pinned: undefined }),
    )
  }

  async restore(principal: Principal, space: string, id: string, via?: string): Promise<NoteView> {
    this.#assertAccess(principal, space)
    return this.#edit(principal, space, id, 'restore', via, async (cur) =>
      cur.fm.trashed ? patchFrontmatter(cur.content, { trashed: undefined }) : null,
    )
  }

  /** Deletes for good: the file moves to `.trash/<YYYY-MM-DD>/notes/<id>.md`, like a deleted doc. */
  async remove(principal: Principal, space: string, id: string, via?: string): Promise<void> {
    this.#assertAccess(principal, space)
    await this.#purge(principal, space, [id], 'delete', via)
  }

  /** Deletes for good the member's notes that went to the trash over 30 days ago. Best effort. */
  async emptyOldTrash(principal: Principal): Promise<number> {
    const cutoff = this.#trashCutoff()
    let removed = 0
    for (const s of await this.#spaces.visibleSpaces(principal)) {
      const old = this.#records([s])
        .filter((r) => r.fm.trashed && r.fm.trashed < cutoff)
        .map((r) => r.id)
      if (old.length === 0) continue
      try {
        await this.#purge(principal, s.name, old, 'empty trash', undefined, cutoff)
        removed += old.length
      } catch (err) {
        this.#log(
          `notes: couldn't empty the trash in ${s.name}: ${err instanceof Error ? err.message : err}`,
        )
      }
    }
    return removed
  }

  /** One commit per space: the note is added to `toSpace`, then removed where it was. */
  async move(
    principal: Principal,
    space: string,
    id: string,
    toSpace: string,
    via?: string,
  ): Promise<NoteView> {
    this.#assertAccess(principal, space)
    this.#assertAccess(principal, toSpace)
    if (toSpace === space) return this.get(principal, space, id)
    const path = notePath(id)
    if (await this.#exists(toSpace, path)) {
      throw new HearthError('conflict', `A note with id ${id} is already in ${toSpace}`)
    }
    for (let attempt = 1; ; attempt++) {
      const file = await this.#read(space, id)
      if (
        space === TEAM_SPACE &&
        toSpace !== TEAM_SPACE &&
        file.record.fm.created_by.toLowerCase() !== principal.email.toLowerCase()
      ) {
        throw new HearthError(
          'forbidden',
          'Only the person who wrote a team note can make it private',
        )
      }
      const name = noteName(file.record.fm.title ?? '', file.body)
      const added = await this.#commit(principal, toSpace, {
        changes: [{ path, content: file.content }],
        verb: 'move',
        title: name,
        via,
      })
      try {
        await this.#commit(principal, space, {
          changes: [{ path, content: null }],
          verb: 'move',
          title: name,
          via,
          unchanged: { path, blobOid: file.record.blobOid },
        })
        return this.#viewOf(toSpace, path, file.content, added)
      } catch (err) {
        if (!(err instanceof HearthError && err.code === 'conflict') || attempt >= WRITE_ATTEMPTS) {
          throw err
        }
        // Changed meanwhile: the next attempt rewrites the copy with the newer version.
      }
    }
  }

  /**
   * A one-time Google Keep import into the member's personal space, one commit. Notes whose
   * `ref` (the Takeout file name) was imported before are skipped, so running it again only adds
   * new ones.
   */
  async importKeep(
    principal: Principal,
    notes: Array<{ ref: string; note: KeepNote }>,
    via?: string,
  ): Promise<{ imported: number; skipped: number }> {
    // One at a time per member, so two overlapping imports can't both add the same notes.
    const key = principal.email.toLowerCase()
    const before = this.#importing.get(key) ?? Promise.resolve()
    const run = before.catch(() => {}).then(() => this.#importKeep(principal, notes, via))
    this.#importing.set(key, run)
    try {
      return await run
    } finally {
      if (this.#importing.get(key) === run) this.#importing.delete(key)
    }
  }

  async #importKeep(
    principal: Principal,
    notes: Array<{ ref: string; note: KeepNote }>,
    via?: string,
  ): Promise<{ imported: number; skipped: number }> {
    const space = await this.#personalSpace(principal)
    if (!space) throw new HearthError('forbidden', 'Your personal space isn’t ready yet')
    const done = new Set(
      this.#records([{ name: space }])
        .map((r) => r.fm.source)
        .filter((s) => s?.kind === 'import' && s.from === 'keep' && s.ref)
        .map((s) => s?.ref as string),
    )
    const now = isoNow(this.#now())
    const files: Array<{ path: string; content: string }> = []
    let skipped = 0
    for (const { ref, note } of notes) {
      const mapped = done.has(ref) ? null : mapKeepNote(note, ref)
      if (!mapped || files.length >= MAX_IMPORT_NOTES) {
        skipped++
        continue
      }
      done.add(ref)
      const created = mapped.created ?? now
      const file = newNoteFile({
        ...(mapped as Omit<NewNote, 'createdBy'>),
        created,
        updated: mapped.updated ?? created,
        createdBy: principal.email,
      })
      files.push({ path: file.path, content: file.text })
    }
    if (files.length > 0) {
      await this.#commit(principal, space, {
        changes: files,
        message: `notes: import ${files.length} from Google Keep`,
        via,
      })
    }
    return { imported: files.length, skipped }
  }

  // ── internals ────────────────────────────────────────────────────────────

  #trashCutoff(): string {
    return isoNow(new Date(this.#now().getTime() - TRASH_DAYS * DAY_MS))
  }

  #assertAccess(principal: Principal, space: string): void {
    if (!this.#spaces.canAccess(principal, space)) {
      throw new HearthError('forbidden', `You don't have access to the space "${space}"`)
    }
  }

  async #personalSpace(principal: Principal): Promise<string | null> {
    return personalOf(await this.#spaces.visibleSpaces(principal))?.name ?? null
  }

  #records(spaces: Pick<Space, 'name'>[]): NoteRecord[] {
    const out: NoteRecord[] = []
    for (const s of spaces) {
      for (const row of this.#index.listFiles({ space: s.name, kind: 'note' })) {
        const id = noteIdOf(row.path)
        const fm = id ? parseNote(row.frontmatter) : null
        if (id && fm) out.push({ space: s.name, path: row.path, id, blobOid: row.blobOid, fm })
      }
    }
    return out
  }

  #searchPaths(q: string, spaces: Space[]): Set<string> {
    const hits = this.#index.search(q, {
      spaces: spaces.map((s) => s.name),
      kinds: ['note'],
      limit: MAX_NOTE_LIST,
    })
    return new Set(hits.map((h) => `${h.space}\n${h.path}`))
  }

  async #read(
    space: string,
    id: string,
  ): Promise<{ content: string; record: NoteRecord; body: string }> {
    if (!NOTE_ID.test(id)) throw new HearthError('not_found', `No note ${id} in ${space}`)
    const path = notePath(id)
    let file: { content: string; blobOid: string }
    try {
      file = await this.#git.readFile(space, path)
    } catch (err) {
      if (err instanceof HearthError && err.code === 'not_found') {
        throw new HearthError('not_found', `No note ${id} in ${space}`)
      }
      throw err
    }
    let parsed: ReturnType<typeof parseFrontmatter>
    try {
      parsed = parseFrontmatter(file.content)
    } catch (err) {
      if (err instanceof FrontmatterError) throw new HearthError('bad_request', err.message)
      throw err
    }
    const fm = parseNote(parsed.data)
    if (!fm) throw new HearthError('bad_request', `${path} in ${space} isn’t a note`)
    return {
      content: file.content,
      record: { space, path, id, blobOid: file.blobOid, fm },
      body: noteTextOf(parsed.body),
    }
  }

  async #exists(space: string, path: string): Promise<boolean> {
    try {
      await this.#git.readFile(space, path)
      return true
    } catch (err) {
      if (err instanceof HearthError && err.code === 'not_found') return false
      throw err
    }
  }

  async #textAt(space: string, blobOid: string): Promise<{ title: string; body: string } | null> {
    try {
      const content = await this.#git.readBlobText(space, blobOid)
      const parsed = parseFrontmatter(content)
      const fm = parseNote(parsed.data)
      return fm ? { title: fm.title ?? '', body: noteTextOf(parsed.body) } : null
    } catch {
      return null
    }
  }

  /** Read → edit → commit, unchanged-guarded and retried on a concurrent change. */
  async #edit(
    principal: Principal,
    space: string,
    id: string,
    verb: string,
    via: string | undefined,
    edit: (
      cur: { content: string; fm: NoteFrontmatter; body: string },
      blobOid: string,
    ) => Promise<string | null>,
  ): Promise<NoteView> {
    for (let attempt = 1; ; attempt++) {
      const file = await this.#read(space, id)
      const cur = { content: file.content, fm: file.record.fm, body: file.body }
      let text: string | null
      try {
        text = await edit(cur, file.record.blobOid)
      } catch (err) {
        if (err instanceof FrontmatterError) throw new HearthError('bad_request', err.message)
        throw err
      }
      if (text === null) return toView(file.record, file.body)
      const parsed = parseFrontmatter(text)
      const title = noteName(parseNote(parsed.data)?.title ?? '', noteTextOf(parsed.body))
      try {
        const result = await this.#commit(principal, space, {
          changes: [{ path: file.record.path, content: text }],
          verb,
          title,
          via,
          unchanged: { path: file.record.path, blobOid: file.record.blobOid },
        })
        return this.#viewOf(space, file.record.path, text, result)
      } catch (err) {
        if (!(err instanceof HearthError && err.code === 'conflict') || attempt >= WRITE_ATTEMPTS) {
          throw err
        }
      }
    }
  }

  /** Moves notes into `.trash/` in one commit (each guarded), retried on a concurrent change. */
  async #purge(
    principal: Principal,
    space: string,
    ids: string[],
    verb: string,
    via: string | undefined,
    trashedBefore?: string,
  ): Promise<void> {
    const day = isoNow(this.#now()).slice(0, 10)
    for (let attempt = 1; ; attempt++) {
      let files = await Promise.all(ids.map((id) => this.#read(space, id)))
      // Emptying the trash: skip a note restored (or trashed again) since the index was read.
      if (trashedBefore !== undefined) {
        files = files.filter((f) => f.record.fm.trashed && f.record.fm.trashed < trashedBefore)
        if (files.length === 0) return
      }
      const changes: Array<{ path: string; content: string | null }> = []
      for (const file of files) {
        let trashPath = `${SPACE_LAYOUT.trash}/${day}/${file.record.path}`
        if (await this.#exists(space, trashPath)) {
          trashPath = `${SPACE_LAYOUT.trash}/${day}-${file.record.id.slice(-8)}/${file.record.path}`
        }
        changes.push({ path: trashPath, content: file.content })
        changes.push({ path: file.record.path, content: null })
      }
      const only = files.length === 1 ? files[0] : undefined
      try {
        await this.#commit(principal, space, {
          changes,
          ...(only
            ? {
                verb,
                title: noteName(only.record.fm.title ?? '', only.body),
                unchanged: { path: only.record.path, blobOid: only.record.blobOid },
              }
            : { message: `notes: ${verb} (${files.length} notes)` }),
          via,
        })
        return
      } catch (err) {
        if (!(err instanceof HearthError && err.code === 'conflict') || attempt >= WRITE_ATTEMPTS) {
          throw err
        }
      }
    }
  }

  async #commit(
    principal: Principal,
    space: string,
    args: {
      changes: Array<{ path: string; content: string | null }>
      verb?: string
      title?: string
      message?: string
      via: string | undefined
      unchanged?: { path: string; blobOid: string }
    },
  ): Promise<CommitResult> {
    const message = withVia(
      args.message ??
        formatCommitMessage({ app: 'notes', verb: args.verb ?? 'edit', title: args.title ?? '' }),
      args.via,
    )
    const result = await this.#git.commit(space, {
      changes: args.changes,
      author: { name: principal.name, email: principal.email },
      message,
      ...(args.unchanged ? { unchanged: args.unchanged } : {}),
    })
    await this.#syncer.afterHeadChanged(space)
    return result
  }

  #viewOf(space: string, path: string, text: string, result: CommitResult): NoteView {
    if (result.status === 'conflict') throw new HearthError('internal', 'Unexpected conflict')
    const parsed = parseFrontmatter(text)
    const fm = parseNote(parsed.data)
    const id = noteIdOf(path)
    if (!fm || !id) throw new HearthError('internal', `${path} isn’t a note after writing it`)
    return toView({ space, path, id, blobOid: result.blobOid, fm }, noteTextOf(parsed.body))
  }
}

/** The commit verb for a patch: pin, unpin, archive, unarchive, color, label, else edit. */
function verbFor(patch: NoteInput): string {
  const keys = Object.entries(patch)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k)
  if (keys.length === 1) {
    if (keys[0] === 'pinned') return patch.pinned ? 'pin' : 'unpin'
    if (keys[0] === 'archived') return patch.archived ? 'archive' : 'unarchive'
  }
  return 'edit'
}
