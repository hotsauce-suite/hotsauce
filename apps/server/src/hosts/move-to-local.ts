import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { redactCredentials, runGit } from '../git/index.js'

/**
 * Moves an instance's repositories from its git host (GitHub or Forgejo) to the server's own disk,
 * the layout `HOST_KIND=local` uses (docs/PLAN-backups-storage.md R12): for each space's working
 * clone under `<dataDir>/repos`, a mirror of its current origin becomes
 * `<localDir>/<space>.git`, commits the clone hasn't pushed yet are added, and every branch tip is
 * compared before the space counts as moved; then the clone's origin points at the new home. The
 * old host is only read, never changed, so going
 * back is switching HOST_KIND back. Run it, then restart with HOST_KIND=local.
 */
export interface MovedSpace {
  space: string
  from: string
  branches: number
  /** Commits that were only in the clone and were added to the new repository. */
  unpushed: number
  /** Already there with the same branch tips (a second run). */
  skipped?: boolean
}

export async function moveReposToLocal(opts: {
  dataDir: string
  localDir: string
}): Promise<MovedSpace[]> {
  const reposDir = join(opts.dataDir, 'repos')
  const spaces = (await readdir(reposDir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && existsSync(join(reposDir, e.name, '.git')))
    .map((e) => e.name)
    .sort()
  await mkdir(opts.localDir, { recursive: true })
  const out: MovedSpace[] = []
  for (const space of spaces) {
    const clone = join(reposDir, space)
    const from = (await runGit(clone, ['remote', 'get-url', 'origin'])).trim()
    const target = join(opts.localDir, `${space}.git`)
    if (from === pathToFileURL(target).href || from === target) {
      out.push({ space, from, branches: 0, unpushed: 0, skipped: true })
      continue
    }
    const want = await branchTips(clone, from)
    if (existsSync(target)) {
      const have = await branchTips(target, target)
      if (!sameTips(want, have)) {
        throw new Error(
          `${target} already exists with different branches; move it aside and run again`,
        )
      }
    } else {
      const tmp = `${target}.moving`
      await rm(tmp, { recursive: true, force: true })
      await runGit(opts.localDir, ['clone', '--quiet', '--mirror', '--', from, tmp])
      // A mirror remembers where it came from (with the host's token in the URL): drop that.
      await runGit(tmp, ['remote', 'remove', 'origin'])
      await rename(tmp, target)
    }
    const have = await branchTips(target, target)
    if (!sameTips(want, have)) {
      throw new Error(`${space}: the copy's branches don't match ${redactCredentials(from)}`)
    }
    // Commits made on the server and not yet pushed (a host outage) go to the new home too.
    const head = (
      await runGit(clone, ['rev-parse', '--verify', '--quiet', 'refs/heads/main']).catch(() => '')
    ).trim()
    let unpushed = 0
    if (head && head !== want.get('refs/heads/main')) {
      const ahead = want.get('refs/heads/main')
      unpushed = Number(
        (await runGit(clone, ['rev-list', '--count', ahead ? `${ahead}..${head}` : head])).trim(),
      )
      if (unpushed > 0) await runGit(clone, ['push', '--quiet', target, `${head}:refs/heads/main`])
    }
    // Point the clone at its new home now: a personal space is only re-pointed at startup when
    // its owner next signs in, and until then a background write would still push to the old host.
    await runGit(clone, ['remote', 'set-url', 'origin', pathToFileURL(target).href])
    out.push({ space, from: redactCredentials(from), branches: want.size, unpushed })
  }
  return out
}

/** Branch name → commit, for every branch at `url` (the clone's origin, or a bare repository). */
async function branchTips(cwd: string, url: string): Promise<Map<string, string>> {
  const text = await runGit(cwd, ['ls-remote', '--heads', '--', url])
  const tips = new Map<string, string>()
  for (const line of text.split('\n')) {
    const [oid, ref] = line.trim().split(/\s+/)
    if (oid && ref) tips.set(ref, oid)
  }
  return tips
}

function sameTips(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [ref, oid] of a) if (b.get(ref) !== oid) return false
  return true
}
