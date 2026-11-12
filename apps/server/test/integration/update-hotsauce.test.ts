// scripts/update-hotsauce.mjs (docs/PLAN-cloudflare-deploy.md R12): a copy with no shared history
// is brought up to the newest release, keeping its own edits, or left alone on a collision.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../../../../scripts/update-hotsauce.mjs', import.meta.url))
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.test',
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim()

let root: string
let upstream: string
let copy: string

async function files(dir: string, entries: Record<string, string>) {
  for (const [f, c] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(dir, f)), { recursive: true })
    await writeFile(path.join(dir, f), c)
  }
}

function run(): { code: number; result: Record<string, string> } {
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: copy,
    env: { ...ENV, HOTSAUCE_UPSTREAM: upstream },
    encoding: 'utf8',
  })
  return { code: r.status ?? -1, result: JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'update-hotsauce-'))
  upstream = path.join(root, 'upstream')
  copy = path.join(root, 'copy')
  for (const d of [upstream, copy]) {
    execFileSync('mkdir', ['-p', d])
    git(d, 'init', '-q', '-b', 'main')
  }
  const v1 = {
    'a.txt': 'one\ntwo\nthree\n',
    'README.md': 'Hotsauce\n',
    HOTSAUCE_VERSION: '0.1.0\n',
  }
  await files(upstream, v1)
  git(upstream, 'add', '.')
  git(upstream, 'commit', '-qm', 'v0.1.0')
  git(upstream, 'tag', 'v0.1.0')
  await files(upstream, {
    'a.txt': 'one\nTWO\nthree\n',
    'b.txt': 'new\n',
    '.github/workflows/update.yml': 'on: push\n',
    HOTSAUCE_VERSION: '0.2.0\n',
  })
  git(upstream, 'add', '.')
  git(upstream, 'commit', '-qm', 'v0.2.0')
  git(upstream, 'tag', 'v0.2.0')
  // A copy the Deploy button made: the release's files in a fresh repository.
  await files(copy, v1)
  git(copy, 'add', '.')
  git(copy, 'commit', '-qm', 'Initial commit')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('update-hotsauce', () => {
  it('applies the newest release on a branch and keeps the copy’s own edits', async () => {
    await files(copy, { 'README.md': 'Fieldwork Office\n', 'mine.txt': 'ours\n' })
    git(copy, 'add', '.')
    git(copy, 'commit', '-qm', 'Our changes')

    const { code, result } = run()
    expect(code).toBe(0)
    expect(result).toEqual({
      status: 'ready',
      from: '0.1.0',
      version: '0.2.0',
      branch: 'update-hotsauce/v0.2.0',
      // Workflow files are left for a person: a workflow's own token can't push them.
      workflows: ['.github/workflows/update.yml'],
    })
    await expect(readFile(path.join(copy, '.github/workflows/update.yml'))).rejects.toThrow()
    expect(git(copy, 'branch', '--show-current')).toBe('update-hotsauce/v0.2.0')
    expect(await readFile(path.join(copy, 'a.txt'), 'utf8')).toBe('one\nTWO\nthree\n')
    expect(await readFile(path.join(copy, 'b.txt'), 'utf8')).toBe('new\n')
    expect(await readFile(path.join(copy, 'README.md'), 'utf8')).toBe('Fieldwork Office\n')
    expect(await readFile(path.join(copy, 'mine.txt'), 'utf8')).toBe('ours\n')
    expect((await readFile(path.join(copy, 'HOTSAUCE_VERSION'), 'utf8')).trim()).toBe('0.2.0')
    expect(git(copy, 'status', '--porcelain')).toBe('')

    expect(run().result).toEqual({ status: 'up-to-date', version: '0.2.0' })
  })

  it('leaves the copy alone and says so when the release collides with its edits', async () => {
    await files(copy, { 'a.txt': 'one\nour two\nthree\n' })
    git(copy, 'commit', '-qam', 'Our change to a')
    const head = git(copy, 'rev-parse', 'HEAD')

    const { code, result } = run()
    expect(code).toBe(2)
    expect(result).toEqual({ status: 'conflict', from: '0.1.0', version: '0.2.0' })
    expect(git(copy, 'branch', '--show-current')).toBe('main')
    expect(git(copy, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(copy, 'status', '--porcelain')).toBe('')
  })

  it('reports a version that isn’t a release instead of guessing', async () => {
    await files(copy, { HOTSAUCE_VERSION: '0.0.0\n' })
    git(copy, 'commit', '-qam', 'unreleased')
    const { code, result } = run()
    expect(code).toBe(2)
    expect(result.status).toBe('conflict')
  })
})
