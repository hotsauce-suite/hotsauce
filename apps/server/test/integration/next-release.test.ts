// scripts/next-release.mjs (docs/PLAN-auto-releases.md): releases number themselves from the
// newest tag, patch by default, minor for features, and docs-only merges release nothing.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../../../../scripts/next-release.mjs', import.meta.url))
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.test',
}
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, env: ENV, encoding: 'utf8' }).trim()

let repo: string

async function commit(files: Record<string, string>, message = 'change') {
  for (const [f, c] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, f)), { recursive: true })
    await writeFile(path.join(repo, f), c)
  }
  git('add', '-A')
  git('commit', '-q', '-m', message)
}

function next(...flags: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...flags], {
    cwd: repo,
    env: ENV,
    encoding: 'utf8',
  })
  return {
    code: r.status,
    out: r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null,
    err: r.stderr,
  }
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'next-release-'))
  git('init', '-q', '-b', 'main')
  await commit({ HOTSAUCE_VERSION: '0.15.0\n', 'apps/server/src/a.ts': 'one\n' }, 'Release 0.15.0')
  git('tag', 'v0.15.0')
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('next-release', () => {
  it('makes a patch release for an ordinary change', async () => {
    await commit({ 'apps/server/src/a.ts': 'two\n' })
    expect(next().out).toEqual({ release: true, last: '0.15.0', version: '0.15.1', bump: 'patch' })
  })

  it('makes a minor release for a feature', async () => {
    await commit({ 'apps/web/src/b.tsx': 'x\n' })
    expect(next('--feature').out).toMatchObject({ release: true, version: '0.16.0', bump: 'minor' })
  })

  it('releases nothing when only docs, site, CI, e2e or Mac app sources changed', async () => {
    await commit({
      'docs/learnings/releases.md': 'x\n',
      'CONTRIBUTING.md': 'x\n',
      'site/public/index.html': 'x\n',
      '.github/workflows/ci.yml': 'x\n',
      'e2e/a.spec.ts': 'x\n',
      'apps/dictate-mac/Sources/App.swift': 'x\n',
    })
    expect(next().out).toMatchObject({ release: false, last: '0.15.0' })
  })

  it('releases when the built Mac app (which goes into the image) changes', async () => {
    await commit({ 'apps/dictate-mac/release/Hotsauce.zip': 'zip\n' })
    expect(next().out).toMatchObject({ release: true, version: '0.15.1' })
  })

  it('treats a markdown file inside an app as code', async () => {
    await commit({ 'apps/web/src/help/intro.md': 'x\n' })
    expect(next().out).toMatchObject({ release: true })
  })

  it('releases docs-only changes when forced by hand', async () => {
    await commit({ 'docs/a.md': 'x\n' })
    expect(next('--force').out).toMatchObject({ release: true, version: '0.15.1' })
  })

  it('makes no second release after its own version commit', async () => {
    // The robot's push starts the Release workflow again; that run waits for this one, which tags.
    await commit({ 'apps/server/src/a.ts': 'two\n' })
    await commit({ HOTSAUCE_VERSION: '0.15.1\n' }, 'Release 0.15.1')
    git('tag', 'v0.15.1')
    expect(next().out).toMatchObject({ release: false, last: '0.15.1' })
  })

  it('makes no release for the notes a release commit writes (N4)', async () => {
    await commit({ 'WHATS_NEW.json': '{"releases":[]}\n' })
    expect(next().out).toMatchObject({ release: false })
  })

  it('picks the same number again when the last release wrote its number but never tagged', async () => {
    await commit({ 'apps/server/src/a.ts': 'two\n' })
    await commit({ HOTSAUCE_VERSION: '0.15.1\n' }, 'Release 0.15.1') // image build failed: no tag
    await commit({ 'apps/server/src/a.ts': 'three\n' })
    expect(next().out).toMatchObject({ release: true, version: '0.15.1' })
  })

  it('finishes an unfinished feature release with its own number', async () => {
    await commit({ 'apps/server/src/a.ts': 'two\n' })
    await commit({ HOTSAUCE_VERSION: '0.16.0\n' }, 'Release 0.16.0') // hand-run feature, build failed
    expect(next().out).toMatchObject({ release: true, version: '0.16.0', bump: 'unfinished' })
  })

  it('finishes an unfinished forced docs-only release', async () => {
    await commit({ 'docs/a.md': 'x\n' })
    await commit({ HOTSAUCE_VERSION: '0.15.1\n' }, 'Release 0.15.1')
    expect(next().out).toMatchObject({ release: true, version: '0.15.1' })
  })

  it('releases nothing for test files and scripts outside the image', async () => {
    await commit({
      'apps/server/test/integration/x.test.ts': 'x\n',
      'apps/web/src/a.test.tsx': 'x\n',
      'scripts/next-release.mjs': 'x\n',
    })
    expect(next().out).toMatchObject({ release: false })
  })

  it('numbers two releases back to back', async () => {
    await commit({ 'apps/server/src/a.ts': 'two\n' })
    expect(next().out.version).toBe('0.15.1')
    await commit({ HOTSAUCE_VERSION: '0.15.1\n' }, 'Release 0.15.1')
    git('tag', 'v0.15.1')
    await commit({ 'apps/server/src/a.ts': 'three\n' })
    expect(next().out).toMatchObject({ last: '0.15.1', version: '0.15.2' })
  })

  it('uses the highest release tag behind main and ignores other tags', async () => {
    git('tag', 'v0.9.9')
    git('tag', 'mac-app')
    git('checkout', '-q', '-b', 'side')
    await commit({ 'apps/server/src/c.ts': 'x\n' })
    git('tag', 'v9.0.0') // not on main
    git('checkout', '-q', 'main')
    await commit({ 'apps/server/src/a.ts': 'two\n' })
    expect(next().out).toMatchObject({ last: '0.15.0', version: '0.15.1' })
  })

  it('fails clearly with no release tag at all', async () => {
    git('tag', '-d', 'v0.15.0')
    const r = next()
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/no release tag/)
  })
})
