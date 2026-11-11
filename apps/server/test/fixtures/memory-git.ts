import { createHash } from 'node:crypto'
import { HearthError } from '../../src/errors.js'
import type { Entry, GitReader } from '../../src/index/index.js'

interface Author {
  name: string
  email: string
}

export function blobOid(content: string): string {
  const bytes = Buffer.from(content)
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

/** In-memory stand-in for GitStore: one flat file map per space, a counter for HEAD. */
export class MemoryGit implements GitReader {
  readonly clones: Array<{ space: string; remoteUrl: string }> = []
  readonly commits: Array<{ space: string; author: Author; message: string; paths: string[] }> = []
  readonly #files = new Map<string, Map<string, string>>()
  readonly #heads = new Map<string, number>()

  /** Puts files in place as if they were already pushed. */
  seed(space: string, files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) this.write(space, path, content)
  }

  /** Simulates an outside push of one file; `null` deletes it. */
  write(space: string, path: string, content: string | null): void {
    const files = this.#space(space, true)
    if (content === null) files.delete(path)
    else files.set(path, content)
    this.#heads.set(space, (this.#heads.get(space) ?? 0) + 1)
  }

  async ensureClone(space: string, remoteUrl: string): Promise<void> {
    this.clones.push({ space, remoteUrl })
    this.#space(space, true)
  }

  async remoteUrl(space: string): Promise<string | null> {
    return this.clones.findLast((c) => c.space === space)?.remoteUrl ?? null
  }

  async headOid(space: string): Promise<string> {
    return `${space}@${this.#heads.get(space) ?? 0}`
  }

  async listAll(space: string): Promise<Entry[]> {
    return [...this.#space(space).entries()].map(([path, content]) => ({
      path,
      type: 'file' as const,
      size: Buffer.byteLength(content),
      oid: blobOid(content),
    }))
  }

  async readFile(space: string, path: string): Promise<{ content: string; blobOid: string }> {
    const content = this.#space(space).get(path)
    if (content === undefined) throw new HearthError('not_found', `${space}:${path} not found`)
    return { content, blobOid: blobOid(content) }
  }

  async commit(
    space: string,
    args: {
      changes: Array<{ path: string; content: string | null }>
      author: Author
      message: string
    },
  ): Promise<{ status: 'committed'; oid: string; blobOid: string }> {
    for (const change of args.changes) this.write(space, change.path, change.content)
    this.commits.push({
      space,
      author: args.author,
      message: args.message,
      paths: args.changes.map((c) => c.path),
    })
    return { status: 'committed', oid: await this.headOid(space), blobOid: '' }
  }

  #space(space: string, create = false): Map<string, string> {
    let files = this.#files.get(space)
    if (!files && create) {
      files = new Map()
      this.#files.set(space, files)
    }
    if (!files) throw new HearthError('not_found', `space ${space} is not cloned`)
    return files
  }
}

/** In-memory stand-in for a HostAdapter. */
export class MemoryHost {
  readonly repos = new Set<string>()
  readonly ensureRepoCalls: string[] = []
  readonly collaborators: Array<{ name: string; username: string }> = []
  readonly webhooks: Array<{ name: string; url: string; secret: string }> = []

  async ensureRepo(name: string): Promise<{ cloneUrl: string }> {
    this.ensureRepoCalls.push(name)
    this.repos.add(name)
    return { cloneUrl: `file:///remotes/${name}.git` }
  }

  async ensureWebhook(name: string, url: string, secret: string): Promise<void> {
    this.webhooks.push({ name, url, secret })
  }

  async addCollaborator(name: string, username: string): Promise<void> {
    this.collaborators.push({ name, username })
  }
}
