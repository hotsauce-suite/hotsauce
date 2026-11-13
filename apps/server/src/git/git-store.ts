import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ulid } from 'ulid'
import { type ErrorCode, HearthError } from '../errors.js'
import { parseCommitMessage, withVia } from './message.js'
import { KeyedMutex } from './mutex.js'
import { GitError, runGit, runGitBuffer } from './run-git.js'
import type { Author, Change, Commit, CommitResult, ConflictInfo, Entry } from './types.js'
import {
  assertConflictRef,
  assertRepoPath,
  assertRev,
  assertSpace,
  normalizeRepoPath,
} from './validate.js'
import { assertSafeWorktreePath } from './worktree.js'

export interface GitStoreOptions {
  dataDir: string
  committer: Author
  /**
   * Fixes a moved markdown file's own relative links. Wired to `rewriteLinksForMove` from
   * @hearth/format. `folder` is given when the file moved with a folder, whose other files moved too.
   */
  rewriteLinks?: RewriteLinks
  /** Test seam: runs right before every push of main, so a test can land a concurrent push. */
  beforePush?: (space: string) => Promise<void>
}

export type RewriteLinks = (
  markdown: string,
  oldPath: string,
  newPath: string,
  folder?: { from: string; to: string },
) => string

const MAIN = 'refs/heads/main'
const ORIGIN_MAIN = 'refs/remotes/origin/main'
const CONFLICT_PREFIX = 'refs/heads/conflicts/'
const CONFLICT_PATH_TRAILER = 'Hearth-Conflict-Path'
const MAX_PUSH_ATTEMPTS = 3
const MAX_REBASE_STEPS = 500
const BLOB_OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const SYMLINK_MODE = '120000'

type TreeEntry = { mode: string; type: string; oid: string; size: number | null; path: string }

export class GitStore {
  private readonly reposDir: string
  private readonly committer: Author
  private readonly rewriteLinks: RewriteLinks
  private readonly beforePush: ((space: string) => Promise<void>) | undefined
  private readonly locks = new KeyedMutex()

  constructor(opts: GitStoreOptions) {
    this.reposDir = join(opts.dataDir, 'repos')
    this.committer = opts.committer
    this.rewriteLinks = opts.rewriteLinks ?? ((markdown) => markdown)
    this.beforePush = opts.beforePush
  }

  // ── setup ────────────────────────────────────────────────────────────────

  /** Clones the space if it is missing; otherwise points origin at `remoteUrl` and discards any half-finished write. */
  async ensureClone(space: string, remoteUrl: string): Promise<void> {
    assertSpace(space)
    await this.locks.run(space, async () => {
      const dir = this.repoDir(space)
      if (existsSync(join(dir, '.git'))) {
        await this.git(dir, ['remote', 'set-url', 'origin', remoteUrl])
        await this.recover(dir)
        return
      }
      await mkdir(this.reposDir, { recursive: true })
      await runGit(this.reposDir, ['clone', '--quiet', '--', remoteUrl, space])
      // An empty remote clones with an unborn HEAD; Hearth always works on main.
      if ((await this.revParse(dir, 'HEAD')) === null) {
        await this.git(dir, ['symbolic-ref', 'HEAD', MAIN])
      }
      // Conflict branches are part of the space's state; bring them back on a fresh clone.
      await this.git(dir, [
        'fetch',
        '--quiet',
        'origin',
        `+${CONFLICT_PREFIX}*:${CONFLICT_PREFIX}*`,
      ])
    })
  }

  /** The clone's origin URL (it carries the host credential), or null when there is no clone. */
  async remoteUrl(space: string): Promise<string | null> {
    assertSpace(space)
    const dir = this.repoDir(space)
    if (!existsSync(join(dir, '.git'))) return null
    return (await this.git(dir, ['remote', 'get-url', 'origin'])).trim()
  }

  /** Spaces that have a working clone under DATA_DIR/repos, sorted. */
  async listClones(): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(this.reposDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    return names
      .filter((name) => isSpaceName(name) && existsSync(join(this.reposDir, name, '.git')))
      .sort()
  }

  // ── reads (lock-free: they only touch the object database) ───────────────

  async headOid(space: string): Promise<string> {
    const dir = this.requireClone(space)
    const head = await this.revParse(dir, 'HEAD')
    if (head === null) throw new HearthError('not_found', `Space ${space} has no commits yet`)
    return head
  }

  /** Symlinks are invisible to Hearth: never listed, read, or written. Reading one is not_found. */
  async readFile(
    space: string,
    rawPath: string,
    ref = 'HEAD',
  ): Promise<{ content: string; blobOid: string }> {
    const path = normalizeRepoPath(rawPath)
    assertRev(ref)
    const dir = this.requireClone(space)
    const entry = await this.treeEntry(dir, ref, path)
    if (entry === null || !isRegularFile(entry)) {
      throw new HearthError('not_found', `${path} not found at ${ref} in ${space}`)
    }
    const content = await this.git(dir, ['cat-file', 'blob', entry.oid])
    return { content, blobOid: entry.oid }
  }

  /** A blob's text by its oid, such as the version a client last read; bad_request if unknown. */
  async readBlobText(space: string, oid: string): Promise<string> {
    if (!BLOB_OID.test(oid)) throw new HearthError('bad_request', `Invalid blob: ${oid}`)
    return this.blobContent(this.requireClone(space), oid)
  }

  /** `readFile` for binary files: the blob's bytes, undecoded. */
  async readBlob(
    space: string,
    rawPath: string,
    ref = 'HEAD',
  ): Promise<{ content: Buffer; blobOid: string }> {
    const path = normalizeRepoPath(rawPath)
    assertRev(ref)
    const dir = this.requireClone(space)
    const entry = await this.treeEntry(dir, ref, path)
    if (entry === null || !isRegularFile(entry)) {
      throw new HearthError('not_found', `${path} not found at ${ref} in ${space}`)
    }
    const content = await runGitBuffer(dir, ['cat-file', 'blob', entry.oid])
    return { content, blobOid: entry.oid }
  }

  /** One level of the tree at HEAD, directories first. */
  async listTree(space: string, rawDir?: string): Promise<Entry[]> {
    const dir = rawDir ? normalizeRepoPath(rawDir) : ''
    const repo = this.requireClone(space)
    if ((await this.revParse(repo, 'HEAD')) === null) return []
    let out: string
    try {
      out = await this.git(repo, ['ls-tree', '-z', '--long', dir ? `HEAD:${dir}` : 'HEAD'])
    } catch (err) {
      // Missing directory, or a file rather than a directory.
      if (err instanceof GitError && err.exitCode === 128) return []
      throw err
    }
    const entries: Entry[] = []
    for (const e of parseLsTree(out)) {
      const path = dir ? `${dir}/${e.path}` : e.path
      if (e.type === 'tree') entries.push({ path, type: 'dir', oid: e.oid })
      else if (isRegularFile(e)) entries.push(fileEntry(path, e))
    }
    return entries.sort((a, b) =>
      a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1,
    )
  }

  /** Every file at HEAD, for indexing. Empty for a space with no commits. */
  async listAll(space: string): Promise<Entry[]> {
    const dir = this.requireClone(space)
    if ((await this.revParse(dir, 'HEAD')) === null) return []
    const out = await this.git(dir, ['ls-tree', '-r', '-z', '--long', 'HEAD'])
    return parseLsTree(out)
      .filter(isRegularFile)
      .map((e) => fileEntry(e.path, e))
  }

  async log(space: string, opts: { path?: string; limit?: number } = {}): Promise<Commit[]> {
    const path = opts.path === undefined ? undefined : normalizeRepoPath(opts.path)
    if (opts.limit !== undefined && !(Number.isInteger(opts.limit) && opts.limit > 0)) {
      throw new HearthError('bad_request', `Invalid limit: ${opts.limit}`)
    }
    const dir = this.requireClone(space)
    if ((await this.revParse(dir, 'HEAD')) === null) return []

    const args = ['log', '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%B%x1e']
    if (opts.limit !== undefined) args.push(`--max-count=${opts.limit}`)
    if (path !== undefined) args.push('--follow', 'HEAD', '--', path)
    else args.push('HEAD')

    const out = await this.git(dir, args)
    const commits: Commit[] = []
    for (const record of out.split('\x1e')) {
      const fields = record.replace(/^\n/, '').split('\x1f')
      if (fields.length < 5) continue
      const [oid = '', name = '', email = '', date = '', ...body] = fields
      const { message, label } = parseCommitMessage(body.join('\x1f'))
      const commit: Commit = { oid, author: { name, email }, date, message }
      if (label !== undefined) commit.label = label
      commits.push(commit)
    }
    return commits
  }

  async show(space: string, oid: string, path: string): Promise<string> {
    assertRev(oid)
    return (await this.readFile(space, path, oid)).content
  }

  async diff(space: string, from: string, to: string, rawPath: string): Promise<string> {
    assertRev(from)
    assertRev(to)
    const path = normalizeRepoPath(rawPath)
    const dir = this.requireClone(space)
    try {
      return await this.git(dir, ['diff', '--no-color', '--no-ext-diff', from, to, '--', path])
    } catch (err) {
      if (err instanceof GitError && err.exitCode === 128) {
        throw new HearthError('not_found', `Cannot diff ${from}..${to}: ${err.stderr.trim()}`)
      }
      throw err
    }
  }

  /** Paths that differ between two commits (a rename is its old and its new path). */
  async changedPaths(space: string, from: string, to: string): Promise<string[]> {
    assertRev(from)
    assertRev(to)
    const dir = this.requireClone(space)
    for (const rev of [from, to]) {
      if ((await this.revParse(dir, rev)) === null) {
        throw new HearthError('not_found', `Unknown commit ${rev} in ${space}`)
      }
    }
    return this.diffNames(dir, from, to)
  }

  async listConflicts(space: string): Promise<ConflictInfo[]> {
    const dir = this.requireClone(space)
    const out = await this.git(dir, [
      'for-each-ref',
      '--format=%(refname)%1f%(creatordate:iso-strict)%1f%(contents)%1e',
      CONFLICT_PREFIX,
    ])
    const conflicts: ConflictInfo[] = []
    for (const record of out.split('\x1e')) {
      const [ref = '', createdAt = '', message = ''] = record.replace(/^\n/, '').split('\x1f')
      const path = conflictPathFromMessage(message)
      if (!ref) continue
      if (path === null || !isValidRepoPath(path)) {
        // The trailer is repo data: anyone with push access can forge a conflict branch.
        console.warn(`Skipping conflict ${ref} in ${space}: missing or invalid path`)
        continue
      }
      conflicts.push({ ref, path, createdAt })
    }
    return conflicts.sort((a, b) => a.ref.localeCompare(b.ref))
  }

  // ── writes (each runs under the space's lock) ────────────────────────────

  async commit(
    space: string,
    args: {
      changes: Change[]
      author: Author
      message: string
      base?: { path: string; blobOid: string }
      /**
       * No merge: refuse (conflict) unless this file is still exactly this blob at HEAD. A file
       * deleted or moved since is a conflict too, so a stale write never brings it back. A null
       * blob means the file must not exist yet (create only), checked under the space lock.
       */
      unchanged?: { path: string; blobOid: string | null }
    },
  ): Promise<CommitResult> {
    assertSpace(space)
    if (args.changes.length === 0) throw new HearthError('bad_request', 'No changes to commit')
    const changes = args.changes.map((c) => ({
      path: normalizeRepoPath(c.path),
      content: c.content,
    }))
    const { author, message } = args
    if (args.base === undefined) {
      // "Must not exist": no blob can equal '', and a missing file is fine.
      const unchanged = args.unchanged && {
        path: normalizeRepoPath(args.unchanged.path),
        blobOid: args.unchanged.blobOid ?? '',
        missingOk: args.unchanged.blobOid === null,
      }
      return this.write(space, (dir) =>
        this.commitUnlocked(space, dir, {
          changes,
          author,
          message,
          ...(unchanged ? { unchanged } : {}),
        }),
      )
    }
    if (!BLOB_OID.test(args.base.blobOid)) {
      throw new HearthError('bad_request', `Invalid base blob: ${args.base.blobOid}`)
    }
    const base = { path: normalizeRepoPath(args.base.path), blobOid: args.base.blobOid }
    return this.write(space, (dir) =>
      this.commitUnlocked(space, dir, { changes, author, message, base }),
    )
  }

  /**
   * `extraChanges` adds other files to the move's commit (links into the moved file, rewritten).
   * It runs under the space lock with the commit the move is based on, so what it reads is what
   * it replaces; it runs again if the push loses a race.
   */
  async move(
    space: string,
    rawFrom: string,
    rawTo: string,
    author: Author,
    extraChanges?: (headOid: string) => Promise<Change[]>,
    /** A `Hearth-Via` trailer for the commit (an agent made the move, ARCHITECTURE §8.2). */
    opts: { via?: string | undefined } = {},
  ): Promise<{ oid: string }> {
    assertSpace(space)
    const from = normalizeRepoPath(rawFrom)
    const to = normalizeRepoPath(rawTo)
    if (to === from || to.startsWith(`${from}/`)) {
      throw new HearthError('bad_request', `Cannot move ${from} into ${to}`)
    }
    return this.write(space, (dir) =>
      this.moveUnlocked(space, dir, { from, to, author, extraChanges, via: opts.via }),
    )
  }

  /**
   * Adds the file to the target space first, then removes it from the source, so a failure in
   * between leaves two copies rather than none. The bytes are copied as they are (images too). If
   * the source changed after it was copied, it is not removed: `conflict`, with both copies kept.
   * Links are left as written: relative links into the source space cannot resolve in another
   * repository whatever we rewrite them to.
   */
  async moveAcrossSpaces(
    rawFrom: { space: string; path: string },
    rawTo: { space: string; path: string },
    author: Author,
    opts: { via?: string | undefined } = {},
  ): Promise<{ removedOid: string; addedOid: string }> {
    assertSpace(rawFrom.space)
    assertSpace(rawTo.space)
    const from = { space: rawFrom.space, path: normalizeRepoPath(rawFrom.path) }
    const to = { space: rawTo.space, path: normalizeRepoPath(rawTo.path) }
    if (from.space === to.space) {
      throw new HearthError('bad_request', 'moveAcrossSpaces needs two different spaces')
    }

    const source = await this.write(from.space, async (dir) => {
      await this.catchUp(from.space, dir)
      return this.readBlob(from.space, from.path)
    })

    const added = await this.write(to.space, async (dir) => {
      await this.catchUp(to.space, dir)
      if ((await this.treeEntry(dir, 'HEAD', to.path)) !== null) {
        throw new HearthError('conflict', `${to.path} already exists in ${to.space}`)
      }
      return this.commitUnlocked(to.space, dir, {
        changes: [{ path: to.path, content: source.content }],
        author,
        message: withVia(`hearth: add "${to.path}" from ${from.space}`, opts.via),
      })
    })

    const removed = await this.write(from.space, (dir) =>
      this.commitUnlocked(from.space, dir, {
        changes: [{ path: from.path, content: null }],
        author,
        message: withVia(`hearth: move "${from.path}" to ${to.space}`, opts.via),
        unchanged: { path: from.path, blobOid: source.blobOid, missingOk: true },
      }),
    )

    return { removedOid: committedOid(removed), addedOid: committedOid(added) }
  }

  /** Fetches, fast-forwards (or rebases unpushed commits and pushes them), and reports what changed. */
  async sync(space: string): Promise<{ changed: boolean; headOid: string; paths: string[] }> {
    assertSpace(space)
    return this.write(space, async (dir) => {
      const before = await this.revParse(dir, 'HEAD')
      for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
        await this.catchUp(space, dir)
        try {
          if ((await this.pushMain(space, dir)) === 'pushed') break
        } catch (err) {
          // HEAD has already moved, and the indexer needs these paths. Unpushed commits are safe
          // in the clone and the next commit or sync pushes them; commit() reports push failures.
          if (err instanceof HearthError && err.code === 'push_failed') break
          throw err
        }
      }
      const after = await this.revParse(dir, 'HEAD')
      const paths = await this.diffNames(dir, before, after)
      return { changed: before !== after, headOid: after ?? '', paths }
    })
  }

  /** Commits `content` at `path` on `refs/heads/conflicts/<ulid>` (parent: main) and pushes that ref. */
  async branchConflict(
    space: string,
    rawPath: string,
    content: string,
    author: Author,
  ): Promise<string> {
    assertSpace(space)
    const path = normalizeRepoPath(rawPath)
    return this.write(space, (dir) => this.branchConflictUnlocked(dir, path, content, author))
  }

  /**
   * Commits the resolution on main and deletes the conflict ref. The resolution is merged against
   * main as it was when the conflict happened, so a change landed since is not overwritten; if that
   * merge conflicts, the resolution moves to a new conflict branch (returned) and the old one goes.
   */
  async resolveConflict(
    space: string,
    ref: string,
    resolved: { content: string },
    author: Author,
  ): Promise<CommitResult> {
    assertSpace(space)
    assertConflictRef(ref)
    return this.write(space, async (dir) => {
      if ((await this.revParse(dir, ref)) === null) {
        throw new HearthError('not_found', `Conflict ${ref} not found in ${space}`)
      }
      const message = await this.git(dir, ['log', '-1', '--format=%B', ref])
      const path = conflictPathFromMessage(message)
      if (path === null) throw new HearthError('bad_request', `${ref} has no conflict path trailer`)
      // The trailer is repo data, not trusted input.
      assertRepoPath(path)

      const parentEntry = await this.treeEntry(dir, `${ref}^`, path)
      const result = await this.commitUnlocked(space, dir, {
        changes: [{ path, content: resolved.content }],
        author,
        message: `hearth: resolve conflict on "${path}"`,
        ...(parentEntry ? { base: { path, blobOid: parentEntry.oid } } : {}),
        // Resolving a conflict on a file main has since deleted brings it back, on purpose.
        allowRecreate: true,
      })

      try {
        await this.git(dir, ['push', '--quiet', 'origin', `:${ref}`])
      } catch (err) {
        // Never pushed (its push failed when it was created): nothing to delete remotely.
        if (!(err instanceof GitError && err.stderr.includes('remote ref does not exist'))) {
          throw loggedError('push_failed', `Could not delete ${ref} on the Git host`, err)
        }
      }
      await this.git(dir, ['update-ref', '-d', ref])
      return result
    })
  }

  // ── commit algorithm ─────────────────────────────────────────────────────

  private async commitUnlocked(
    space: string,
    dir: string,
    args: {
      changes: Change[]
      author: Author
      message: string
      base?: { path: string; blobOid: string }
      /**
       * Refuse (conflict) if, after catching up, this file is no longer this blob, or is gone
       * (unless `missingOk`: a move's removal of a source someone else already removed).
       */
      unchanged?: { path: string; blobOid: string; missingOk?: boolean }
      /** Write `base.path` even if HEAD no longer has it (resolving a conflict). */
      allowRecreate?: boolean
    },
  ): Promise<CommitResult> {
    const primaryPath = args.base?.path ?? args.changes[0]?.path ?? ''

    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
      // 1. Catch up with origin.
      await this.catchUp(space, dir)
      const before = await this.revParse(dir, 'HEAD')
      if (args.unchanged) {
        const head = await this.treeEntry(dir, 'HEAD', args.unchanged.path)
        const gone = head === null && !args.unchanged.missingOk
        if (gone || (head !== null && head.oid !== args.unchanged.blobOid)) {
          throw new HearthError(
            'conflict',
            `${args.unchanged.path} changed in ${space} while it was being saved`,
          )
        }
      }

      // A base names the version the client edited. If that file has since been moved or
      // deleted, writing it would bring the old path back; refuse instead.
      if (
        args.base &&
        !args.allowRecreate &&
        (await this.treeEntry(dir, 'HEAD', args.base.path)) === null
      ) {
        throw new HearthError(
          'not_found',
          `${args.base.path} was moved or deleted while it was being edited`,
        )
      }

      // 2. Three-way merge against a concurrent change to the file the client edited.
      let changes = args.changes
      let merged: string | null = null
      const target = args.base && changes.find((c) => c.path === args.base?.path)
      if (args.base && target && typeof target.content === 'string') {
        const head = await this.blobAt(dir, 'HEAD', args.base.path)
        if (head && head.blobOid !== args.base.blobOid && head.content !== target.content) {
          const baseContent = await this.blobContent(dir, args.base.blobOid)
          const result = await this.mergeFile(dir, target.content, baseContent, head.content)
          if (result.clean) {
            merged = result.text
            changes = changes.map((c) =>
              c === target ? { path: c.path, content: result.text } : c,
            )
          } else {
            const conflictRef = await this.branchConflictUnlocked(
              dir,
              args.base.path,
              target.content,
              args.author,
            )
            return {
              status: 'conflict',
              conflictRef,
              theirs: { blobOid: head.blobOid, content: head.content },
              ours: { content: target.content },
            }
          }
        }
      }

      // 3. Commit (an empty diff commits nothing).
      await this.writeChanges(dir, changes)
      if (await this.hasStagedChanges(dir)) {
        await this.git(dir, ['commit', '--quiet', '--no-verify', '-m', args.message], {
          GIT_AUTHOR_NAME: args.author.name,
          GIT_AUTHOR_EMAIL: args.author.email,
        })
      }

      // 4. Push. On a rejection, drop this attempt's commit and redo the edit against the new
      // origin/main, so the merge in step 2 sees the change we raced with.
      if ((await this.pushMain(space, dir)) === 'rejected') {
        if (before !== null) await this.git(dir, ['reset', '--quiet', '--hard', before])
        continue
      }

      const oid = (await this.revParse(dir, 'HEAD')) ?? ''
      // blobOid is '' when the primary path was deleted.
      const blobOid = (await this.treeEntry(dir, 'HEAD', primaryPath))?.oid ?? ''
      return merged === null
        ? { status: 'committed', oid, blobOid }
        : { status: 'merged', oid, blobOid, content: merged }
    }
    throw new HearthError(
      'push_failed',
      `Push to origin was rejected ${MAX_PUSH_ATTEMPTS} times; another writer keeps winning the race`,
    )
  }

  private async moveUnlocked(
    space: string,
    dir: string,
    args: {
      from: string
      to: string
      author: Author
      extraChanges: ((headOid: string) => Promise<Change[]>) | undefined
      via?: string | undefined
    },
  ): Promise<{ oid: string }> {
    const { from, to, author } = args
    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
      await this.catchUp(space, dir)
      const before = await this.revParse(dir, 'HEAD')
      const source = await this.treeEntry(dir, 'HEAD', from)
      if (before === null || source === null) {
        throw new HearthError('not_found', `${from} not found in ${space}`)
      }
      if ((await this.treeEntry(dir, 'HEAD', to)) !== null) {
        throw new HearthError('conflict', `${to} already exists in ${space}`)
      }

      // Every file that moves; a folder moves all the files under it.
      const files = source.type === 'tree' ? await this.treeFilesUnder(dir, from) : [source]
      if (!files.every(isRegularFile)) {
        throw new HearthError('bad_request', `${from} is or contains a symlink or submodule`)
      }
      await assertSafeWorktreePath(dir, from, source.type === 'tree' ? 'dir' : 'file')
      await assertSafeWorktreePath(dir, to)
      const extra = (await args.extraChanges?.(before)) ?? []
      const moving = (path: string) =>
        [from, to].some((p) => path === p || path.startsWith(`${p}/`))
      const normalized = extra.map((c) => ({ path: normalizeRepoPath(c.path), content: c.content }))
      if (normalized.some((c) => moving(c.path))) {
        throw new HearthError('bad_request', `Extra changes can't touch ${from} or ${to}`)
      }

      await mkdir(dirname(join(dir, to)), { recursive: true })
      await this.git(dir, ['mv', '--', from, to])
      for (const file of files) {
        const newPath = to + file.path.slice(from.length)
        if (!newPath.toLowerCase().endsWith('.md')) continue
        // Read through git, never the work tree, so a planted symlink can't redirect the read.
        const text = await this.blobContent(dir, file.oid)
        const rewritten =
          source.type === 'tree'
            ? this.rewriteLinks(text, file.path, newPath, { from, to })
            : this.rewriteLinks(text, file.path, newPath)
        if (rewritten !== text) {
          await this.writeChanges(dir, [{ path: newPath, content: rewritten }])
        }
      }
      if (normalized.length > 0) await this.writeChanges(dir, normalized)
      await this.git(
        dir,
        [
          'commit',
          '--quiet',
          '--no-verify',
          '-m',
          withVia(`hearth: move "${from}" to "${to}"`, args.via),
        ],
        { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email },
      )

      if ((await this.pushMain(space, dir)) === 'rejected') {
        await this.git(dir, ['reset', '--quiet', '--hard', before])
        continue
      }
      return { oid: (await this.revParse(dir, 'HEAD')) ?? '' }
    }
    throw new HearthError('push_failed', `Push to origin was rejected ${MAX_PUSH_ATTEMPTS} times`)
  }

  /**
   * Brings local main up to origin/main: fast-forward when behind; rebase when local has unpushed
   * commits (an earlier push failed). A file that conflicts during the rebase keeps our version on
   * a conflict branch and takes theirs on main. If main was rewritten on the host (it no longer
   * contains what we last fetched), the host wins and only commits we never pushed are replayed.
   */
  private async catchUp(space: string, dir: string): Promise<void> {
    // origin/main as of our last fetch or push: everything after it on HEAD is unpushed.
    const known = await this.revParse(dir, ORIGIN_MAIN)
    try {
      await this.git(dir, ['fetch', '--quiet', 'origin', `+${MAIN}:${ORIGIN_MAIN}`])
    } catch (err) {
      // An empty remote has no main yet; our first push creates it.
      if (err instanceof GitError && err.stderr.includes("couldn't find remote ref")) return
      throw loggedError('host_error', `Could not fetch ${space} from the Git host`, err)
    }

    const local = await this.revParse(dir, 'HEAD')
    const remote = await this.revParse(dir, ORIGIN_MAIN)
    if (remote === null || local === remote) return
    if (local === null || (await this.isAncestor(dir, local, remote))) {
      await this.git(dir, ['reset', '--quiet', '--hard', ORIGIN_MAIN])
      return
    }
    // A force-push dropped commits we had fetched. Someone removed them on purpose, so pushing
    // them back (or rebasing them onto the new main) would undo that.
    const rewrittenSince =
      known !== null && !(await this.isAncestor(dir, known, remote)) ? known : null
    if (rewrittenSince === local) {
      await this.git(dir, ['reset', '--quiet', '--hard', ORIGIN_MAIN])
      return
    }
    if (rewrittenSince === null && (await this.isAncestor(dir, remote, local))) {
      return // only unpushed commits; push sends them
    }

    await this.rebaseStep(
      dir,
      rewrittenSince === null
        ? ['rebase', '--quiet', ORIGIN_MAIN]
        : ['rebase', '--quiet', '--onto', ORIGIN_MAIN, rewrittenSince],
    )
    for (let step = 0; this.rebaseInProgress(dir); step++) {
      if (step >= MAX_REBASE_STEPS) throw new HearthError('internal', `Rebase of ${space} stalled`)
      const unmerged = await this.unmergedStages(dir)
      if (unmerged.size === 0) {
        await this.rebaseStep(dir, [
          'rebase',
          (await this.hasStagedChanges(dir)) ? '--continue' : '--skip',
        ])
        continue
      }
      const author = await this.rebasingAuthor(dir)
      for (const [path, stages] of unmerged) {
        // In a rebase, stage 2 is the upstream side (theirs, for us) and stage 3 is the local
        // commit being replayed (ours).
        if (stages.ours) {
          const ours = await this.blobContent(dir, stages.ours)
          await this.branchConflictUnlocked(dir, path, ours, author)
        }
        if (stages.theirs) {
          await this.git(dir, ['checkout', '--ours', '--', path])
          await this.git(dir, ['add', '--', path])
        } else {
          await this.git(dir, ['rm', '--quiet', '--', path])
        }
      }
      await this.rebaseStep(dir, ['rebase', '--continue'])
    }
  }

  /** Pushes main when local is ahead of origin/main. 'rejected' means someone else pushed first. */
  private async pushMain(space: string, dir: string): Promise<'pushed' | 'rejected'> {
    const local = await this.revParse(dir, 'HEAD')
    if (local === null || local === (await this.revParse(dir, ORIGIN_MAIN))) return 'pushed'
    await this.beforePush?.(space)
    try {
      await this.git(dir, ['push', '--porcelain', 'origin', `${MAIN}:${MAIN}`])
      return 'pushed'
    } catch (err) {
      // --porcelain marks each rejected ref with a leading "!" (non-fast-forward, or a ref lock
      // lost to a concurrent push).
      if (err instanceof GitError && /^!\t/m.test(err.stdout)) return 'rejected'
      throw loggedError('push_failed', `Could not push ${space} to the Git host`, err)
    }
  }

  private async branchConflictUnlocked(
    dir: string,
    path: string,
    content: string,
    author: Author,
  ): Promise<string> {
    const ref = `${CONFLICT_PREFIX}${ulid()}`
    const tmp = await mkdtemp(join(tmpdir(), 'hearth-conflict-'))
    try {
      const contentFile = join(tmp, 'content')
      await writeFile(contentFile, content)
      const blob = (
        await this.git(dir, ['hash-object', '-w', '--no-filters', '--', contentFile])
      ).trim()

      // Build the commit in a scratch index so the work tree and the real index are untouched.
      const indexEnv = { GIT_INDEX_FILE: join(tmp, 'index') }
      const parent = await this.revParse(dir, 'HEAD')
      if (parent !== null) await this.git(dir, ['read-tree', parent], indexEnv)
      // Keep the executable bit if the file had one; anything else (a symlink) becomes a plain file.
      const existing = parent === null ? null : await this.treeEntry(dir, parent, path)
      const mode = existing?.mode === '100755' ? '100755' : '100644'
      await this.git(
        dir,
        ['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`],
        indexEnv,
      )
      const tree = (await this.git(dir, ['write-tree'], indexEnv)).trim()
      const message = `hearth: conflict on "${path}"\n\n${CONFLICT_PATH_TRAILER}: ${path}`
      const commit = (
        await this.git(
          dir,
          ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message],
          { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email },
        )
      ).trim()
      await this.git(dir, ['update-ref', ref, commit])
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }

    try {
      await this.git(dir, ['push', '--quiet', 'origin', `${ref}:${ref}`])
    } catch (err) {
      // The ref stays in the clone, so listConflicts still shows the user's version.
      throw loggedError('push_failed', `Could not push conflict branch ${ref}`, err)
    }
    return ref
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private repoDir(space: string): string {
    return join(this.reposDir, space)
  }

  private requireClone(space: string): string {
    assertSpace(space)
    const dir = this.repoDir(space)
    // Deliberately not not_found: callers read not_found on a path as "the file was deleted".
    if (!existsSync(join(dir, '.git'))) {
      throw new HearthError('internal', `Space ${space} has no clone; call ensureClone first`)
    }
    return dir
  }

  /** Runs a mutation under the space lock; on failure, returns the clone to a clean state. */
  private write<T>(space: string, fn: (dir: string) => Promise<T>): Promise<T> {
    return this.locks.run(space, async () => {
      const dir = this.requireClone(space)
      try {
        return await fn(dir)
      } catch (err) {
        await this.recover(dir).catch(() => {
          // The original error is the one worth reporting; ensureClone recovers again later.
        })
        throw err
      }
    })
  }

  /**
   * At startup, before anything else touches a clone: lock files left by a git process that was
   * killed (deploy, OOM, timeout) are removed, then every clone gets the same recovery as
   * `ensureClone`. Only at startup: while running, a lock may belong to a live background git.
   */
  async recoverClones(log: (message: string) => void = console.error): Promise<void> {
    for (const space of await this.listClones()) {
      await this.locks
        .run(space, async () => {
          await removeStaleLocks(join(this.repoDir(space), '.git'))
          await this.recover(this.repoDir(space))
        })
        .catch((err) => log(`recovering ${space}: ${err instanceof Error ? err.message : err}`))
    }
  }

  /** Waits for every queued write on every clone to finish (shutdown). */
  async drain(): Promise<void> {
    await Promise.all(
      (await this.listClones()).map((space) => this.locks.run(space, async () => {})),
    )
  }

  /**
   * Aborts a half-finished rebase and discards uncommitted work-tree changes. Commits are kept.
   */
  private async recover(dir: string): Promise<void> {
    if (this.rebaseInProgress(dir)) await this.git(dir, ['rebase', '--abort'])
    if ((await this.revParse(dir, 'HEAD')) !== null) {
      await this.git(dir, ['reset', '--quiet', '--hard', 'HEAD'])
    } else {
      await this.git(dir, ['read-tree', '--empty'])
    }
    await this.git(dir, ['clean', '-fdq'])
  }

  private git(dir: string, args: string[], env?: Record<string, string>): Promise<string> {
    // Hearth is the committer of everything it writes, rebased commits included.
    return runGit(dir, args, {
      GIT_COMMITTER_NAME: this.committer.name,
      GIT_COMMITTER_EMAIL: this.committer.email,
      ...env,
    })
  }

  private async revParse(dir: string, rev: string): Promise<string | null> {
    try {
      return (await this.git(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).trim()
    } catch (err) {
      if (err instanceof GitError && err.exitCode === 1) return null
      throw err
    }
  }

  private async isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.git(dir, ['merge-base', '--is-ancestor', ancestor, descendant])
      return true
    } catch (err) {
      if (err instanceof GitError && err.exitCode === 1) return false
      throw err
    }
  }

  /** The tree entry for `path` at `rev`, or null when the path or the revision does not exist. */
  private async treeEntry(dir: string, rev: string, path: string): Promise<TreeEntry | null> {
    try {
      const out = await this.git(dir, ['ls-tree', '-z', '--long', rev, '--', path])
      return parseLsTree(out).find((e) => e.path === path) ?? null
    } catch (err) {
      if (err instanceof GitError && err.exitCode === 128) return null
      throw err
    }
  }

  private async blobAt(
    dir: string,
    rev: string,
    path: string,
  ): Promise<{ blobOid: string; content: string } | null> {
    const entry = await this.treeEntry(dir, rev, path)
    if (entry === null || !isRegularFile(entry)) return null
    return { blobOid: entry.oid, content: await this.blobContent(dir, entry.oid) }
  }

  private async blobContent(dir: string, oid: string): Promise<string> {
    try {
      return await this.git(dir, ['cat-file', 'blob', oid])
    } catch (err) {
      if (err instanceof GitError && err.exitCode === 128) {
        throw new HearthError('bad_request', `Unknown blob ${oid}`)
      }
      throw err
    }
  }

  private async treeFilesUnder(dir: string, folder: string): Promise<TreeEntry[]> {
    const out = await this.git(dir, ['ls-tree', '-r', '-z', '--long', 'HEAD', '--', folder])
    return parseLsTree(out).filter((e) => e.path.startsWith(`${folder}/`))
  }

  /** The only place Hearth writes into a work tree; every path is re-checked here. */
  private async writeChanges(dir: string, changes: Change[]): Promise<void> {
    const paths = changes.map((c) => c.path)
    for (const path of paths) assertRepoPath(path)
    if ((await this.revParse(dir, 'HEAD')) !== null) {
      const out = await this.git(dir, ['ls-tree', '-z', '--long', 'HEAD', '--', ...paths])
      const notFile = parseLsTree(out).find((e) => paths.includes(e.path) && !isRegularFile(e))
      if (notFile) {
        throw new HearthError(
          'bad_request',
          `Refusing to write ${notFile.path}: not a regular file`,
        )
      }
    }
    for (const path of paths) await assertSafeWorktreePath(dir, path)

    const written: string[] = []
    const deleted: string[] = []
    for (const change of changes) {
      const file = join(dir, change.path)
      if (change.content === null) {
        await rm(file, { force: true })
        deleted.push(change.path)
      } else {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, change.content)
        written.push(change.path)
      }
    }
    if (written.length > 0) await this.git(dir, ['add', '--', ...written])
    if (deleted.length > 0) {
      await this.git(dir, ['rm', '--quiet', '--cached', '--ignore-unmatch', '--', ...deleted])
    }
  }

  private async hasStagedChanges(dir: string): Promise<boolean> {
    try {
      await this.git(dir, ['diff', '--cached', '--quiet'])
      return false
    } catch (err) {
      if (err instanceof GitError && err.exitCode === 1) return true
      throw err
    }
  }

  private async mergeFile(
    dir: string,
    ours: string,
    base: string,
    theirs: string,
  ): Promise<{ clean: boolean; text: string }> {
    const tmp = await mkdtemp(join(tmpdir(), 'hearth-merge-'))
    try {
      const files = {
        ours: join(tmp, 'ours'),
        base: join(tmp, 'base'),
        theirs: join(tmp, 'theirs'),
      }
      await Promise.all([
        writeFile(files.ours, ours),
        writeFile(files.base, base),
        writeFile(files.theirs, theirs),
      ])
      try {
        const text = await this.git(dir, ['merge-file', '-p', files.ours, files.base, files.theirs])
        return { clean: true, text }
      } catch (err) {
        // Exit status 1..127 is the number of conflicts; anything else is a real failure.
        if (
          err instanceof GitError &&
          err.exitCode !== null &&
          err.exitCode > 0 &&
          err.exitCode < 128
        ) {
          return { clean: false, text: err.stdout }
        }
        throw err
      }
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }

  private async diffNames(
    dir: string,
    before: string | null,
    after: string | null,
  ): Promise<string[]> {
    if (after === null || before === after) return []
    const out =
      before === null
        ? await this.git(dir, ['ls-tree', '-r', '-z', '--name-only', after])
        : await this.git(dir, ['diff', '--name-only', '-z', '--no-renames', before, after])
    return out.split('\0').filter(Boolean)
  }

  private rebaseInProgress(dir: string): boolean {
    return (
      existsSync(join(dir, '.git', 'rebase-merge')) || existsSync(join(dir, '.git', 'rebase-apply'))
    )
  }

  /** Runs a rebase command; stopping on a conflict is expected, any other failure is not. */
  private async rebaseStep(dir: string, args: string[]): Promise<void> {
    try {
      await this.git(dir, args)
    } catch (err) {
      if (!this.rebaseInProgress(dir)) throw err
    }
  }

  private async unmergedStages(
    dir: string,
  ): Promise<Map<string, { ours?: string; theirs?: string }>> {
    const out = await this.git(dir, ['ls-files', '--unmerged', '-z'])
    const stages = new Map<string, { ours?: string; theirs?: string }>()
    for (const line of out.split('\0').filter(Boolean)) {
      const match = /^\d+ ([0-9a-f]+) (\d)\t(.*)$/s.exec(line)
      if (!match) continue
      const [, oid = '', stage, path = ''] = match
      const entry = stages.get(path) ?? {}
      if (stage === '2') entry.theirs = oid
      if (stage === '3') entry.ours = oid
      stages.set(path, entry)
    }
    return stages
  }

  private async rebasingAuthor(dir: string): Promise<Author> {
    const out = await this.git(dir, ['log', '-1', '--format=%an%x1f%ae', 'REBASE_HEAD'])
    const [name = '', email = ''] = out.trim().split('\x1f')
    return name && email ? { name, email } : this.committer
  }
}

function parseLsTree(out: string): TreeEntry[] {
  const entries: TreeEntry[] = []
  for (const line of out.split('\0')) {
    // <mode> SP <type> SP <oid> SP+ <size or -> TAB <path>
    const match = /^(\d+) (\w+) ([0-9a-f]+) +(\S+)\t(.*)$/s.exec(line)
    if (!match) continue
    const [, mode = '', type = '', oid = '', size = '-', path = ''] = match
    entries.push({ mode, type, oid, size: size === '-' ? null : Number(size), path })
  }
  return entries
}

/** A blob that is not a symlink. Submodules (commits) and trees are not files either. */
function isRegularFile(e: TreeEntry): boolean {
  return e.type === 'blob' && e.mode !== SYMLINK_MODE
}

function isSpaceName(name: string): boolean {
  try {
    assertSpace(name)
    return true
  } catch {
    return false
  }
}

function isValidRepoPath(path: string): boolean {
  try {
    assertRepoPath(path)
    return true
  } catch {
    return false
  }
}

function fileEntry(path: string, e: TreeEntry): Entry {
  return e.size === null
    ? { path, type: 'file', oid: e.oid }
    : { path, type: 'file', size: e.size, oid: e.oid }
}

function conflictPathFromMessage(message: string): string | null {
  const match = new RegExp(`^${CONFLICT_PATH_TRAILER}: (.+)$`, 'm').exec(message)
  return match?.[1]?.trim() ?? null
}

/**
 * Git's output names server paths and remote URLs, so it goes to the server log in full and
 * clients get `message` alone.
 */
function loggedError(code: ErrorCode, message: string, cause: unknown): HearthError {
  console.error(`${message}:`, cause)
  return new HearthError(code, message)
}

function committedOid(result: CommitResult): string {
  if (result.status === 'conflict') {
    throw new HearthError('internal', 'Unexpected conflict while moving across spaces')
  }
  return result.oid
}

/** `index.lock`, `HEAD.lock`, `packed-refs.lock`, `config.lock` and any lock under `refs/`. */
async function removeStaleLocks(gitDir: string): Promise<void> {
  const top = ['index.lock', 'HEAD.lock', 'packed-refs.lock', 'config.lock', 'ORIG_HEAD.lock']
  await Promise.all(top.map((name) => rm(join(gitDir, name), { force: true })))
  let refs: string[]
  try {
    refs = await readdir(join(gitDir, 'refs'), { recursive: true })
  } catch {
    return
  }
  await Promise.all(
    refs
      .filter((r) => r.endsWith('.lock'))
      .map((r) => rm(join(gitDir, 'refs', r), { force: true })),
  )
}
