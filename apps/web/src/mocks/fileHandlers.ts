// MSW routes for Hearth Files (`/api/files`, ARCHITECTURE §18.2), in memory and shaped like the
// server's (apps/server/src/files, api/drive.ts). Bytes stay in the page: an object URL serves
// each file with its type, so image, PDF and text previews show the real thing.

import {
  cleanFileName,
  cleanFolder,
  fileMimeType,
  filePointerPath,
  folderAncestors,
  isInFolder,
  newId,
  previewKind,
} from '@hearth/format'
import { type AnyHandler, delay, HttpResponse, http } from 'msw'
import type { DriveFile, SharedFile } from '../api/files'
import { type FakeUser, fakeOid } from './fakeRepo'
import { type SeedFile, seedFileContents } from './fileSeed'
import { ADA, PRIYA, SAM, seedId } from './seed'

export const MOCK_CHUNK_BYTES = 8 * 1024 * 1024
/** Everything lives in the visitor's tab, a few copies per file, so uploads stay small. */
export const MOCK_MAX_FILE_BYTES = 25 * 1024 * 1024
const DAY = 86_400_000
const ID = /^[0-9A-Z]{26}$/
const TEXT_PREVIEW_LIMIT = 200_000

const error = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message } }, { status })

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** A stored file: what the pointer says, plus its bytes. */
export interface FakeFile {
  id: string
  space: string
  name: string
  folder: string
  mime: string
  sha256: string
  createdAt: string
  createdBy: string
  updatedAt: string
  shareToken: string | null
  blobOid: string
  bytes: Uint8Array
  text: string
}

interface Upload {
  owner: string
  space: string
  folder: string
  name: string
  mime: string
  size: number
  chunks: Map<number, Uint8Array>
}

function textOf(mime: string, bytes: Uint8Array): string {
  if (previewKind(mime) !== 'text') return ''
  return new TextDecoder().decode(bytes).slice(0, TEXT_PREVIEW_LIMIT).trim()
}

export class FakeFiles {
  /** Upload chunk size; tests make it small. */
  chunkBytes = MOCK_CHUNK_BYTES
  readonly files = new Map<string, FakeFile>()
  /** Folders made with "New folder", per space, so empty ones still show. */
  readonly folders = new Map<string, Set<string>>()
  readonly uploads = new Map<string, Upload>()
  readonly #urls = new Map<string, { contentUrl: string; downloadUrl: string }>()

  key(space: string, id: string): string {
    return `${space}/${id}`
  }

  chunkCount(size: number): number {
    return Math.max(1, Math.ceil(size / this.chunkBytes))
  }

  get(space: string, id: string): FakeFile | undefined {
    return this.files.get(this.key(space, id))
  }

  inSpace(space: string): FakeFile[] {
    return [...this.files.values()].filter((f) => f.space === space)
  }

  savedFolders(space: string): Set<string> {
    let set = this.folders.get(space)
    if (!set) {
      set = new Set()
      this.folders.set(space, set)
    }
    return set
  }

  /** Stores a file, like a finished upload. */
  add(input: {
    space: string
    folder: string
    name: string
    bytes: Uint8Array
    by: string
    mime?: string
    at?: number
    text?: string
    id?: string
  }): FakeFile {
    const name = cleanFileName(input.name)
    const mime = fileMimeType(name, input.mime)
    const at = iso(input.at ?? Date.now())
    const id = input.id ?? newId()
    const file: FakeFile = {
      id,
      space: input.space,
      name,
      folder: cleanFolder(input.folder),
      mime,
      sha256: fakeOid(`${name}${input.bytes.length}`).padEnd(64, '0').slice(0, 64),
      createdAt: at,
      createdBy: input.by.toLowerCase(),
      updatedAt: at,
      shareToken: null,
      blobOid: newId().toLowerCase(),
      bytes: input.bytes,
      text: input.text ?? textOf(mime, input.bytes),
    }
    this.files.set(this.key(file.space, id), file)
    return file
  }

  /** A new version id after a change to the pointer. */
  touch(file: FakeFile): void {
    file.updatedAt = iso(Date.now())
    file.blobOid = newId().toLowerCase()
  }

  remove(file: FakeFile): void {
    this.files.delete(this.key(file.space, file.id))
    this.resetUrls(file)
  }

  /** Drops the file's URLs (it moved, changed type or went), so the next view makes fresh ones. */
  resetUrls(file: FakeFile): void {
    const urls = this.#urls.get(file.id)
    if (urls && typeof URL.revokeObjectURL === 'function') {
      for (const u of [urls.contentUrl, urls.downloadUrl]) {
        if (u.startsWith('blob:')) URL.revokeObjectURL(u)
      }
    }
    this.#urls.delete(file.id)
  }

  /**
   * Where the browser reads the bytes. An object URL in a browser: an `<iframe>` or a download
   * link is a navigation, which the mock's service worker never sees. Elsewhere (tests), the
   * mock's own media route.
   */
  urls(file: FakeFile): { contentUrl: string; downloadUrl: string } {
    const cached = this.#urls.get(file.id)
    if (cached) return cached
    let urls: { contentUrl: string; downloadUrl: string }
    if (typeof URL.createObjectURL === 'function') {
      const bytes = file.bytes as Uint8Array<ArrayBuffer>
      const downloadUrl = URL.createObjectURL(
        new Blob([bytes], { type: 'application/octet-stream' }),
      )
      const contentUrl =
        previewKind(file.mime) === 'none'
          ? downloadUrl
          : URL.createObjectURL(new Blob([bytes], { type: file.mime }))
      urls = { contentUrl, downloadUrl }
    } else {
      const base = `/api/files/media/${encodeURIComponent(file.space)}/${file.id}`
      urls = { contentUrl: base, downloadUrl: `${base}?download=1` }
    }
    this.#urls.set(file.id, urls)
    return urls
  }

  view(file: FakeFile): DriveFile {
    return {
      id: file.id,
      space: file.space,
      path: filePointerPath(file.id),
      name: file.name,
      folder: file.folder,
      size: file.bytes.length,
      mime: file.mime,
      sha256: file.sha256,
      preview: previewKind(file.mime),
      createdAt: file.createdAt,
      createdBy: file.createdBy,
      updatedAt: file.updatedAt,
      textStatus: file.text ? 'extracted' : 'none',
      shareToken: file.shareToken,
      blobOid: file.blobOid,
      url: `/files/${encodeURIComponent(file.space)}/${file.id}`,
      shareUrl: file.shareToken ? `/files/s/${file.shareToken}` : null,
      ...this.urls(file),
    }
  }

  sharedView(file: FakeFile): SharedFile {
    return {
      id: file.id,
      name: file.name,
      size: file.bytes.length,
      mime: file.mime,
      preview: previewKind(file.mime),
      createdAt: file.createdAt,
      createdBy: file.createdBy,
      updatedAt: file.updatedAt,
      ...this.urls(file),
    }
  }
}

function shareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** The team's sample files (fileSeed.ts). */
export function seedFiles(fake: FakeFiles, now = Date.now()): void {
  const list: SeedFile[] = seedFileContents({ ada: ADA.email, priya: PRIYA.email, sam: SAM.email })
  for (const [i, s] of list.entries()) {
    const file = fake.add({
      id: seedId('FS', i + 1),
      space: 'team',
      folder: s.folder,
      name: s.name,
      bytes: s.bytes,
      by: s.by,
      at: now - s.daysAgo * DAY,
      text: s.text,
    })
    if (s.shared) file.shareToken = `demo-share-${file.id.toLowerCase()}`
  }
  fake.savedFolders('team').add('Brand')
}

export interface FileHandlerDeps {
  files: FakeFiles
  latencyMs: number
  principal: (request: Request) => FakeUser | Response
}

export function fileHandlers(deps: FileHandlerDeps): AnyHandler[] {
  const { files: fake, principal } = deps
  const wait = () => (deps.latencyMs > 0 ? delay(deps.latencyMs) : Promise.resolve())
  const canAccess = (user: FakeUser, space: string) => space === 'team' || space === user.handle
  const forbidden = (space: string) =>
    error(403, 'forbidden', `You don't have access to the space "${space}"`)

  type Args = { request: Request; user: FakeUser; params: Record<string, unknown>; url: URL }
  const authed =
    (fn: (args: Args) => Response | Promise<Response>) =>
    async ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      return fn({ request, user, params, url: new URL(request.url) })
    }

  /** The file at `/item/:space/:id`, or the error to answer with. */
  const item = (user: FakeUser, params: Record<string, unknown>): FakeFile | Response => {
    const space = String(params.space)
    const id = String(params.id)
    if (!canAccess(user, space)) return forbidden(space)
    if (!ID.test(id)) return error(404, 'not_found', `No file ${id}`)
    return fake.get(space, id) ?? error(404, 'not_found', `No file ${id} in ${space}`)
  }

  const json = async <T>(request: Request): Promise<Partial<T>> =>
    ((await request.json().catch(() => ({}))) ?? {}) as Partial<T>

  const bytesResponse = (file: FakeFile, download: boolean) => {
    const inline = !download && previewKind(file.mime) !== 'none'
    return new HttpResponse(file.bytes as Uint8Array<ArrayBuffer>, {
      headers: {
        'content-type': inline ? file.mime : 'application/octet-stream',
        'content-length': String(file.bytes.length),
        'content-disposition': inline ? 'inline' : `attachment; filename="${file.name}"`,
      },
    })
  }

  return [
    http.get('/api/files/config', () =>
      HttpResponse.json({
        available: true,
        chunkBytes: fake.chunkBytes,
        maxBytes: MOCK_MAX_FILE_BYTES,
      }),
    ),

    http.get(
      '/api/files',
      authed(({ user, url }) => {
        const space = url.searchParams.get('space') || 'team'
        if (!canAccess(user, space)) return forbidden(space)
        const folder = cleanFolder(url.searchParams.get('folder') ?? '')
        const all = fake.inSpace(space)
        const q = url.searchParams.get('q')?.trim().toLowerCase()
        const byName = (a: FakeFile, b: FakeFile) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
        if (q) {
          const names = all.filter((f) => f.name.toLowerCase().includes(q))
          const texts = all.filter((f) => !names.includes(f) && f.text.toLowerCase().includes(q))
          const files = [...names.sort(byName), ...texts.sort(byName)]
            .filter((f) => isInFolder(f.folder, folder))
            .map((f) => fake.view(f))
          return HttpResponse.json({ space, folder, folders: [], files })
        }
        const known = new Set(fake.savedFolders(space))
        for (const f of all) for (const a of folderAncestors(f.folder)) known.add(a)
        const depth = folder === '' ? 0 : folder.split('/').length
        const folders = [...known]
          .filter((f) => isInFolder(f, folder) && f !== folder && f.split('/').length === depth + 1)
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))
        const files = all
          .filter((f) => f.folder === folder)
          .sort(byName)
          .map((f) => fake.view(f))
        return HttpResponse.json({ space, folder, folders, files })
      }),
    ),

    http.get(
      '/api/files/recent',
      authed(({ user }) => {
        const files = [...fake.files.values()]
          .filter((f) => canAccess(user, f.space))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 50)
          .map((f) => fake.view(f))
        return HttpResponse.json({ files })
      }),
    ),

    http.post(
      '/api/files/uploads',
      authed(async ({ request, user }) => {
        const body = await json<{
          space: string
          folder: string
          name: string
          size: number
          mime: string
        }>(request)
        const space = String(body.space ?? '')
        if (!canAccess(user, space)) return forbidden(space)
        const size = Number(body.size)
        if (!Number.isInteger(size) || size < 0 || size > MOCK_MAX_FILE_BYTES) {
          return error(413, 'bad_request', 'In the demo a file can be at most 200 MB')
        }
        const name = cleanFileName(String(body.name ?? ''))
        const id = newId()
        fake.uploads.set(id, {
          owner: user.email,
          space,
          folder: cleanFolder(String(body.folder ?? '')),
          name,
          mime: fileMimeType(name, typeof body.mime === 'string' ? body.mime : undefined),
          size,
          chunks: new Map(),
        })
        return HttpResponse.json(
          { id, chunkBytes: fake.chunkBytes, chunks: fake.chunkCount(size) },
          { status: 201 },
        )
      }),
    ),

    http.put(
      '/api/files/uploads/:id/chunks/:seq',
      authed(async ({ request, user, params }) => {
        const upload = fake.uploads.get(String(params.id))
        if (!upload || upload.owner !== user.email) return error(404, 'not_found', 'No such upload')
        const seq = Number(params.seq)
        const chunks = fake.chunkCount(upload.size)
        if (!Number.isInteger(seq) || seq < 0 || seq >= chunks) {
          return error(400, 'bad_request', `This upload has chunks 0 to ${chunks - 1}`)
        }
        const bytes = new Uint8Array(await request.arrayBuffer())
        const expected = seq === chunks - 1 ? upload.size - seq * fake.chunkBytes : fake.chunkBytes
        if (bytes.length !== expected) {
          return error(400, 'bad_request', `Chunk ${seq} should be ${expected} bytes`)
        }
        upload.chunks.set(seq, bytes)
        return new HttpResponse(null, { status: 204 })
      }),
    ),

    http.post(
      '/api/files/uploads/:id/complete',
      authed(({ user, params }) => {
        const id = String(params.id)
        const upload = fake.uploads.get(id)
        if (!upload || upload.owner !== user.email) return error(404, 'not_found', 'No such upload')
        const chunks = fake.chunkCount(upload.size)
        const missing: number[] = []
        for (let s = 0; s < chunks; s++) if (!upload.chunks.has(s)) missing.push(s)
        if (missing.length > 0) {
          return error(409, 'conflict', `Chunks ${missing.slice(0, 10).join(', ')} haven’t arrived`)
        }
        const bytes = new Uint8Array(upload.size)
        for (let s = 0; s < chunks; s++) {
          bytes.set(upload.chunks.get(s) as Uint8Array, s * fake.chunkBytes)
        }
        fake.uploads.delete(id)
        const file = fake.add({
          space: upload.space,
          folder: upload.folder,
          name: upload.name,
          mime: upload.mime,
          bytes,
          by: user.email,
        })
        return HttpResponse.json(fake.view(file))
      }),
    ),

    http.delete(
      '/api/files/uploads/:id',
      authed(({ user, params }) => {
        const upload = fake.uploads.get(String(params.id))
        if (upload?.owner === user.email) fake.uploads.delete(String(params.id))
        return new HttpResponse(null, { status: 204 })
      }),
    ),

    http.post(
      '/api/files/folders',
      authed(async ({ request, user }) => {
        const body = await json<{ space: string; folder: string }>(request)
        const space = String(body.space ?? '')
        if (!canAccess(user, space)) return forbidden(space)
        const folder = cleanFolder(String(body.folder ?? ''))
        if (!folder) return error(400, 'bad_request', 'A folder needs a name')
        fake.savedFolders(space).add(folder)
        return HttpResponse.json({ folder }, { status: 201 })
      }),
    ),

    http.patch(
      '/api/files/folders',
      authed(async ({ request, user }) => {
        const body = await json<{ space: string; from: string; to: string }>(request)
        const space = String(body.space ?? '')
        if (!canAccess(user, space)) return forbidden(space)
        const a = cleanFolder(String(body.from ?? ''))
        const b = cleanFolder(String(body.to ?? ''))
        if (!a || !b) return error(400, 'bad_request', 'A folder needs a name')
        if (a === b) return HttpResponse.json({ folder: b })
        if (isInFolder(b, a)) return error(400, 'bad_request', 'A folder can’t move inside itself')
        const moved = (p: string) => (p === a ? b : `${b}${p.slice(a.length)}`)
        for (const f of fake.inSpace(space)) {
          if (isInFolder(f.folder, a)) {
            f.folder = moved(f.folder)
            fake.touch(f)
          }
        }
        const saved = fake.savedFolders(space)
        const next = [...saved].map((s) => (isInFolder(s, a) ? moved(s) : s))
        saved.clear()
        for (const s of [...next, b]) saved.add(s)
        return HttpResponse.json({ folder: b })
      }),
    ),

    http.delete(
      '/api/files/folders',
      authed(async ({ request, user }) => {
        const body = await json<{ space: string; folder: string }>(request)
        const space = String(body.space ?? '')
        if (!canAccess(user, space)) return forbidden(space)
        const folder = cleanFolder(String(body.folder ?? ''))
        if (!folder) return error(400, 'bad_request', 'Choose a folder')
        for (const f of fake.inSpace(space)) if (isInFolder(f.folder, folder)) fake.remove(f)
        const saved = fake.savedFolders(space)
        for (const s of [...saved]) if (isInFolder(s, folder)) saved.delete(s)
        return new HttpResponse(null, { status: 204 })
      }),
    ),

    http.get(
      '/api/files/shared/:token',
      authed(({ params }) => {
        const token = String(params.token)
        const file = [...fake.files.values()].find((f) => f.shareToken === token)
        if (!file) {
          return error(404, 'not_found', 'This link has been turned off, or the file was deleted')
        }
        return HttpResponse.json(fake.sharedView(file))
      }),
    ),

    // Only reached where object URLs aren't available (tests); the browser gets those instead.
    http.get('/api/files/media/:space/:id', ({ params, request }) => {
      const file = fake.get(String(params.space), String(params.id))
      if (!file) return error(404, 'not_found', 'This link has expired; reload the page')
      return bytesResponse(file, new URL(request.url).searchParams.has('download'))
    }),

    http.get(
      '/api/files/item/:space/:id',
      authed(({ user, params, url }) => {
        const file = item(user, params)
        if (file instanceof Response) return file
        const view = fake.view(file)
        if (!url.searchParams.has('text')) return HttpResponse.json(view)
        return HttpResponse.json({ ...view, text: file.text })
      }),
    ),

    http.patch(
      '/api/files/item/:space/:id',
      authed(async ({ request, user, params }) => {
        const file = item(user, params)
        if (file instanceof Response) return file
        const body = await json<{ name: string; folder: string }>(request)
        let changed = false
        if (typeof body.name === 'string') {
          const name = cleanFileName(body.name)
          if (name !== file.name) {
            file.name = name
            file.mime = fileMimeType(name, file.mime)
            fake.resetUrls(file)
            changed = true
          }
        }
        if (typeof body.folder === 'string') {
          const folder = cleanFolder(body.folder)
          if (folder !== file.folder) {
            file.folder = folder
            changed = true
          }
        }
        if (changed) fake.touch(file)
        return HttpResponse.json(fake.view(file))
      }),
    ),

    http.post(
      '/api/files/item/:space/:id/share',
      authed(async ({ request, user, params }) => {
        const file = item(user, params)
        if (file instanceof Response) return file
        const { on } = await json<{ on: boolean }>(request)
        if (typeof on !== 'boolean') return error(400, 'bad_request', 'Expected on: true or false')
        if (on !== (file.shareToken !== null)) {
          file.shareToken = on ? shareToken() : null
          fake.touch(file)
        }
        return HttpResponse.json(fake.view(file))
      }),
    ),

    http.post(
      '/api/files/item/:space/:id/move',
      authed(async ({ request, user, params }) => {
        const file = item(user, params)
        if (file instanceof Response) return file
        const to = String((await json<{ to: string }>(request)).to ?? '')
        if (!canAccess(user, to)) return forbidden(to)
        if (to === file.space) return HttpResponse.json(fake.view(file))
        if (to !== 'team' && file.createdBy !== user.email.toLowerCase()) {
          return error(
            403,
            'forbidden',
            'Only the person who uploaded a team file can make it private',
          )
        }
        fake.files.delete(fake.key(file.space, file.id))
        fake.resetUrls(file)
        file.space = to
        file.folder = ''
        fake.touch(file)
        fake.files.set(fake.key(to, file.id), file)
        return HttpResponse.json(fake.view(file))
      }),
    ),

    http.delete(
      '/api/files/item/:space/:id',
      authed(({ user, params }) => {
        const file = item(user, params)
        if (file instanceof Response) return file
        fake.remove(file)
        return new HttpResponse(null, { status: 204 })
      }),
    ),
  ]
}
