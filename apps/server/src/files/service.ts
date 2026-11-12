import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import {
  cleanFileName,
  cleanFolder,
  FILES_FOLDERS_PATH,
  FileFrontmatter,
  FrontmatterError,
  fileMimeType,
  filePointerPath,
  fileStoreKey,
  folderAncestors,
  isInFolder,
  newFilePointer,
  newId,
  type PreviewKind,
  parseFrontmatter,
  patchFrontmatter,
  previewKind,
  SPACE_LAYOUT,
} from '@hearth/format'
import { ulid } from 'ulid'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import { type Change, formatCommitMessage, type GitStore, withVia } from '../git/index.js'
import type { Index } from '../index/index.js'
import { type AudioStore, LocalAudioStore, R2AudioStore } from '../meetings/audio/index.js'
import { type SpaceService, TEAM_SPACE } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'
import { type Extracted, extractText } from './extract.js'

export const MAX_FILE_BYTES = 2 * 1024 ** 3
/** Each upload chunk; under the API's 12 MB body limit. */
export const CHUNK_BYTES = 8 * 1024 * 1024
export const MAX_CHUNKS = Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES)
const MAX_LIST = 5000
/** An upload nobody finished in this long was abandoned; its chunks are removed. */
const ABANDONED_MS = 24 * 3_600_000
/** Free space the data volume keeps for git and SQLite: uploads stop below it. */
const MIN_FREE_BYTES = 1024 ** 3
const MAX_OPEN_UPLOADS = 20
const URL_WINDOW_SECONDS = 3600
const WRITE_ATTEMPTS = 3
const FILE_ID = /^[0-9A-Z]{26}$/

export interface FileView {
  id: string
  space: string
  path: string
  name: string
  folder: string
  size: number
  mime: string
  sha256: string
  preview: PreviewKind
  createdAt: string
  createdBy: string
  updatedAt: string
  textStatus: FileFrontmatter['text']
  /** The share link's token while sharing is on. */
  shareToken: string | null
  blobOid: string
  /** Where the bytes are in the object store. */
  key: string
}

export interface FolderListing {
  space: string
  folder: string
  /** Direct subfolders of `folder`, as full paths. */
  folders: string[]
  files: FileView[]
}

interface UploadMeta {
  id: string
  owner: string
  space: string
  folder: string
  name: string
  mime: string
  size: number
  createdAt: number
}

export interface FilesDeps {
  git: GitStore
  index: Pick<Index, 'listFiles' | 'search' | 'listSpaces'>
  spaces: Pick<SpaceService, 'visibleSpaces' | 'canAccess'>
  syncer: Pick<Syncer, 'afterHeadChanged'>
  /** Where the bytes go; null means Files isn't available on this server. */
  store: AudioStore | null
  dataDir: string
  now?: () => Date
  freeBytes?: () => Promise<number>
}

/** Hearth Files' locally stored bytes: the path every signed request to them starts with. */
export const FILE_MEDIA_PREFIX = '/api/files/media/'

export interface LocalMedia {
  path: string
  size: number
  mime: string
  name: string
  inline: boolean
}

/**
 * Hearth Files on the server (ARCHITECTURE §18): bytes in the object store, one pointer file
 * per file in Git, listed from the index. Every write is a commit authored by the member.
 */
export class Files {
  readonly #deps: FilesDeps
  readonly #now: () => Date
  readonly #uploadRoot: string
  readonly #mediaKey = randomBytes(32)
  #swept = 0
  /** Uploads being finished now, and the last few finished, so a repeat complete is safe. */
  readonly #completing = new Map<string, Promise<FileView>>()
  readonly #completed = new Map<string, { owner: string; space: string; fileId: string }>()

  constructor(deps: FilesDeps) {
    this.#deps = deps
    this.#now = deps.now ?? (() => new Date())
    this.#uploadRoot = path.join(deps.dataDir, 'file-uploads')
  }

  get available(): boolean {
    return this.#deps.store !== null
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** One folder of one space: its subfolders and files. With `q`, matches anywhere in the space. */
  async list(
    principal: Principal,
    opts: { space?: string | undefined; folder?: string | undefined; q?: string | undefined },
  ): Promise<FolderListing> {
    const space = opts.space ?? TEAM_SPACE
    this.#assertAccess(principal, space)
    const folder = cleanFolder(opts.folder ?? '')
    const all = this.#records(space)
    const q = opts.q?.trim()
    if (q) {
      const hits = this.#deps.index.search(q, { spaces: [space], kinds: ['file'], limit: 200 })
      const byPath = new Map(all.map((f) => [f.path, f]))
      const nameHits = all.filter((f) => f.name.toLowerCase().includes(q.toLowerCase()))
      const seen = new Set<string>()
      const files: FileView[] = []
      for (const f of [...nameHits, ...hits.map((h) => byPath.get(h.path))]) {
        if (f && !seen.has(f.path) && isInFolder(f.folder, folder)) {
          seen.add(f.path)
          files.push(f)
        }
      }
      return { space, folder, folders: [], files }
    }
    const known = new Set<string>(await this.#savedFolders(space))
    for (const f of all) for (const a of folderAncestors(f.folder)) known.add(a)
    const depth = folder === '' ? 0 : folder.split('/').length
    const folders = [...known]
      .filter((f) => isInFolder(f, folder) && f !== folder && f.split('/').length === depth + 1)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))
    const files = all
      .filter((f) => f.folder === folder)
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
      )
    return { space, folder, folders, files }
  }

  /** The member's most recent files across their spaces. */
  async recent(principal: Principal, limit = 50): Promise<FileView[]> {
    const spaces = await this.#deps.spaces.visibleSpaces(principal)
    return spaces
      .flatMap((s) => this.#records(s.name))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
  }

  async get(principal: Principal, space: string, id: string): Promise<FileView> {
    this.#assertAccess(principal, space)
    return (await this.#read(space, id)).view
  }

  /** The text pulled from the file, as the pointer keeps it. */
  async text(principal: Principal, space: string, id: string): Promise<string> {
    this.#assertAccess(principal, space)
    return (await this.#read(space, id)).body.trim()
  }

  /** A file by its share token, for any signed-in member. */
  async shared(token: string): Promise<FileView> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw notShared()
    for (const space of this.#allSpaceNames()) {
      for (const row of this.#deps.index.listFiles({ space, kind: 'file' })) {
        if (row.frontmatter?.share !== token) continue
        const id = row.path.slice('files/'.length, -'.md'.length)
        // Re-read from Git so a revoke is honored even before the index catches up.
        const file = await this.#read(space, id).catch(() => null)
        if (file?.view.shareToken === token) return file.view
      }
    }
    throw notShared()
  }

  /**
   * URLs the browser can open without Hearth's credentials (an <img> or <video> can't send a
   * bearer token): presigned R2 in production, so bytes never pass through this server;
   * HMAC-signed and served here with the local store. Only made for someone already allowed.
   */
  async urls(view: FileView): Promise<{ contentUrl: string; downloadUrl: string }> {
    const store = this.#store()
    if (store instanceof R2AudioStore) {
      const sign = (inline: boolean) =>
        store.presignGet(view.key, {
          windowSeconds: URL_WINDOW_SECONDS,
          ...(inline ? { inline: view.mime } : { download: view.name }),
          now: this.#now(),
        })
      const downloadUrl = await sign(false)
      return { contentUrl: view.preview === 'none' ? downloadUrl : await sign(true), downloadUrl }
    }
    const local = (download: boolean) => {
      const windowMs = URL_WINDOW_SECONDS * 1000
      const exp = (Math.floor(this.#now().getTime() / windowMs) + 2) * (windowMs / 1000)
      const params = new URLSearchParams({ exp: String(exp) })
      if (download) params.set('download', '1')
      params.set('sig', this.#sign(view.space, view.id, exp, download))
      return `${FILE_MEDIA_PREFIX}${encodeURIComponent(view.space)}/${view.id}?${params}`
    }
    return { contentUrl: local(false), downloadUrl: local(true) }
  }

  #sign(space: string, id: string, exp: number, download: boolean): string {
    return createHmac('sha256', this.#mediaKey)
      .update(`${space}\n${id}\n${exp}\n${download ? 1 : 0}`)
      .digest('base64url')
  }

  /** The bytes behind a signed URL from `urls`; not_found for a bad or expired signature. */
  async localMedia(req: {
    space: string
    id: string
    exp: number
    sig: string
    download: boolean
  }): Promise<LocalMedia> {
    const refused = new HearthError('not_found', 'This link has expired; reload the page')
    const store = this.#deps.store
    if (!(store instanceof LocalAudioStore)) throw refused
    const expected = Buffer.from(this.#sign(req.space, req.id, req.exp, req.download))
    const given = Buffer.from(req.sig)
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw refused
    if (req.exp * 1000 < this.#now().getTime()) throw refused
    const view = (await this.#read(req.space, req.id).catch(() => null))?.view
    if (!view) throw refused
    const file = store.pathOf(view.key)
    const size = (await stat(file).catch(() => null))?.size
    if (size === undefined) throw refused
    const inline = !req.download && view.preview !== 'none'
    return { path: file, size, mime: view.mime, name: view.name, inline }
  }

  // ── uploads ──────────────────────────────────────────────────────────────

  async startUpload(
    principal: Principal,
    input: {
      space: string
      folder?: string | undefined
      name: string
      size: number
      mime?: string | undefined
    },
  ): Promise<{ id: string; chunkBytes: number; chunks: number }> {
    this.#store()
    this.#assertAccess(principal, input.space)
    if (!Number.isInteger(input.size) || input.size < 0 || input.size > MAX_FILE_BYTES) {
      throw new HearthError('bad_request', 'A file can be at most 2 GB', { status: 413 })
    }
    await this.#sweep()
    const open = await this.#openUploads(principal.email)
    if (open >= MAX_OPEN_UPLOADS) {
      throw new HearthError('conflict', 'Too many uploads at once; wait for some to finish')
    }
    await this.#ensureRoom(input.size)
    const name = cleanFileName(input.name)
    const meta: UploadMeta = {
      id: ulid(),
      owner: principal.email.toLowerCase(),
      space: input.space,
      folder: cleanFolder(input.folder ?? ''),
      name,
      mime: fileMimeType(name, input.mime),
      size: input.size,
      createdAt: this.#now().getTime(),
    }
    const dir = this.#uploadDir(meta.id)
    await mkdir(dir, { recursive: true })
    const tmpMeta = path.join(dir, 'meta.json.tmp')
    await writeFile(tmpMeta, JSON.stringify(meta))
    await rename(tmpMeta, path.join(dir, 'meta.json'))
    return { id: meta.id, chunkBytes: CHUNK_BYTES, chunks: chunkCount(meta.size) }
  }

  async putChunk(principal: Principal, id: string, seq: number, bytes: Uint8Array): Promise<void> {
    const meta = await this.#upload(principal, id)
    const chunks = chunkCount(meta.size)
    if (!Number.isInteger(seq) || seq < 0 || seq >= chunks) {
      throw new HearthError('bad_request', `This upload has chunks 0 to ${chunks - 1}`)
    }
    const expected = seq === chunks - 1 ? meta.size - seq * CHUNK_BYTES : CHUNK_BYTES
    if (bytes.length !== expected) {
      throw new HearthError('bad_request', `Chunk ${seq} should be ${expected} bytes`)
    }
    const file = path.join(this.#uploadDir(id), `${String(seq).padStart(6, '0')}.part`)
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, bytes)
    await rename(tmp, file)
  }

  /**
   * Joins the chunks, hashes and reads the file, stores it and commits its pointer. A repeat call
   * (a retry, a second tab) waits for the first and gets the same file; a failure keeps the
   * chunks so it can be retried.
   */
  async completeUpload(principal: Principal, id: string, via?: string): Promise<FileView> {
    const done = this.#completed.get(id)
    if (done && done.owner === principal.email.toLowerCase()) {
      return (await this.#read(done.space, done.fileId)).view
    }
    const running = this.#completing.get(id)
    if (running) return running
    const job = this.#complete(principal, id, via).finally(() => this.#completing.delete(id))
    this.#completing.set(id, job)
    return job
  }

  async #complete(principal: Principal, id: string, via?: string): Promise<FileView> {
    const meta = await this.#upload(principal, id)
    this.#assertAccess(principal, meta.space)
    const dir = this.#uploadDir(id)
    const chunks = chunkCount(meta.size)
    const present = new Set(await readdir(dir))
    const missing: number[] = []
    for (let s = 0; s < chunks; s++) {
      if (!present.has(`${String(s).padStart(6, '0')}.part`)) missing.push(s)
    }
    if (missing.length > 0) {
      throw new HearthError('conflict', `Chunks ${missing.slice(0, 10).join(', ')} haven’t arrived`)
    }
    const whole = path.join(dir, 'whole')
    const hash = createHash('sha256')
    const out = createWriteStream(whole)
    try {
      for (let s = 0; s < chunks; s++) {
        const part = path.join(dir, `${String(s).padStart(6, '0')}.part`)
        for await (const chunk of createReadStream(part)) {
          hash.update(chunk as Buffer)
          if (!out.write(chunk)) await once(out, 'drain')
        }
      }
      out.end()
      await finished(out)
      const size = (await stat(whole)).size
      if (size !== meta.size)
        throw new HearthError('bad_request', 'The upload’s size doesn’t match')
      const sha256 = hash.digest('hex')
      const extracted: Extracted = await extractText(whole, meta.name, meta.mime, size)
      const pointer = newFilePointer({
        name: meta.name,
        folder: meta.folder,
        size,
        sha256,
        mime: meta.mime,
        createdBy: principal.email,
        created: isoNow(this.#now()),
        text: extracted.status === 'extracted' ? extracted.text : null,
        textStatus: extracted.status,
      })
      const key = fileStoreKey(pointer.id)
      await this.#store().put(key, createReadStream(whole), size, meta.mime)
      try {
        await this.#commit(principal, meta.space, {
          changes: [{ path: pointer.path, content: pointer.text }],
          verb: 'upload',
          title: meta.name,
          via,
        })
      } catch (err) {
        await this.#store()
          .delete(key)
          .catch(() => {})
        throw err
      }
      this.#remember(id, { owner: meta.owner, space: meta.space, fileId: pointer.id })
      await rm(dir, { recursive: true, force: true })
      return (await this.#read(meta.space, pointer.id)).view
    } finally {
      out.destroy()
      // On failure the chunks stay for a retry (the sweep removes them after a day).
      await rm(whole, { force: true })
    }
  }

  #remember(uploadId: string, done: { owner: string; space: string; fileId: string }): void {
    this.#completed.set(uploadId, done)
    if (this.#completed.size > 500) {
      const oldest = this.#completed.keys().next().value
      if (oldest !== undefined) this.#completed.delete(oldest)
    }
  }

  async cancelUpload(principal: Principal, id: string): Promise<void> {
    if (this.#completing.has(id) || this.#completed.has(id)) return
    await this.#upload(principal, id)
    await rm(this.#uploadDir(id), { recursive: true, force: true })
  }

  // ── writes ───────────────────────────────────────────────────────────────

  /** Renames a file, moves it to another folder, or both. */
  async update(
    principal: Principal,
    space: string,
    id: string,
    patch: { name?: string | undefined; folder?: string | undefined },
    via?: string,
  ): Promise<FileView> {
    this.#assertAccess(principal, space)
    const name = patch.name === undefined ? undefined : cleanFileName(patch.name)
    const folder = patch.folder === undefined ? undefined : cleanFolder(patch.folder)
    return this.#edit(principal, space, id, via, (cur) => {
      const fields: Record<string, unknown> = {}
      if (name !== undefined && name !== cur.view.name) {
        fields.title = name
        fields.mime = fileMimeType(name, cur.view.mime)
      }
      if (folder !== undefined && folder !== cur.view.folder) fields.folder = folder
      if (Object.keys(fields).length === 0) return null
      fields.updated = isoNow(this.#now())
      const verb = fields.title !== undefined ? 'rename' : 'move'
      return { text: patchFrontmatter(cur.content, fields), verb, title: name ?? cur.view.name }
    })
  }

  /** Turns the share link on (returning its token) or off. */
  async setShared(
    principal: Principal,
    space: string,
    id: string,
    on: boolean,
    via?: string,
  ): Promise<FileView> {
    this.#assertAccess(principal, space)
    return this.#edit(principal, space, id, via, (cur) => {
      if (on === (cur.view.shareToken !== null)) return null
      const share = on ? randomBytes(18).toString('base64url') : undefined
      return {
        text: patchFrontmatter(cur.content, { share }),
        verb: on ? 'share' : 'unshare',
        title: cur.view.name,
      }
    })
  }

  /** Moves the pointer between the team space and the member's personal space. */
  async moveSpace(
    principal: Principal,
    space: string,
    id: string,
    to: string,
    via?: string,
  ): Promise<FileView> {
    this.#assertAccess(principal, space)
    this.#assertAccess(principal, to)
    if (to === space) return this.get(principal, space, id)
    const file = await this.#read(space, id)
    const target = (await this.#deps.spaces.visibleSpaces(principal)).find((s) => s.name === to)
    if (target?.kind === 'personal' && file.view.createdBy !== principal.email.toLowerCase()) {
      throw new HearthError(
        'forbidden',
        'Only the person who uploaded a team file can make it private',
      )
    }
    // Lands in the target's top folder; the share link stays with the file.
    const text = patchFrontmatter(file.content, { folder: '', updated: isoNow(this.#now()) })
    await this.#commit(principal, to, {
      changes: [{ path: file.view.path, content: text }],
      verb: 'move in',
      title: file.view.name,
      via,
    })
    try {
      // Refused if someone changed it in the old space meanwhile; then the copy is taken back.
      await this.#commit(principal, space, {
        changes: [{ path: file.view.path, content: null }],
        verb: 'move out',
        title: file.view.name,
        via,
        unchanged: { path: file.view.path, blobOid: file.view.blobOid },
      })
    } catch (err) {
      await this.#commit(principal, to, {
        changes: [{ path: file.view.path, content: null }],
        verb: 'move back',
        title: file.view.name,
        via,
      }).catch(() => {})
      throw err
    }
    return (await this.#read(to, id)).view
  }

  /** Moves the pointer to `.trash/`. The bytes stay in the store for now (see §18.5). */
  async remove(principal: Principal, space: string, id: string, via?: string): Promise<void> {
    this.#assertAccess(principal, space)
    const file = await this.#read(space, id)
    await this.#commit(principal, space, {
      changes: trashChanges(file.view.path, file.content, this.#now()),
      verb: 'delete',
      title: file.view.name,
      via,
    })
  }

  async createFolder(principal: Principal, space: string, folder: string, via?: string) {
    this.#assertAccess(principal, space)
    const clean = cleanFolder(folder)
    if (!clean) throw new HearthError('bad_request', 'A folder needs a name')
    const saved = await this.#savedFolders(space)
    if (saved.includes(clean)) return { folder: clean }
    await this.#commit(principal, space, {
      changes: [{ path: FILES_FOLDERS_PATH, content: foldersJson([...saved, clean]) }],
      verb: 'new folder',
      title: clean,
      via,
    })
    return { folder: clean }
  }

  /** Renames a folder: every file and folder under it moves, in one commit. */
  async renameFolder(principal: Principal, space: string, from: string, to: string, via?: string) {
    this.#assertAccess(principal, space)
    const a = cleanFolder(from)
    const b = cleanFolder(to)
    if (!a || !b) throw new HearthError('bad_request', 'A folder needs a name')
    if (a === b) return { folder: b }
    if (isInFolder(b, a)) throw new HearthError('bad_request', 'A folder can’t move inside itself')
    const moved = (p: string) => (p === a ? b : `${b}${p.slice(a.length)}`)
    const changes: Change[] = []
    for (const f of this.#records(space).filter((f) => isInFolder(f.folder, a))) {
      const cur = await this.#read(space, f.id)
      changes.push({
        path: f.path,
        content: patchFrontmatter(cur.content, { folder: moved(f.folder) }),
      })
    }
    const saved = await this.#savedFolders(space)
    const next = saved.map((s) => (isInFolder(s, a) ? moved(s) : s))
    if (!next.includes(b)) next.push(b)
    changes.push({ path: FILES_FOLDERS_PATH, content: foldersJson(next) })
    await this.#commit(principal, space, {
      changes,
      verb: 'rename folder',
      title: `${a} → ${b}`,
      via,
    })
    return { folder: b }
  }

  /** Deletes a folder and everything in it (pointers go to `.trash/`), in one commit. */
  async removeFolder(principal: Principal, space: string, folder: string, via?: string) {
    this.#assertAccess(principal, space)
    const clean = cleanFolder(folder)
    if (!clean) throw new HearthError('bad_request', 'Choose a folder')
    const changes: Change[] = []
    for (const f of this.#records(space).filter((f) => isInFolder(f.folder, clean))) {
      const cur = await this.#read(space, f.id)
      changes.push(...trashChanges(f.path, cur.content, this.#now()))
    }
    const saved = await this.#savedFolders(space)
    const next = saved.filter((s) => !isInFolder(s, clean))
    if (next.length !== saved.length) {
      changes.push({ path: FILES_FOLDERS_PATH, content: foldersJson(next) })
    }
    if (changes.length === 0) return
    await this.#commit(principal, space, { changes, verb: 'delete folder', title: clean, via })
  }

  // ── internals ────────────────────────────────────────────────────────────

  #store(): AudioStore {
    if (!this.#deps.store) throw new HearthError('not_found', 'Files isn’t set up on this server')
    return this.#deps.store
  }

  #assertAccess(principal: Principal, space: string): void {
    if (!this.#deps.spaces.canAccess(principal, space)) {
      throw new HearthError('forbidden', `You don't have access to the space "${space}"`)
    }
  }

  #allSpaceNames(): string[] {
    const names = this.#deps.index.listSpaces().map((r) => r.name)
    return names.includes(TEAM_SPACE) ? names : [TEAM_SPACE, ...names]
  }

  #records(space: string): FileView[] {
    const out: FileView[] = []
    for (const row of this.#deps.index.listFiles({ space, kind: 'file' }).slice(0, MAX_LIST)) {
      const view = toView(space, row.path, row.blobOid, row.frontmatter)
      if (view) out.push(view)
    }
    return out
  }

  async #read(space: string, id: string) {
    if (!FILE_ID.test(id)) throw new HearthError('not_found', `No file ${id}`)
    const p = filePointerPath(id)
    let file: { content: string; blobOid: string }
    try {
      file = await this.#deps.git.readFile(space, p)
    } catch (err) {
      if (err instanceof HearthError && err.code === 'not_found') {
        throw new HearthError('not_found', `No file ${id} in ${space}`)
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
    const fm = FileFrontmatter.safeParse(parsed.data)
    const view = fm.success ? toView(space, p, file.blobOid, parsed.data) : null
    if (!fm.success || !view) throw new HearthError('bad_request', `${p} isn’t a Hearth file`)
    return { content: file.content, body: parsed.body, fm: fm.data, view }
  }

  async #edit(
    principal: Principal,
    space: string,
    id: string,
    via: string | undefined,
    edit: (cur: {
      content: string
      view: FileView
    }) => { text: string; verb: string; title: string } | null,
  ): Promise<FileView> {
    for (let attempt = 1; ; attempt++) {
      const cur = await this.#read(space, id)
      const next = edit(cur)
      if (next === null) return cur.view
      try {
        await this.#commit(principal, space, {
          changes: [{ path: cur.view.path, content: next.text }],
          verb: next.verb,
          title: next.title,
          via,
          unchanged: { path: cur.view.path, blobOid: cur.view.blobOid },
        })
        return (await this.#read(space, id)).view
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
      changes: Change[]
      verb: string
      title: string
      via: string | undefined
      unchanged?: { path: string; blobOid: string }
    },
  ): Promise<void> {
    const result = await this.#deps.git.commit(space, {
      changes: args.changes,
      author: { name: principal.name, email: principal.email },
      message: withVia(
        formatCommitMessage({ app: 'files', verb: args.verb, title: args.title }),
        args.via,
      ),
      ...(args.unchanged ? { unchanged: args.unchanged } : {}),
    })
    if (result.status === 'conflict') {
      throw new HearthError('conflict', 'Someone changed this file at the same time; try again')
    }
    await this.#deps.syncer.afterHeadChanged(space)
  }

  async #savedFolders(space: string): Promise<string[]> {
    try {
      const { content } = await this.#deps.git.readFile(space, FILES_FOLDERS_PATH)
      const parsed = JSON.parse(content) as unknown
      const list = Array.isArray(parsed) ? parsed : (parsed as { folders?: unknown })?.folders
      return Array.isArray(list)
        ? [
            ...new Set(list.filter((f): f is string => typeof f === 'string').map(cleanFolder)),
          ].filter(Boolean)
        : []
    } catch {
      return []
    }
  }

  #uploadDir(id: string): string {
    if (!FILE_ID.test(id)) throw new HearthError('not_found', 'No such upload')
    return path.join(this.#uploadRoot, id)
  }

  async #upload(principal: Principal, id: string): Promise<UploadMeta> {
    const raw = await readFile(path.join(this.#uploadDir(id), 'meta.json'), 'utf8').catch(
      () => null,
    )
    const meta = raw ? (JSON.parse(raw) as UploadMeta) : null
    if (!meta || meta.owner !== principal.email.toLowerCase()) {
      throw new HearthError('not_found', 'No such upload')
    }
    return meta
  }

  /** Every upload's record on the volume; unreadable ones are skipped. */
  async #uploadMetas(): Promise<UploadMeta[]> {
    const out: UploadMeta[] = []
    for (const id of await readdir(this.#uploadRoot).catch(() => [] as string[])) {
      const meta = await readMeta(path.join(this.#uploadRoot, id))
      if (meta) out.push(meta)
    }
    return out
  }

  async #openUploads(owner: string): Promise<number> {
    const who = owner.toLowerCase()
    return (await this.#uploadMetas()).filter((m) => m.owner === who).length
  }

  /** Removes uploads abandoned for a day; at most once an hour. */
  async #sweep(): Promise<void> {
    const now = this.#now().getTime()
    if (now - this.#swept < 3_600_000) return
    this.#swept = now
    for (const id of await readdir(this.#uploadRoot).catch(() => [] as string[])) {
      const dir = path.join(this.#uploadRoot, id)
      if (this.#completing.has(id)) continue
      const meta = await readMeta(dir)
      const created = meta
        ? meta.createdAt
        : await stat(dir).then(
            (st) => st.mtimeMs,
            () => 0,
          )
      if (now - created > ABANDONED_MS) await rm(dir, { recursive: true, force: true })
    }
  }

  async #ensureRoom(size: number): Promise<void> {
    const free = this.#deps.freeBytes
      ? await this.#deps.freeBytes()
      : await statfs(this.#deps.dataDir).then(
          (s) => s.bavail * s.bsize,
          () => Number.POSITIVE_INFINITY,
        )
    // Chunks and the joined file both sit on the volume until the store has them (and the local
    // store keeps a third copy), for this upload and every other one still open.
    const copies = this.#deps.store instanceof LocalAudioStore ? 3 : 2
    const pending = (await this.#uploadMetas()).reduce((n, m) => n + m.size, 0)
    if (free - copies * (size + pending) < MIN_FREE_BYTES) {
      throw new HearthError(
        'conflict',
        'The server’s disk is too full for this upload right now. Try a smaller file, or ask an admin to add storage.',
      )
    }
  }
}

async function readMeta(dir: string): Promise<UploadMeta | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8')) as UploadMeta
  } catch {
    return null
  }
}

function chunkCount(size: number): number {
  return Math.max(1, Math.ceil(size / CHUNK_BYTES))
}

function notShared(): HearthError {
  return new HearthError('not_found', 'This link has been turned off, or the file was deleted')
}

function isoNow(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function foldersJson(folders: string[]): string {
  const unique = [...new Set(folders.map(cleanFolder).filter(Boolean))].sort()
  return `${JSON.stringify({ folders: unique }, null, 2)}\n`
}

function trashChanges(p: string, content: string, now: Date): Change[] {
  const day = now.toISOString().slice(0, 10)
  return [
    { path: p, content: null },
    { path: `${SPACE_LAYOUT.trash}/${day}-${newId().slice(-8)}/${p}`, content },
  ]
}

function toView(
  space: string,
  p: string,
  blobOid: string,
  frontmatter: Record<string, unknown> | null,
): FileView | null {
  const parsed = FileFrontmatter.safeParse(frontmatter ?? {})
  if (!parsed.success) return null
  const fm = parsed.data
  const id = p.slice('files/'.length, -'.md'.length)
  if (fm.id !== id) return null
  return {
    id,
    space,
    path: p,
    name: fm.title,
    folder: fm.folder,
    size: fm.size,
    mime: fm.mime,
    sha256: fm.sha256,
    preview: previewKind(fm.mime),
    createdAt: fm.created,
    createdBy: fm.created_by,
    updatedAt: fm.updated ?? fm.created,
    textStatus: fm.text,
    shareToken: fm.share ?? null,
    blobOid,
    // Always from the id: a pointer's own `key` is never trusted to name what it reads.
    key: fileStoreKey(fm.id),
  }
}
