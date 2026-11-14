// An in-memory stand-in for the server's GitStore + Index, close enough in behavior that every
// UI state is reachable: stale-base PUTs merge or conflict, history and diffs are real, deletes
// go to .trash, and an "outside edit" can be armed to race the next save.

import { extractTitle, parseFrontmatter, slugify } from '@hearth/format'
import type {
  Author,
  Commit,
  CommitResult,
  ConflictDetail,
  ConflictSummary,
  Entry,
  RecentItem,
  SearchResult,
  StarItem,
} from '../api/types'
import { merge3 } from '../lib/merge3'
import { basename, isMarkdown } from '../lib/paths'
import { unifiedDiff } from './lineDiff'

export function fakeOid(input: string): string {
  let out = ''
  for (let seed = 0; seed < 5; seed++) {
    let h = 0x811c9dc5 ^ seed
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    out += (h >>> 0).toString(16).padStart(8, '0')
  }
  return out
}

export const blobOid = (content: string) => fakeOid(`blob ${content}`)

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface CommitRecord extends Commit {
  /** path → content after this commit (null = deleted). */
  changes: Map<string, string | null>
}

interface ConflictRecord extends ConflictSummary {
  ours: string
}

interface ArmedEdit {
  author: Author
  apply: (content: string) => string
}

export class FakeSpace {
  readonly files = new Map<string, string>()
  readonly binaries = new Map<string, { bytes: ArrayBuffer | string; type: string }>()
  readonly commits: CommitRecord[] = []
  readonly conflicts = new Map<string, ConflictRecord>()
  /** Every blob ever written, so a stale baseBlobOid can still be read as the merge base. */
  readonly blobs = new Map<string, string>()
  readonly armed = new Map<string, ArmedEdit>()

  constructor(
    readonly name: string,
    private readonly clock: () => Date,
  ) {}

  headOid(): string {
    return this.commits.at(-1)?.oid ?? fakeOid(`empty ${this.name}`)
  }

  commit(
    changes: Map<string, string | null>,
    author: Author,
    message: string,
    opts: { label?: string | undefined; date?: Date } = {},
  ) {
    const date = (opts.date ?? this.clock()).toISOString()
    const label = opts.label
    const oid = fakeOid(`commit ${this.name} ${this.commits.length} ${message} ${date}`)
    for (const [path, content] of changes) {
      if (content === null) this.files.delete(path)
      else {
        this.files.set(path, content)
        this.blobs.set(blobOid(content), content)
      }
    }
    const record: CommitRecord = {
      oid,
      author,
      date,
      message,
      changes,
      ...(label ? { label } : {}),
    }
    this.commits.push(record)
    return record
  }

  contentAt(oid: string, path: string): string | null {
    let content: string | null = null
    for (const commit of this.commits) {
      if (commit.changes.has(path)) content = commit.changes.get(path) ?? null
      if (commit.oid === oid) return content
    }
    return null
  }

  list(dir: string): Entry[] {
    const prefix = dir ? `${dir}/` : ''
    const dirs = new Set<string>()
    const files: Entry[] = []
    const allPaths = [...this.files.keys(), ...this.binaries.keys()]
    for (const path of allPaths) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) {
        const content = this.files.get(path)
        files.push({
          path,
          type: 'file',
          size: content?.length ?? 0,
          ...(content !== undefined ? { oid: blobOid(content) } : {}),
        })
      } else dirs.add(prefix + rest.slice(0, slash))
    }
    const byName = (a: Entry, b: Entry) => a.path.localeCompare(b.path)
    return [
      ...[...dirs].map((path): Entry => ({ path, type: 'dir' })).sort(byName),
      ...files.sort(byName),
    ]
  }

  pathsUnder(path: string): string[] {
    return [...this.files.keys()].filter((p) => p === path || p.startsWith(`${path}/`))
  }
}

const docMessage = (verb: string, path: string, content?: string | null) =>
  `docs: ${verb} "${(content && extractTitle(content)) || basename(path).replace(/\.md$/, '')}"`

export interface FakeUser {
  email: string
  name: string
  handle: string
}

export class FakeRepo {
  readonly spaces = new Map<string, FakeSpace>()
  readonly recents = new Map<string, RecentItem[]>()
  readonly stars = new Map<string, StarItem[]>()
  readonly pins = new Map<string, string[]>()
  idleCommitMs = 2500
  private conflictCounter = 0
  private idCounter = 0

  constructor(readonly clock: () => Date = () => new Date()) {}

  space(name: string): FakeSpace {
    let space = this.spaces.get(name)
    if (!space) {
      space = new FakeSpace(name, this.clock)
      this.spaces.set(name, space)
    }
    return space
  }

  read(spaceName: string, path: string, ref?: string) {
    const space = this.space(spaceName)
    const content = ref ? space.contentAt(ref, path) : (space.files.get(path) ?? null)
    if (content === null) return null
    return { content, blobOid: blobOid(content), headOid: space.headOid() }
  }

  /** Simulates someone else pushing a change to `path` just before the next PUT lands. */
  armOutsideEdit(spaceName: string, path: string, edit: ArmedEdit): void {
    this.space(spaceName).armed.set(path, edit)
  }

  /** Applies an outside push immediately (Obsidian, an agent). */
  outsideEdit(spaceName: string, path: string, edit: ArmedEdit): CommitRecord | null {
    const space = this.space(spaceName)
    const current = space.files.get(path)
    if (current === undefined) return null
    return space.commit(
      new Map([[path, edit.apply(current)]]),
      edit.author,
      docMessage('edit', path, current),
    )
  }

  put(
    spaceName: string,
    body: { path: string; content: string; baseBlobOid?: string; message?: string; label?: string },
    author: Author,
  ): CommitResult {
    const space = this.space(spaceName)
    const armed = space.armed.get(body.path)
    if (armed) {
      space.armed.delete(body.path)
      this.outsideEdit(spaceName, body.path, armed)
    }

    const head = space.files.get(body.path)
    const message =
      body.message ?? docMessage(head === undefined ? 'create' : 'edit', body.path, body.content)
    let content = body.content
    let merged = false

    if (
      body.baseBlobOid &&
      head !== undefined &&
      blobOid(head) !== body.baseBlobOid &&
      head !== content
    ) {
      const base = space.blobs.get(body.baseBlobOid) ?? ''
      const result = merge3(base, content, head)
      if (!result.clean) {
        const ref = this.addConflict(spaceName, body.path, content)
        return {
          status: 'conflict',
          conflictRef: ref,
          theirs: { blobOid: blobOid(head), content: head },
          ours: { content },
        }
      }
      content = result.text
      merged = true
    }

    // Like the server, every saved .md gets a frontmatter `id`; the client adopts the change.
    const saved = isMarkdown(body.path) ? this.withId(content) : content
    const oid =
      head === saved
        ? space.headOid()
        : space.commit(new Map([[body.path, saved]]), author, message, { label: body.label }).oid
    if (merged) return { status: 'merged', oid, blobOid: blobOid(saved), content: saved }
    return saved === body.content
      ? { status: 'committed', oid, blobOid: blobOid(saved) }
      : { status: 'committed', oid, blobOid: blobOid(saved), content: saved }
  }

  /** Adds `id` as the first frontmatter key when it's missing, like the server's ensureId. */
  withId(text: string): string {
    const { data, yamlText } = parseFrontmatter(text)
    if (typeof data.id === 'string' && data.id !== '') return text
    this.idCounter += 1
    const id = fakeOid(`id ${this.idCounter} ${text.length}`).slice(0, 26).toUpperCase()
    return yamlText === null ? `---\nid: ${id}\n---\n${text}` : `---\nid: ${id}\n${text.slice(4)}`
  }

  /** Keeps `ours` on a conflict branch; main is untouched. */
  addConflict(spaceName: string, path: string, ours: string): string {
    this.conflictCounter += 1
    const ref = `refs/heads/conflicts/${fakeOid(`${path}${this.conflictCounter}`).slice(0, 26).toUpperCase()}`
    this.space(spaceName).conflicts.set(ref, {
      ref,
      path,
      createdAt: this.clock().toISOString(),
      ours,
    })
    return ref
  }

  listConflicts(spaceName: string): ConflictSummary[] {
    return [...this.space(spaceName).conflicts.values()].map(({ ref, path, createdAt }) => ({
      ref,
      path,
      createdAt,
    }))
  }

  conflict(spaceName: string, ref: string): ConflictDetail | null {
    const space = this.space(spaceName)
    const record = space.conflicts.get(ref)
    if (!record) return null
    const main = space.files.get(record.path)
    return {
      path: record.path,
      ours: { content: record.ours },
      theirs: main === undefined ? null : { content: main, blobOid: blobOid(main) },
    }
  }

  resolve(spaceName: string, ref: string, content: string, author: Author): CommitResult | null {
    const space = this.space(spaceName)
    const record = space.conflicts.get(ref)
    if (!record) return null
    space.conflicts.delete(ref)
    const saved = isMarkdown(record.path) ? this.withId(content) : content
    const commit = space.commit(
      new Map([[record.path, saved]]),
      author,
      docMessage('resolve conflict in', record.path, saved),
    )
    return saved === content
      ? { status: 'committed', oid: commit.oid, blobOid: blobOid(saved) }
      : { status: 'committed', oid: commit.oid, blobOid: blobOid(saved), content: saved }
  }

  remove(spaceName: string, path: string, author: Author): { oid: string } | null {
    const space = this.space(spaceName)
    const paths = space.pathsUnder(path)
    if (paths.length === 0) return null
    const day = this.clock().toISOString().slice(0, 10)
    const changes = new Map<string, string | null>()
    for (const p of paths) {
      changes.set(p, null)
      changes.set(`.trash/${day}/${p}`, space.files.get(p) ?? '')
    }
    return { oid: space.commit(changes, author, docMessage('delete', path)).oid }
  }

  move(spaceName: string, from: string, to: string, author: Author): { oid: string } | null {
    const space = this.space(spaceName)
    const paths = space.pathsUnder(from)
    if (paths.length === 0 || space.files.has(to)) return null
    const changes = new Map<string, string | null>()
    for (const p of paths) {
      changes.set(p, null)
      changes.set(to + p.slice(from.length), space.files.get(p) ?? '')
    }
    return { oid: space.commit(changes, author, docMessage('move', from)).oid }
  }

  createFolder(spaceName: string, path: string, author: Author): { oid: string } {
    const space = this.space(spaceName)
    const keep = `${path}/.gitkeep`
    if (space.files.has(keep)) return { oid: space.headOid() }
    return {
      oid: space.commit(new Map([[keep, '']]), author, `docs: add folder "${basename(path)}"`).oid,
    }
  }

  shareToTeam(
    fromSpace: string,
    path: string,
    toFolder: string,
    author: Author,
  ): { teamPath: string } | null {
    const source = this.space(fromSpace)
    const content = source.files.get(path)
    if (content === undefined) return null
    const team = this.space('team')
    let teamPath = `${toFolder.replace(/\/$/, '')}/${basename(path)}`
    for (let n = 2; team.files.has(teamPath); n++) {
      teamPath = `${toFolder}/${basename(path).replace(/\.md$/, '')}-${n}.md`
    }
    team.commit(new Map([[teamPath, content]]), author, docMessage('share', teamPath, content))
    source.commit(new Map([[path, null]]), author, docMessage('share', path, content))
    return { teamPath }
  }

  history(spaceName: string, path: string, limit = 50): Commit[] {
    return this.space(spaceName)
      .commits.filter((c) => c.changes.has(path))
      .reverse()
      .slice(0, limit)
      .map(({ changes: _changes, ...commit }) => commit)
  }

  diff(spaceName: string, from: string, to: string, path: string): string {
    const space = this.space(spaceName)
    return unifiedDiff(space.contentAt(from, path) ?? '', space.contentAt(to, path) ?? '', path)
  }

  restore(spaceName: string, oid: string, path: string, author: Author): CommitResult | null {
    const space = this.space(spaceName)
    const content = space.contentAt(oid, path)
    if (content === null) return null
    if (space.files.get(path) === content) {
      return { status: 'committed', oid: space.headOid(), blobOid: blobOid(content) }
    }
    const commit = space.commit(
      new Map([[path, content]]),
      author,
      `docs: restore "${extractTitle(content) ?? basename(path)}" to ${oid.slice(0, 7)}`,
    )
    return { status: 'committed', oid: commit.oid, blobOid: blobOid(content) }
  }

  uploadAsset(spaceName: string, name: string, bytes: ArrayBuffer | string, type: string): string {
    const now = this.clock()
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : 'bin'
    const stem = slugify(dot > 0 ? name.slice(0, dot) : name) || 'image'
    const id = fakeOid(`${name}${now.getTime()}${Math.random()}`).slice(0, 8).toUpperCase()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const path = `assets/${now.getFullYear()}/${month}/${stem}-${id}.${ext}`
    this.space(spaceName).binaries.set(path, { bytes, type })
    return path
  }

  search(q: string, spaceNames: string[], limit = 20): SearchResult[] {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return []
    const results: SearchResult[] = []
    for (const spaceName of spaceNames) {
      for (const [path, content] of this.space(spaceName).files) {
        if (!path.startsWith('docs/') || !isMarkdown(path)) continue
        const title = extractTitle(content) ?? basename(path).replace(/\.md$/, '')
        const lowerTitle = title.toLowerCase()
        const lowerBody = content.toLowerCase()
        if (!terms.every((t) => lowerTitle.includes(t) || lowerBody.includes(t))) continue
        const titleHits = terms.filter((t) => lowerTitle.includes(t)).length
        const bodyHits = terms.reduce((n, t) => n + lowerBody.split(t).length - 1, 0)
        const body = parseFrontmatter(content).body
        const first = Math.max(0, body.toLowerCase().indexOf(terms[0] ?? ''))
        // Hits marked with \u0002 … \u0003, like the server's FTS snippet().
        const snippet = body
          .slice(Math.max(0, first - 60), first + 100)
          .replace(/\s+/g, ' ')
          .trim()
          .replace(new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi'), '\u0002$1\u0003')
        results.push({
          space: spaceName,
          path,
          title,
          snippet,
          score: titleHits * 4 + Math.min(bodyHits, 5),
        })
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  addRecent(user: string, space: string, path: string): void {
    const list = (this.recents.get(user) ?? []).filter(
      (r) => !(r.space === space && r.path === path),
    )
    const content = this.space(space).files.get(path)
    const title = content ? extractTitle(content) : null
    list.unshift({ space, path, openedAt: this.clock().toISOString(), title })
    this.recents.set(user, list.slice(0, 20))
  }

  setStar(user: string, space: string, path: string, starred: boolean): void {
    const list = (this.stars.get(user) ?? []).filter((s) => !(s.space === space && s.path === path))
    if (starred) {
      const content = this.space(space).files.get(path)
      const title = content ? extractTitle(content) : null
      list.push({ space, path, title })
    }
    this.stars.set(user, list)
  }
}
