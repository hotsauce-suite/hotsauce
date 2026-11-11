import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runGit } from '../git/run-git.js'
import { assertNotProduction, assertRepoName } from './shared.js'
import type { HostAdapter } from './types.js'

/** Bare repositories in a local directory, cloned over file://. For tests and `pnpm dev`. */
export class LocalHost implements HostAdapter {
  readonly kind = 'local'
  private readonly dir: string

  constructor(opts: { dir: string }) {
    this.dir = opts.dir
  }

  /** The bare repository's path: `<dir>/<name>.git`. */
  repoPath(name: string): string {
    assertRepoName(name)
    return join(this.dir, `${name}.git`)
  }

  async ensureRepo(name: string): Promise<{ cloneUrl: string }> {
    const path = this.repoPath(name)
    if (!existsSync(path)) {
      await mkdir(path, { recursive: true })
      await runGit(path, ['init', '--quiet', '--bare', '--initial-branch=main'])
    }
    return { cloneUrl: pathToFileURL(path).href }
  }

  async deleteRepo(name: string): Promise<void> {
    assertNotProduction('deleteRepo')
    await rm(this.repoPath(name), { recursive: true, force: true })
  }

  async ensureWebhook(): Promise<void> {}

  parseWebhook(): null {
    return null
  }

  async addCollaborator(): Promise<void> {}
}
