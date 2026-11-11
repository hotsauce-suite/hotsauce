import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertSafeWorktreePath } from './worktree.js'

describe('assertSafeWorktreePath', () => {
  let root: string
  let outside: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hearth-worktree-'))
    outside = await mkdtemp(join(tmpdir(), 'hearth-outside-'))
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'docs', 'a.md'), 'a')
    await symlink(outside, join(root, 'escape'))
    await symlink(join(outside, 'secret'), join(root, 'docs', 'link.md'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('allows existing regular files and paths that do not exist yet', async () => {
    await expect(assertSafeWorktreePath(root, 'docs/a.md')).resolves.toBeUndefined()
    await expect(assertSafeWorktreePath(root, 'docs/new/deeper.md')).resolves.toBeUndefined()
    await expect(assertSafeWorktreePath(root, 'docs', 'dir')).resolves.toBeUndefined()
  })

  it('refuses a path through a symlinked directory', async () => {
    await expect(assertSafeWorktreePath(root, 'escape/x.md')).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('escape is a symlink'),
    })
  })

  it('refuses a final component that is a symlink', async () => {
    await expect(assertSafeWorktreePath(root, 'docs/link.md')).rejects.toMatchObject({
      code: 'bad_request',
    })
  })

  it('refuses writing a file where a directory is, and through a file', async () => {
    await expect(assertSafeWorktreePath(root, 'docs')).rejects.toMatchObject({
      code: 'bad_request',
    })
    await expect(assertSafeWorktreePath(root, 'docs/a.md/x')).rejects.toMatchObject({
      code: 'bad_request',
    })
  })
})
