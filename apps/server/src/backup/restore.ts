import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import type { ObjectStore } from '../storage/s3.js'
import { BACKUP_TMP, MANIFEST, type Manifest } from './snapshot.js'

const run = promisify(execFile)

/** Where `--force` moves the previous contents, inside the target; never backed up. */
export const ASIDE = '.before-restore-'

/**
 * Puts a backup back (docs/PLAN-backups-storage.md R7, R8): downloads `key`, checks it's one of
 * ours, and unpacks it into `target`, which must be empty or missing. With `force`, what's in
 * `target` is moved aside to `<target>/.before-restore-<time>/` first, never deleted. All work
 * happens inside `target` so every move stays on one disk (a Fly volume is its own filesystem).
 */
export async function restoreBackup(opts: {
  s3: ObjectStore
  key: string
  target: string
  force?: boolean
  now?: Date
}): Promise<{ manifest: Manifest; movedAside?: string }> {
  const target = path.resolve(opts.target)
  const existing = await readdir(target).catch(() => [] as string[])
  const busy = existing.filter(
    (n) => n !== 'lost+found' && n !== BACKUP_TMP && !n.startsWith(ASIDE),
  )
  let movedAside: string | undefined
  if (busy.length > 0 && !opts.force) {
    throw new Error(
      `${target} isn't empty (${busy.slice(0, 5).join(', ')}…). Stop the server and pass --force to move its contents aside.`,
    )
  }
  const work = path.join(target, BACKUP_TMP)
  const download = path.join(work, 'restore.tar.gz')
  const unpack = path.join(work, 'restore')
  await rm(work, { recursive: true, force: true })
  await mkdir(work, { recursive: true })
  try {
    const obj = await opts.s3.get(opts.key)
    if (!obj) throw new Error(`no backup at ${opts.key}`)
    await pipeline(Readable.fromWeb(obj.body as never), createWriteStream(download))
    await mkdir(unpack, { recursive: true })
    await run('tar', ['-xzf', download, '-C', unpack], { maxBuffer: 16 * 1024 * 1024 })
    const manifest = JSON.parse(await readFile(path.join(unpack, MANIFEST), 'utf8')) as Manifest
    if (manifest.format !== 1) throw new Error(`unknown backup format ${String(manifest.format)}`)
    await rm(path.join(unpack, MANIFEST))
    if (busy.length > 0) {
      const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
      movedAside = path.join(target, `${ASIDE}${stamp}`)
      await mkdir(movedAside, { recursive: true })
      for (const name of busy) await rename(path.join(target, name), path.join(movedAside, name))
    }
    // Moved entry by entry, so a mount point (a Fly volume at /data) stays where it is.
    for (const name of await readdir(unpack)) {
      await rename(path.join(unpack, name), path.join(target, name))
    }
    return { manifest, ...(movedAside ? { movedAside } : {}) }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
