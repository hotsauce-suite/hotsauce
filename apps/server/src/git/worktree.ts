import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { HearthError } from '../errors.js'

/**
 * Refuses a work-tree write whose path runs through a symlink: anyone with push access can commit
 * one, and following it would let a Hearth write land outside the clone. Walks every component of
 * `path` under `root` with lstat. Components that don't exist yet are fine (mkdir makes real
 * directories). An existing final component must be a regular file, or a directory when `final`
 * is 'dir' (moving a folder).
 */
export async function assertSafeWorktreePath(
  root: string,
  path: string,
  final: 'file' | 'dir' = 'file',
): Promise<void> {
  const segments = path.split('/')
  let current = root
  for (const [i, segment] of segments.entries()) {
    current = join(current, segment)
    let stat: Awaited<ReturnType<typeof lstat>>
    try {
      stat = await lstat(current)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    const bad = (why: string) =>
      new HearthError('bad_request', `Refusing to write ${JSON.stringify(path)}: ${why}`)
    const shown = segments.slice(0, i + 1).join('/')
    if (stat.isSymbolicLink()) throw bad(`${shown} is a symlink`)
    const isLast = i === segments.length - 1
    if (!isLast && !stat.isDirectory()) throw bad(`${shown} is not a directory`)
    if (isLast && final === 'file' && !stat.isFile()) throw bad(`${shown} is not a regular file`)
    if (isLast && final === 'dir' && !stat.isDirectory()) throw bad(`${shown} is not a directory`)
  }
}
