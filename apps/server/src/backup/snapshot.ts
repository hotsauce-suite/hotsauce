import { execFile } from 'node:child_process'
import { link, mkdir, open, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'

const run = promisify(execFile)

/**
 * A backup of DATA_DIR as one `.tar.gz` (docs/PLAN-backups-storage.md R3). Every file is
 * hard-linked into a staging folder on the same disk (instant, no copying), SQLite databases are
 * written there as consistent copies with SQLite's backup API instead, and the system `tar`
 * archives the staging folder. A manifest at the top says what it is.
 *
 * Git repositories (`repos/<space>/` clones and `remotes/<space>.git`) are staged while that
 * space's writes are held (`lockSpace`), then checked with `git fsck --connectivity-only`; a
 * repository that still comes out broken (a background `git gc` mid-repack) is staged again once,
 * and a second failure fails the backup rather than upload a repository that won't clone.
 */

/** The working folder under DATA_DIR; never itself backed up. */
export const BACKUP_TMP = '.backup-tmp'
export const MANIFEST = '.hotsauce-backup.json'

/** Directories (relative to DATA_DIR) left out: temporary, or rebuilt on start. */
const SKIP_DIRS = new Set([
  BACKUP_TMP,
  '.state-tmp',
  'lost+found',
  'clips/uploads',
  'clips/work',
  'file-uploads',
])
const ASIDE = '.before-restore-'

/** Whether `rel` (a POSIX path relative to DATA_DIR) goes in a backup. */
export function inBackup(rel: string): boolean {
  const parts = rel.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false
  // What a restore with --force moved aside (restore.ts).
  if ((parts[0] as string).startsWith(ASIDE)) return false
  for (let i = 1; i <= parts.length; i++) {
    if (SKIP_DIRS.has(parts.slice(0, i).join('/'))) return false
  }
  const base = parts[parts.length - 1] as string
  // The search index rebuilds from the repositories; SQLite side files are folded into the copy.
  if (rel === 'index.sqlite' || rel.startsWith('index.sqlite')) return false
  if (base.endsWith('-wal') || base.endsWith('-shm') || base.endsWith('-journal')) return false
  if (base.endsWith('.tmp') || base.includes('.tmp-') || base.endsWith('.restore-tmp')) return false
  // A git lock file means a write in progress; git recreates what it needs.
  if (base.endsWith('.lock')) return false
  // A live meeting's raw audio is large and still growing; its transcript and meta are kept.
  if (parts[0] === 'sessions' && base.endsWith('.pcm')) return false
  return true
}

/** The space a path belongs to, when it's inside a git repository the server writes. */
export function repoOf(rel: string): { space: string; dir: string } | null {
  const m = rel.match(/^(repos\/([^/]+))\//) ?? rel.match(/^(remotes\/([^/]+)\.git)\//)
  return m ? { space: m[2] as string, dir: m[1] as string } : null
}

const SQLITE_HEADER = 'SQLite format 3\0'

/** A server database outside the repositories, judged by its header, not its name. */
async function isSqlite(rel: string, file: string): Promise<boolean> {
  if (repoOf(rel) || !/\.(sqlite|sqlite3|db)$/.test(rel)) return false
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(16)
    await fh.read(buf, 0, 16, 0)
    return buf.toString('latin1') === SQLITE_HEADER
  } finally {
    await fh.close()
  }
}

export interface Manifest {
  format: 1
  createdAt: string
  files: number
  bytes: number
}

export interface Snapshot extends Manifest {
  /** The archive on disk; the caller removes it. */
  archive: string
}

export interface SnapshotOptions {
  now?: Date
  name?: string
  /** Holds a space's git writes while `fn` runs (GitStore.withSpaceLocked). */
  lockSpace?: <T>(space: string, fn: () => Promise<T>) => Promise<T>
  signal?: AbortSignal
}

/** Writes a backup of `dataDir` to `<dataDir>/.backup-tmp/<name>.tar.gz`. */
export async function createSnapshot(
  dataDir: string,
  opts: SnapshotOptions = {},
): Promise<Snapshot> {
  const now = opts.now ?? new Date()
  const lockSpace = opts.lockSpace ?? (<T>(_: string, fn: () => Promise<T>) => fn())
  const work = path.join(dataDir, BACKUP_TMP)
  const stage = path.join(work, 'stage')
  await rm(work, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })

  const all = await walk(dataDir, '')
  const sizes = await Promise.all(
    all.map((rel) =>
      stat(path.join(dataDir, ...rel.split('/'))).then(
        (s) => s.size,
        () => 0,
      ),
    ),
  )
  const estimate = sizes.reduce((a, b) => a + b, 0)
  // The archive is written to the same disk. Running it out of room would fail the server's own
  // writes, so refuse when the worst case (nothing compresses, as with video) doesn't fit.
  const fs = await statfs(dataDir)
  const free = Number(fs.bavail) * Number(fs.bsize)
  if (free < estimate + 64 * 1024 * 1024) {
    throw new Error(
      `not enough free disk for the backup's temporary file (needs about ${mb(estimate)}, ${mb(free)} free)`,
    )
  }

  const repos = new Map<string, { space: string; files: string[] }>()
  const loose: string[] = []
  for (const rel of all) {
    const repo = repoOf(rel)
    if (!repo) {
      loose.push(rel)
      continue
    }
    const entry = repos.get(repo.dir) ?? { space: repo.space, files: [] }
    entry.files.push(rel)
    repos.set(repo.dir, entry)
  }

  let files = 0
  let bytes = 0
  const stageOne = async (rel: string): Promise<void> => {
    opts.signal?.throwIfAborted()
    const from = path.join(dataDir, ...rel.split('/'))
    const to = path.join(stage, ...rel.split('/'))
    await mkdir(path.dirname(to), { recursive: true })
    try {
      if (await isSqlite(rel, from)) {
        const db = new Database(from, { readonly: true, fileMustExist: true })
        try {
          await db.backup(to)
        } finally {
          db.close()
        }
      } else {
        await link(from, to)
      }
    } catch (err) {
      // Removed between listing and linking (a temp file, a finished upload): not part of it.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    files++
    bytes += (await stat(to)).size
  }

  for (const rel of loose) await stageOne(rel)
  for (const [dir, repo] of repos) {
    for (let attempt = 1; ; attempt++) {
      const before = { files, bytes }
      await lockSpace(repo.space, async () => {
        // Listed again under the lock on a retry: the repository may have changed since.
        for (const rel of attempt === 1 ? repo.files : await walk(dataDir, dir)) {
          await stageOne(rel)
        }
      })
      const problem = await fsckProblem(path.join(stage, ...dir.split('/')))
      if (!problem) break
      if (attempt === 2) throw new Error(`${dir} didn't copy cleanly: ${problem}`)
      await rm(path.join(stage, ...dir.split('/')), { recursive: true, force: true })
      files = before.files
      bytes = before.bytes
    }
  }

  const manifest: Manifest = { format: 1, createdAt: now.toISOString(), files, bytes }
  await writeFile(path.join(stage, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
  const archive = path.join(work, `${opts.name ?? 'backup'}.tar.gz`)
  await tar(['-czf', archive, '-C', stage, '.'], opts.signal)
  await rm(stage, { recursive: true, force: true })
  return { ...manifest, archive }
}

/** null when the staged repository is whole; otherwise git's complaint. */
async function fsckProblem(dir: string): Promise<string | null> {
  const dotGit = path.join(dir, '.git')
  const gitDir = (await stat(dotGit).catch(() => null)) ? dotGit : dir
  if (!(await stat(path.join(gitDir, 'HEAD')).catch(() => null))) return null // not a repository
  try {
    await run('git', ['--git-dir', gitDir, 'fsck', '--connectivity-only', '--no-dangling'], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      maxBuffer: 16 * 1024 * 1024,
    })
    return null
  } catch (err) {
    const e = err as { stderr?: string; message: string }
    return (e.stderr || e.message).trim().split('\n').slice(0, 3).join('; ')
  }
}

/**
 * GNU tar exits 1 when a file changed while it was read (a live meeting's transcript gaining a
 * line): the archive is still good, and that file is as of some moment during the backup.
 */
async function tar(args: string[], signal?: AbortSignal): Promise<void> {
  try {
    await run('tar', args, { maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) })
  } catch (err) {
    const e = err as { code?: number; stderr?: string }
    if (e.code === 1 && /file changed as we read it/.test(e.stderr ?? '')) return
    throw err
  }
}

const mb = (n: number) => `${Math.ceil(n / 1_048_576)} MB`

async function walk(root: string, rel: string): Promise<string[]> {
  const dir = rel ? path.join(root, ...rel.split('/')) : root
  const entries = await readdir(dir, { withFileTypes: true }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return []
      throw err
    },
  )
  const out: string[] = []
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(child) && !child.startsWith(ASIDE)) out.push(...(await walk(root, child)))
    } else if (e.isFile() && inBackup(child)) {
      out.push(child)
    }
  }
  return out
}
