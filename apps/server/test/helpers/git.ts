import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Author } from '../../src/git/index.js'
import { GitError, runGit } from '../../src/git/index.js'

export const HEARTH: Author = { name: 'Hearth', email: 'hearth@example.test' }
export const ALICE: Author = { name: 'Alice Example', email: 'alice@example.test' }
export const OUTSIDE: Author = { name: 'Outside Editor', email: 'outside@example.test' }

export async function makeTempDir(prefix = 'hearth-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

function identity(author: Author): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  }
}

/** The oid `ref` points to in any repository (bare or not), or null if it does not exist. */
export async function refOid(repoDir: string, ref: string): Promise<string | null> {
  try {
    return (await runGit(repoDir, ['rev-parse', '--verify', '--quiet', ref])).trim()
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 1) return null
    throw err
  }
}

/** Reads a file at `rev` straight from a repository, bypassing GitStore. */
export async function catFile(repoDir: string, rev: string, path: string): Promise<string> {
  return runGit(repoDir, ['cat-file', 'blob', `${rev}:${path}`])
}

/** `%an <%ae> | %cn <%ce>` of a commit, to check author and committer separately. */
export async function identities(repoDir: string, rev: string): Promise<string> {
  return (await runGit(repoDir, ['log', '-1', '--format=%an <%ae> | %cn <%ce>', rev])).trim()
}

export async function commitCount(repoDir: string, rev = 'refs/heads/main'): Promise<number> {
  return Number((await runGit(repoDir, ['rev-list', '--count', rev])).trim())
}

/**
 * A separate clone that edits the space the way Obsidian, VS Code, or a script would: it pulls,
 * writes files, commits as its own author, and pushes straight to the remote.
 */
export class OutsideEditor {
  private constructor(readonly dir: string) {}

  static async clone(remoteUrl: string, dir: string): Promise<OutsideEditor> {
    await mkdir(dirname(dir), { recursive: true })
    await runGit(dirname(dir), ['clone', '--quiet', remoteUrl, dir])
    await runGit(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    return new OutsideEditor(dir)
  }

  /** Writes (or, with null, deletes) files on top of the remote's main, commits, and pushes. */
  async push(
    files: Record<string, string | null>,
    message = 'outside edit',
    author = OUTSIDE,
  ): Promise<string> {
    await runGit(this.dir, ['fetch', '--quiet', 'origin'])
    if ((await refOid(this.dir, 'refs/remotes/origin/main')) !== null) {
      await runGit(this.dir, ['reset', '--quiet', '--hard', 'origin/main'])
    }
    for (const [path, content] of Object.entries(files)) {
      const file = join(this.dir, path)
      if (content === null) {
        await runGit(this.dir, ['rm', '--quiet', '--', path])
      } else {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, content)
        await runGit(this.dir, ['add', '--', path])
      }
    }
    await runGit(this.dir, ['commit', '--quiet', '-m', message], identity(author))
    await runGit(this.dir, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
    return (await runGit(this.dir, ['rev-parse', 'HEAD'])).trim()
  }

  /** Commits symlinks (path → absolute target) on top of the remote's main and pushes. */
  async pushSymlinks(links: Record<string, string>, message = 'add symlinks'): Promise<string> {
    await runGit(this.dir, ['fetch', '--quiet', 'origin'])
    await runGit(this.dir, ['reset', '--quiet', '--hard', 'origin/main'])
    for (const [path, target] of Object.entries(links)) {
      const file = join(this.dir, path)
      await mkdir(dirname(file), { recursive: true })
      await symlink(target, file)
      await runGit(this.dir, ['add', '--', path])
    }
    await runGit(this.dir, ['commit', '--quiet', '-m', message], identity(OUTSIDE))
    await runGit(this.dir, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
    return (await runGit(this.dir, ['rev-parse', 'HEAD'])).trim()
  }

  /** Pushes an empty commit with `message` on top of main to `ref`, e.g. a forged conflict branch. */
  async pushEmptyCommit(ref: string, message: string): Promise<void> {
    await runGit(this.dir, ['fetch', '--quiet', 'origin'])
    const tree = (await runGit(this.dir, ['rev-parse', 'origin/main^{tree}'])).trim()
    const parent = (await runGit(this.dir, ['rev-parse', 'origin/main'])).trim()
    const commit = (
      await runGit(this.dir, ['commit-tree', tree, '-p', parent, '-m', message], identity(OUTSIDE))
    ).trim()
    await runGit(this.dir, ['push', '--quiet', 'origin', `${commit}:${ref}`])
  }

  /** The blob oid of `path` on the remote's main, as Hearth's client would have it. */
  async blobOid(path: string): Promise<string> {
    await runGit(this.dir, ['fetch', '--quiet', 'origin'])
    return (await runGit(this.dir, ['rev-parse', `origin/main:${path}`])).trim()
  }
}
