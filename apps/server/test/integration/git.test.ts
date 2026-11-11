import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { extractLinks, resolveRelative, rewriteLinksForMove } from '@hearth/format'
import { ulid } from 'ulid'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type CommitResult,
  formatCommitMessage,
  GitError,
  GitStore,
  type GitStoreOptions,
  runGit,
} from '../../src/git/index.js'
import { LocalHost } from '../../src/hosts/index.js'
import {
  ALICE,
  catFile,
  commitCount,
  HEARTH,
  identities,
  makeTempDir,
  OutsideEditor,
  refOid,
  removeDir,
} from '../helpers/git.js'

const MAIN = 'refs/heads/main'
const ALICE_BY_HEARTH = 'Alice Example <alice@example.test> | Hearth <hearth@example.test>'

let root: string
let host: LocalHost

beforeEach(async () => {
  root = await makeTempDir()
  host = new LocalHost({ dir: join(root, 'remotes') })
})

afterEach(async () => {
  await removeDir(root)
})

function newStore(opts: Partial<GitStoreOptions> = {}, dataDir = join(root, 'data')): GitStore {
  return new GitStore({ dataDir, committer: HEARTH, ...opts })
}

/** Creates the space's bare remote with `files` pushed by an outside editor, and clones it. */
async function seed(store: GitStore, space: string, files: Record<string, string>) {
  const { cloneUrl } = await host.ensureRepo(space)
  const outside = await OutsideEditor.clone(cloneUrl, join(root, `outside-${space}`))
  const seedOid = await outside.push(files, 'seed')
  await store.ensureClone(space, cloneUrl)
  return { cloneUrl, outside, seedOid, remote: host.repoPath(space) }
}

function edit(path: string, content: string | Uint8Array | null, message = `docs: edit "${path}"`) {
  return { changes: [{ path, content }], author: ALICE, message }
}

function expectStatus<S extends CommitResult['status']>(
  result: CommitResult,
  status: S,
): Extract<CommitResult, { status: S }> {
  expect(result.status).toBe(status)
  return result as Extract<CommitResult, { status: S }>
}

describe('GitStore: reading', () => {
  it('clones, then reads files and lists one level (dirs first) and everything', async () => {
    const store = newStore()
    const { outside, remote } = await seed(store, 'team', {
      'README.md': '# Team\n',
      'docs/plan.md': 'plan\n',
      'docs/notes/a.md': 'a\n',
      'assets/.gitkeep': '',
    })

    expect(await store.headOid('team')).toBe(await refOid(remote, MAIN))
    expect(await store.readFile('team', 'docs/plan.md')).toEqual({
      content: 'plan\n',
      blobOid: await outside.blobOid('docs/plan.md'),
    })
    expect(await store.readFile('team', './docs/plan.md')).toMatchObject({ content: 'plan\n' })

    const top = await store.listTree('team')
    expect(top.map((e) => `${e.type}:${e.path}`)).toEqual([
      'dir:assets',
      'dir:docs',
      'file:README.md',
    ])
    const docs = await store.listTree('team', 'docs')
    expect(docs.map((e) => `${e.type}:${e.path}`)).toEqual(['dir:docs/notes', 'file:docs/plan.md'])
    expect(docs[1]).toMatchObject({ size: 5, oid: await outside.blobOid('docs/plan.md') })
    expect(await store.listTree('team', 'nope')).toEqual([])

    const all = await store.listAll('team')
    expect(all.map((e) => e.path).sort()).toEqual([
      'README.md',
      'assets/.gitkeep',
      'docs/notes/a.md',
      'docs/plan.md',
    ])
    expect(all.every((e) => e.type === 'file' && typeof e.oid === 'string')).toBe(true)
  })

  it('reports not_found for missing files and directories, bad_request for bad paths', async () => {
    const store = newStore()
    await seed(store, 'team', { 'docs/a.md': 'a\n' })
    await expect(store.readFile('team', 'docs/missing.md')).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(store.readFile('team', 'docs')).rejects.toMatchObject({ code: 'not_found' })
    await expect(store.readFile('team', '../secret')).rejects.toMatchObject({ code: 'bad_request' })
    await expect(store.readFile('team', '.git/config')).rejects.toMatchObject({
      code: 'bad_request',
    })
  })

  it('shows old versions and diffs between commits', async () => {
    const store = newStore()
    const { seedOid } = await seed(store, 'team', { 'docs/a.md': 'one\n' })
    const result = expectStatus(await store.commit('team', edit('docs/a.md', 'two\n')), 'committed')

    expect(await store.show('team', seedOid, 'docs/a.md')).toBe('one\n')
    const diff = await store.diff('team', seedOid, result.oid, 'docs/a.md')
    expect(diff).toContain('-one')
    expect(diff).toContain('+two')
    await expect(store.show('team', '--output=/tmp/x', 'docs/a.md')).rejects.toMatchObject({
      code: 'bad_request',
    })
    await expect(store.show('team', 'deadbeef', 'docs/a.md')).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})

describe('GitStore: binary files, changed paths, clones', () => {
  it('commits bytes and reads them back unchanged with readBlob', async () => {
    const store = newStore()
    const { remote } = await seed(store, 'team', { 'README.md': 'team\n' })
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a, 0x0d, 0x80])

    const result = expectStatus(
      await store.commit('team', edit('assets/2026/10/pixel-ABCD1234.png', bytes)),
      'committed',
    )

    const blob = await store.readBlob('team', 'assets/2026/10/pixel-ABCD1234.png')
    expect(blob.blobOid).toBe(result.blobOid)
    expect(Buffer.compare(blob.content, Buffer.from(bytes))).toBe(0)
    const raw = await runGit(remote, [
      'cat-file',
      '-s',
      `${MAIN}:assets/2026/10/pixel-ABCD1234.png`,
    ])
    expect(Number(raw.trim())).toBe(bytes.length)
    await expect(store.readBlob('team', 'assets/missing.png')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('lists the paths changed between two commits, and not_found for an unknown one', async () => {
    const store = newStore()
    const { seedOid } = await seed(store, 'team', { 'docs/a.md': 'a\n', 'docs/b.md': 'b\n' })
    await store.commit('team', edit('docs/a.md', 'a2\n'))
    await store.move('team', 'docs/b.md', 'docs/c.md', ALICE)
    const head = await store.headOid('team')

    expect((await store.changedPaths('team', seedOid, head)).sort()).toEqual([
      'docs/a.md',
      'docs/b.md',
      'docs/c.md',
    ])
    expect(await store.changedPaths('team', head, head)).toEqual([])
    await expect(store.changedPaths('team', '0'.repeat(40), head)).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('lists the spaces that have a clone', async () => {
    const store = newStore()
    expect(await store.listClones()).toEqual([])
    await seed(store, 'team', { 'README.md': 'team\n' })
    await seed(store, 'alice', { 'README.md': 'alice\n' })
    expect(await store.listClones()).toEqual(['alice', 'team'])
  })
})

describe('GitStore: an empty remote', () => {
  it('lists nothing, then the first commit creates and pushes main', async () => {
    const store = newStore()
    const { cloneUrl } = await host.ensureRepo('alice')
    await store.ensureClone('alice', cloneUrl)

    expect(await store.listAll('alice')).toEqual([])
    expect(await store.listTree('alice')).toEqual([])
    expect(await store.log('alice')).toEqual([])
    await expect(store.headOid('alice')).rejects.toMatchObject({ code: 'not_found' })
    expect(await store.sync('alice')).toEqual({ changed: false, headOid: '', paths: [] })

    const result = await store.commit('alice', {
      changes: [
        { path: 'README.md', content: '# Alice\n' },
        { path: 'docs/.gitkeep', content: '' },
      ],
      author: ALICE,
      message: 'hearth: create space',
    })
    const committed = expectStatus(result, 'committed')
    expect(await refOid(host.repoPath('alice'), MAIN)).toBe(committed.oid)
    expect((await store.listAll('alice')).map((e) => e.path)).toEqual([
      'README.md',
      'docs/.gitkeep',
    ])
  })

  it('catches up when someone else pushes the first commit after we cloned', async () => {
    const store = newStore()
    const { cloneUrl } = await host.ensureRepo('alice')
    await store.ensureClone('alice', cloneUrl)
    const outside = await OutsideEditor.clone(cloneUrl, join(root, 'outside-alice'))
    const outsideOid = await outside.push({ 'README.md': '# From outside\n' })

    const result = expectStatus(await store.commit('alice', edit('docs/a.md', 'a\n')), 'committed')

    expect((await runGit(host.repoPath('alice'), ['rev-parse', `${result.oid}^`])).trim()).toBe(
      outsideOid,
    )
    expect((await store.readFile('alice', 'README.md')).content).toBe('# From outside\n')
  })
})

describe('GitStore: commit', () => {
  it('records the human as author and Hearth as committer, and pushes', async () => {
    const store = newStore()
    const { remote } = await seed(store, 'team', { 'docs/a.md': 'one\n' })
    const message = formatCommitMessage({ app: 'docs', verb: 'edit', title: 'A' })

    const result = expectStatus(
      await store.commit('team', edit('docs/a.md', 'two\n', message)),
      'committed',
    )

    expect(await refOid(remote, MAIN)).toBe(result.oid)
    expect(await identities(remote, result.oid)).toBe(ALICE_BY_HEARTH)
    expect(await catFile(remote, MAIN, 'docs/a.md')).toBe('two\n')
    expect(result.blobOid).toBe((await store.readFile('team', 'docs/a.md')).blobOid)
    expect((await store.log('team', { limit: 1 }))[0]).toMatchObject({
      oid: result.oid,
      author: ALICE,
      message: 'docs: edit "A"',
    })
  })

  it('commits nothing for an empty diff and returns the current HEAD', async () => {
    const store = newStore()
    const { remote, seedOid } = await seed(store, 'team', { 'docs/a.md': 'one\n' })
    const result = await store.commit('team', edit('docs/a.md', 'one\n'))
    expect(result).toEqual({
      status: 'committed',
      oid: seedOid,
      blobOid: (await store.readFile('team', 'docs/a.md')).blobOid,
    })
    expect(await commitCount(remote)).toBe(1)
  })

  it('deletes files, and treats deleting a missing file as a no-op', async () => {
    const store = newStore()
    const { remote } = await seed(store, 'team', { 'docs/a.md': 'a\n', 'docs/b.md': 'b\n' })
    const result = expectStatus(await store.commit('team', edit('docs/a.md', null)), 'committed')
    expect(result.blobOid).toBe('')
    await expect(store.readFile('team', 'docs/a.md')).rejects.toMatchObject({ code: 'not_found' })
    expect(await commitCount(remote)).toBe(2)

    await store.commit('team', edit('docs/never.md', null))
    expect(await commitCount(remote)).toBe(2)
  })

  it('merges a stale edit with a concurrent outside change to another line', async () => {
    const store = newStore()
    const path = 'docs/a.md'
    const { outside, remote } = await seed(store, 'team', { [path]: 'l1\nl2\nl3\nl4\nl5\n' })
    const base = await store.readFile('team', path)
    await outside.push({ [path]: 'l1 outside\nl2\nl3\nl4\nl5\n' })

    const result = await store.commit('team', {
      ...edit(path, 'l1\nl2\nl3\nl4\nl5 alice\n'),
      base: { path, blobOid: base.blobOid },
    })

    const expected = 'l1 outside\nl2\nl3\nl4\nl5 alice\n'
    const merged = expectStatus(result, 'merged')
    expect(merged.content).toBe(expected)
    expect(await catFile(remote, MAIN, path)).toBe(expected)
    expect(merged.blobOid).toBe(await outside.blobOid(path))
    expect(merged.oid).toBe(await refOid(remote, MAIN))
  })

  it('parks a true conflict on a conflict branch, leaving main alone, until resolved', async () => {
    const store = newStore()
    const path = 'docs/a.md'
    const { outside, remote } = await seed(store, 'team', {
      [path]: 'title\nshared\nl3\nl4\nend\n',
    })
    const base = await store.readFile('team', path)
    const theirs = 'title\nshared (outside)\nl3\nl4\nend\n'
    const outsideOid = await outside.push({ [path]: theirs })
    const ours = 'title\nshared (alice)\nl3\nl4\nend\n'

    const conflict = expectStatus(
      await store.commit('team', { ...edit(path, ours), base: { path, blobOid: base.blobOid } }),
      'conflict',
    )

    expect(conflict.ours).toEqual({ content: ours })
    expect(conflict.theirs).toEqual({ content: theirs, blobOid: await outside.blobOid(path) })
    expect(await refOid(remote, MAIN)).toBe(outsideOid)
    expect(conflict.conflictRef).toMatch(/^refs\/heads\/conflicts\/[0-9A-Z]{26}$/)
    expect(await catFile(remote, conflict.conflictRef, path)).toBe(ours)
    expect(await identities(remote, conflict.conflictRef)).toBe(ALICE_BY_HEARTH)
    expect(await store.listConflicts('team')).toEqual([
      { ref: conflict.conflictRef, path, createdAt: expect.any(String) },
    ])

    // A fresh clone (say, after losing the volume) brings the conflict back from the remote.
    const fresh = newStore({}, join(root, 'data-fresh'))
    await fresh.ensureClone('team', (await host.ensureRepo('team')).cloneUrl)
    expect((await fresh.listConflicts('team')).map((c) => c.ref)).toEqual([conflict.conflictRef])

    // Someone edits another line before Alice resolves; the resolution must not undo it.
    await outside.push({ [path]: 'title\nshared (outside)\nl3\nl4\nend (later)\n' })
    const resolved = await store.resolveConflict(
      'team',
      conflict.conflictRef,
      { content: 'title\nshared (both)\nl3\nl4\nend\n' },
      ALICE,
    )

    const merged = expectStatus(resolved, 'merged')
    expect(merged.content).toBe('title\nshared (both)\nl3\nl4\nend (later)\n')
    expect(await catFile(remote, MAIN, path)).toBe(merged.content)
    expect(await identities(remote, MAIN)).toBe(ALICE_BY_HEARTH)
    expect(await refOid(remote, conflict.conflictRef)).toBeNull()
    expect(await store.listConflicts('team')).toEqual([])
    await expect(
      store.resolveConflict('team', conflict.conflictRef, { content: 'x' }, ALICE),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('fast-forwards over an outside push, then commits on top of it', async () => {
    const store = newStore()
    const { outside, remote } = await seed(store, 'team', { 'docs/a.md': 'a\n' })
    const outsideOid = await outside.push({ 'docs/b.md': 'b\n' })

    const result = expectStatus(await store.commit('team', edit('docs/a.md', 'a2\n')), 'committed')

    expect((await runGit(remote, ['rev-parse', `${result.oid}^`])).trim()).toBe(outsideOid)
    expect(await catFile(remote, MAIN, 'docs/b.md')).toBe('b\n')
    expect(await catFile(remote, MAIN, 'docs/a.md')).toBe('a2\n')
  })

  it('retries when another push lands between our fetch and our push', async () => {
    let outside: OutsideEditor | undefined
    let pushes = 0
    const store = newStore({
      beforePush: async () => {
        pushes++
        if (pushes === 1) await outside?.push({ 'docs/b.md': 'raced\n' }, 'racing push')
      },
    })
    const seeded = await seed(store, 'team', { 'docs/a.md': 'a\n' })
    outside = seeded.outside

    const result = expectStatus(await store.commit('team', edit('docs/a.md', 'a2\n')), 'committed')

    expect(pushes).toBe(2)
    expect(await refOid(seeded.remote, MAIN)).toBe(result.oid)
    expect((await store.log('team')).map((c) => c.message)).toEqual([
      'docs: edit "docs/a.md"',
      'racing push',
      'seed',
    ])
    expect(await catFile(seeded.remote, MAIN, 'docs/b.md')).toBe('raced\n')
    expect(await catFile(seeded.remote, MAIN, 'docs/a.md')).toBe('a2\n')
  })

  it('gives up with push_failed after three lost races, leaving the clone usable', async () => {
    let outside: OutsideEditor | undefined
    let racing = true
    let pushes = 0
    const store = newStore({
      beforePush: async () => {
        pushes++
        if (racing) await outside?.push({ 'docs/b.md': `race ${pushes}\n` }, `race ${pushes}`)
      },
    })
    const seeded = await seed(store, 'team', { 'docs/a.md': 'a\n' })
    outside = seeded.outside

    await expect(store.commit('team', edit('docs/a.md', 'a2\n'))).rejects.toMatchObject({
      code: 'push_failed',
    })
    expect(pushes).toBe(3)
    expect(await catFile(seeded.remote, MAIN, 'docs/a.md')).toBe('a\n')

    racing = false
    expectStatus(await store.commit('team', edit('docs/a.md', 'a3\n')), 'committed')
    expect(await catFile(seeded.remote, MAIN, 'docs/a.md')).toBe('a3\n')
    expect(await catFile(seeded.remote, MAIN, 'docs/b.md')).toBe('race 3\n')
  })

  it('serializes concurrent commits to one space', async () => {
    const store = newStore()
    const { remote } = await seed(store, 'team', { 'docs/a.md': 'a\n' })
    const results = await Promise.all([
      store.commit('team', edit('docs/a.md', 'a2\n')),
      store.commit('team', edit('docs/b.md', 'b\n')),
      store.commit('team', edit('docs/c.md', 'c\n')),
    ])
    expect(results.map((r) => r.status)).toEqual(['committed', 'committed', 'committed'])
    expect(await commitCount(remote)).toBe(4)
  })
})

describe('GitStore: sync', () => {
  it('returns the paths an outside push changed, then nothing when up to date', async () => {
    const store = newStore()
    const { outside, remote } = await seed(store, 'team', {
      'docs/a.md': 'a\n',
      'docs/b.md': 'b\n',
      'docs/c.md': 'c\n',
    })
    await outside.push({ 'docs/a.md': 'a2\n', 'docs/b.md': null, 'docs/new.md': 'n\n' })

    const headOid = await refOid(remote, MAIN)
    expect(await store.sync('team')).toEqual({
      changed: true,
      headOid,
      paths: ['docs/a.md', 'docs/b.md', 'docs/new.md'],
    })
    expect(await store.sync('team')).toEqual({ changed: false, headOid, paths: [] })
    expect((await store.readFile('team', 'docs/a.md')).content).toBe('a2\n')
  })

  it('rebases a commit whose push failed onto outside pushes, and pushes it', async () => {
    let remote = ''
    let pushBroken = true
    const store = newStore({
      // Simulates the host being unreachable at push time (after a successful fetch).
      beforePush: async () => {
        if (pushBroken) await rename(remote, `${remote}.away`)
      },
    })
    const seeded = await seed(store, 'team', { 'docs/a.md': 'a\n', 'docs/b.md': 'b\n' })
    remote = seeded.remote

    await expect(store.commit('team', edit('docs/a.md', 'a (alice)\n'))).rejects.toMatchObject({
      code: 'push_failed',
    })
    await rename(`${remote}.away`, remote)
    pushBroken = false
    await seeded.outside.push({ 'docs/b.md': 'b (outside)\n' })

    const result = await store.sync('team')

    expect(result).toEqual({
      changed: true,
      headOid: await refOid(remote, MAIN),
      paths: ['docs/b.md'],
    })
    expect(await catFile(remote, MAIN, 'docs/a.md')).toBe('a (alice)\n')
    expect(await catFile(remote, MAIN, 'docs/b.md')).toBe('b (outside)\n')
    expect(await identities(remote, MAIN)).toBe(ALICE_BY_HEARTH)
  })

  it('on a rebase conflict, keeps our version on a conflict branch and takes theirs', async () => {
    let remote = ''
    let pushBroken = true
    const store = newStore({
      beforePush: async () => {
        if (pushBroken) await rename(remote, `${remote}.away`)
      },
    })
    const seeded = await seed(store, 'team', { 'docs/a.md': 'a\n' })
    remote = seeded.remote

    await expect(store.commit('team', edit('docs/a.md', 'a (alice)\n'))).rejects.toMatchObject({
      code: 'push_failed',
    })
    await rename(`${remote}.away`, remote)
    pushBroken = false
    const outsideOid = await seeded.outside.push({ 'docs/a.md': 'a (outside)\n' })

    const result = await store.sync('team')

    expect(result).toEqual({ changed: true, headOid: outsideOid, paths: ['docs/a.md'] })
    expect(await refOid(remote, MAIN)).toBe(outsideOid)
    const conflicts = await store.listConflicts('team')
    expect(conflicts.map((c) => c.path)).toEqual(['docs/a.md'])
    const ref = conflicts[0]?.ref ?? ''
    expect(await catFile(remote, ref, 'docs/a.md')).toBe('a (alice)\n')
    expect(await identities(remote, ref)).toBe(ALICE_BY_HEARTH)
  })

  it('adopts history rewritten on the host instead of pushing the old commits back', async () => {
    const store = newStore()
    const { remote, seedOid } = await seed(store, 'team', { 'docs/a.md': 'a\n' })
    await store.commit('team', edit('docs/a.md', 'a2\n'))
    // Someone force-pushes main back one commit (to drop a bad commit, say).
    await runGit(remote, ['update-ref', MAIN, seedOid])

    const result = await store.sync('team')

    expect(result).toEqual({ changed: true, headOid: seedOid, paths: ['docs/a.md'] })
    expect(await store.headOid('team')).toBe(seedOid)
    expect(await refOid(remote, MAIN)).toBe(seedOid)
    expect((await store.readFile('team', 'docs/a.md')).content).toBe('a\n')
  })

  it('replays only unpushed commits onto history rewritten on the host', async () => {
    let remote = ''
    let pushBroken = false
    const store = newStore({
      beforePush: async () => {
        if (pushBroken) await rename(remote, `${remote}.away`)
      },
    })
    const seeded = await seed(store, 'team', { 'docs/a.md': 'a\n', 'docs/b.md': 'b\n' })
    remote = seeded.remote
    await store.commit('team', edit('docs/a.md', 'a2\n'))
    pushBroken = true
    await expect(store.commit('team', edit('docs/b.md', 'b (alice)\n'))).rejects.toMatchObject({
      code: 'push_failed',
    })
    await rename(`${remote}.away`, remote)
    pushBroken = false
    // The pushed commit is dropped on the host; the unpushed one must survive, and only it.
    await runGit(remote, ['update-ref', MAIN, seeded.seedOid])

    const result = await store.sync('team')

    const head = await refOid(remote, MAIN)
    expect(result.headOid).toBe(head)
    expect((await runGit(remote, ['rev-parse', `${head}^`])).trim()).toBe(seeded.seedOid)
    expect(await catFile(remote, MAIN, 'docs/a.md')).toBe('a\n')
    expect(await catFile(remote, MAIN, 'docs/b.md')).toBe('b (alice)\n')
    expect(await identities(remote, MAIN)).toBe(ALICE_BY_HEARTH)
  })
})

describe('GitStore: move', () => {
  it('moves a file, rewriting its own links through rewriteLinks', async () => {
    const rewriteLinks = vi.fn(
      (markdown: string, oldPath: string, newPath: string) =>
        `${markdown}<!-- ${oldPath} -> ${newPath} -->\n`,
    )
    const store = newStore({ rewriteLinks })
    const { remote } = await seed(store, 'team', { 'docs/a.md': '[b](b.md)\n', 'docs/b.md': 'b\n' })

    const { oid } = await store.move('team', 'docs/a.md', 'notes/a.md', ALICE)

    expect(rewriteLinks).toHaveBeenCalledTimes(1)
    expect(rewriteLinks).toHaveBeenCalledWith('[b](b.md)\n', 'docs/a.md', 'notes/a.md')
    expect(oid).toBe(await refOid(remote, MAIN))
    expect(await catFile(remote, MAIN, 'notes/a.md')).toBe(
      '[b](b.md)\n<!-- docs/a.md -> notes/a.md -->\n',
    )
    await expect(store.readFile('team', 'docs/a.md')).rejects.toMatchObject({ code: 'not_found' })
    expect(await identities(remote, oid)).toBe(ALICE_BY_HEARTH)
  })

  it('moves a folder, rewriting every markdown file in it', async () => {
    const rewriteLinks = vi.fn((markdown: string) => markdown)
    const store = newStore({ rewriteLinks })
    await seed(store, 'team', {
      'docs/a.md': 'a\n',
      'docs/sub/b.md': 'b\n',
      'docs/img.png': 'png',
    })

    await store.move('team', 'docs', 'archive/docs', ALICE)

    const folder = { from: 'docs', to: 'archive/docs' }
    expect(rewriteLinks.mock.calls.map((c) => c.slice(1))).toEqual([
      ['docs/a.md', 'archive/docs/a.md', folder],
      ['docs/sub/b.md', 'archive/docs/sub/b.md', folder],
    ])
    expect((await store.listAll('team')).map((e) => e.path)).toEqual([
      'archive/docs/a.md',
      'archive/docs/img.png',
      'archive/docs/sub/b.md',
    ])
  })

  it('keeps links between files of a moved folder, and fixes links out of it', async () => {
    const store = newStore({ rewriteLinks: rewriteLinksForMove })
    const plan =
      '# Plan\n\nSee [spec](spec.md), ![diagram](img/diagram.png) and [the readme](../../README.md).\n'
    const { remote } = await seed(store, 'team', {
      'README.md': '# Team\n',
      'docs/projects/plan.md': plan,
      'docs/projects/spec.md': '# Spec\n\nBack to [plan](plan.md).\n',
      'docs/projects/img/diagram.png': 'png',
    })

    await store.move('team', 'docs/projects', 'docs/archive/projects', ALICE)

    const moved = await catFile(remote, MAIN, 'docs/archive/projects/plan.md')
    expect(moved).toBe(plan.replace('../../README.md', '../../../README.md'))
    expect(await catFile(remote, MAIN, 'docs/archive/projects/spec.md')).toBe(
      '# Spec\n\nBack to [plan](plan.md).\n',
    )
    const files = new Set((await store.listAll('team')).map((e) => e.path))
    for (const link of extractLinks(moved)) {
      expect(files, link.href).toContain(
        resolveRelative('docs/archive/projects/plan.md', link.href),
      )
    }
  })

  it("commits extra changes computed at the move's base in the same commit", async () => {
    const store = newStore()
    const { remote, outside } = await seed(store, 'team', {
      'docs/a.md': '[b](b.md)\n',
      'docs/b.md': 'b\n',
    })
    // Lands after our clone, so the extra changes must be computed after catching up.
    await outside.push({ 'docs/a.md': 'See [b](b.md)\n' })
    const seen: string[] = []

    const { oid } = await store.move(
      'team',
      'docs/b.md',
      'docs/archive/b.md',
      ALICE,
      async (head) => {
        const a = await store.readFile('team', 'docs/a.md', head)
        seen.push(a.content)
        return [{ path: 'docs/a.md', content: a.content.replace('b.md', 'archive/b.md') }]
      },
    )

    expect(seen).toEqual(['See [b](b.md)\n'])
    expect(await catFile(remote, MAIN, 'docs/a.md')).toBe('See [b](archive/b.md)\n')
    expect(await catFile(remote, MAIN, 'docs/archive/b.md')).toBe('b\n')
    expect(oid).toBe(await refOid(remote, MAIN))
    // seed, the outside push, and one commit for the move with its extra change
    expect(await commitCount(remote)).toBe(3)
  })

  it('refuses extra changes to the moved paths', async () => {
    const store = newStore()
    await seed(store, 'team', { 'docs/a.md': 'a\n' })
    await expect(
      store.move('team', 'docs/a.md', 'docs/b.md', ALICE, async () => [
        { path: 'docs/b.md', content: 'sneaky\n' },
      ]),
    ).rejects.toMatchObject({ code: 'bad_request' })
    expect((await store.readFile('team', 'docs/a.md')).content).toBe('a\n')
  })

  it('refuses a missing source, an existing target, and moving a folder into itself', async () => {
    const store = newStore()
    await seed(store, 'team', { 'docs/a.md': 'a\n', 'docs/b.md': 'b\n' })
    await expect(store.move('team', 'docs/x.md', 'docs/y.md', ALICE)).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(store.move('team', 'docs/a.md', 'docs/b.md', ALICE)).rejects.toMatchObject({
      code: 'conflict',
    })
    await expect(store.move('team', 'docs', 'docs/inner', ALICE)).rejects.toMatchObject({
      code: 'bad_request',
    })
  })

  it('log --follow tracks a file across a move and reads the Hearth-Label trailer', async () => {
    const store = newStore()
    await seed(store, 'team', { 'docs/draft.md': 'v1\nsome more text\n' })
    await store.commit('team', {
      ...edit('docs/draft.md', 'v2\nsome more text\n'),
      message: formatCommitMessage({
        app: 'docs',
        verb: 'edit',
        title: 'Draft',
        label: 'First cut',
      }),
    })
    await store.move('team', 'docs/draft.md', 'docs/final.md', ALICE)
    await store.commit('team', edit('docs/final.md', 'v3\nsome more text\n', 'docs: edit "Final"'))
    await store.commit('team', edit('docs/other.md', 'unrelated\n'))

    const history = await store.log('team', { path: 'docs/final.md' })

    expect(history.map((c) => c.message)).toEqual([
      'docs: edit "Final"',
      'hearth: move "docs/draft.md" to "docs/final.md"',
      'docs: edit "Draft"',
      'seed',
    ])
    expect(history[2]?.label).toBe('First cut')
    expect(history[0]).not.toHaveProperty('label')
    expect(history[0]?.author).toEqual(ALICE)
    expect(await store.log('team', { path: 'docs/final.md', limit: 2 })).toHaveLength(2)
  })

  it('moves across spaces: adds to the target, then removes from the source', async () => {
    const store = newStore()
    const personal = await seed(store, 'alice', { 'docs/idea.md': 'idea\n', 'docs/keep.md': 'k\n' })
    const team = await seed(store, 'team', { 'README.md': 'team\n' })

    const result = await store.moveAcrossSpaces(
      { space: 'alice', path: 'docs/idea.md' },
      { space: 'team', path: 'docs/shared/idea.md' },
      ALICE,
    )

    expect(result.addedOid).toBe(await refOid(team.remote, MAIN))
    expect(result.removedOid).toBe(await refOid(personal.remote, MAIN))
    expect(await catFile(team.remote, MAIN, 'docs/shared/idea.md')).toBe('idea\n')
    await expect(store.readFile('alice', 'docs/idea.md')).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(await identities(team.remote, MAIN)).toBe(ALICE_BY_HEARTH)
    expect(await identities(personal.remote, MAIN)).toBe(ALICE_BY_HEARTH)

    await expect(
      store.moveAcrossSpaces(
        { space: 'alice', path: 'docs/keep.md' },
        { space: 'team', path: 'README.md' },
        ALICE,
      ),
    ).rejects.toMatchObject({ code: 'conflict' })
    expect((await store.readFile('alice', 'docs/keep.md')).content).toBe('k\n')
  })

  it('moves a binary file across spaces byte for byte', async () => {
    const store = newStore()
    await seed(store, 'alice', { 'README.md': 'alice\n' })
    await seed(store, 'team', { 'README.md': 'team\n' })
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a, 0x0d, 0x80])
    await store.commit('alice', edit('assets/pixel.png', bytes))

    await store.moveAcrossSpaces(
      { space: 'alice', path: 'assets/pixel.png' },
      { space: 'team', path: 'assets/pixel.png' },
      ALICE,
    )

    const shared = await store.readBlob('team', 'assets/pixel.png')
    expect(Buffer.compare(shared.content, Buffer.from(bytes))).toBe(0)
  })

  it('keeps the source when a save lands while it is being moved across spaces', async () => {
    let armed = false
    const store: GitStore = newStore({
      // The save lands after the file was read and added to team, before it is removed.
      beforePush: async (space) => {
        if (space !== 'team' || !armed) return
        armed = false
        await store.commit('alice', edit('docs/idea.md', 'idea, edited\n'))
      },
    })
    const personal = await seed(store, 'alice', { 'docs/idea.md': 'idea\n' })
    const team = await seed(store, 'team', { 'README.md': 'team\n' })
    armed = true

    await expect(
      store.moveAcrossSpaces(
        { space: 'alice', path: 'docs/idea.md' },
        { space: 'team', path: 'docs/shared/idea.md' },
        ALICE,
      ),
    ).rejects.toMatchObject({ code: 'conflict' })

    expect(await catFile(team.remote, MAIN, 'docs/shared/idea.md')).toBe('idea\n')
    expect(await catFile(personal.remote, MAIN, 'docs/idea.md')).toBe('idea, edited\n')
    expect((await store.readFile('alice', 'docs/idea.md')).content).toBe('idea, edited\n')
  })
})

describe('GitStore: saves to a path that has gone', () => {
  it('refuses a save based on a version whose file was moved or deleted, and recreates nothing', async () => {
    const store = newStore()
    await seed(store, 'team', { 'docs/a.md': 'a\n', 'docs/b.md': 'b\n' })
    const a = await store.readFile('team', 'docs/a.md')
    const b = await store.readFile('team', 'docs/b.md')
    await store.move('team', 'docs/a.md', 'docs/moved.md', ALICE)
    await store.commit('team', edit('docs/b.md', null))

    for (const [path, blobOid] of [
      ['docs/a.md', a.blobOid],
      ['docs/b.md', b.blobOid],
    ] as const) {
      await expect(
        store.commit('team', { ...edit(path, 'late edit\n'), base: { path, blobOid } }),
      ).rejects.toMatchObject({ code: 'not_found' })
    }
    expect((await store.listAll('team')).map((e) => e.path).sort()).toEqual(['docs/moved.md'])
  })

  it('still lets a conflict be resolved after main deleted its file, bringing it back', async () => {
    const store = newStore()
    const path = 'docs/a.md'
    const { outside } = await seed(store, 'team', { [path]: 'one\ntwo\n' })
    const base = await store.readFile('team', path)
    await outside.push({ [path]: 'one (outside)\ntwo\n' })
    const conflict = expectStatus(
      await store.commit('team', {
        ...edit(path, 'one (alice)\ntwo\n'),
        base: { path, blobOid: base.blobOid },
      }),
      'conflict',
    )
    await store.commit('team', edit(path, null))

    expectStatus(
      await store.resolveConflict('team', conflict.conflictRef, { content: 'kept\n' }, ALICE),
      'committed',
    )
    expect((await store.readFile('team', path)).content).toBe('kept\n')
    expect(await store.listConflicts('team')).toEqual([])
  })
})

describe('GitStore: crash recovery', () => {
  it('clears lock files a killed git left behind, so the clone takes saves again', async () => {
    const store = newStore()
    await seed(store, 'team', { 'docs/a.md': 'a\n' })
    const gitDir = join(root, 'data', 'repos', 'team', '.git')
    await writeFile(join(gitDir, 'index.lock'), '')
    await writeFile(join(gitDir, 'refs', 'heads', 'main.lock'), '')
    await expect(store.commit('team', edit('docs/a.md', 'stuck\n'))).rejects.toThrow()

    await store.recoverClones()
    expect(existsSync(join(gitDir, 'index.lock'))).toBe(false)
    expect(existsSync(join(gitDir, 'refs', 'heads', 'main.lock'))).toBe(false)
    expectStatus(await store.commit('team', edit('docs/a.md', 'saved\n')), 'committed')
    expect((await store.readFile('team', 'docs/a.md')).content).toBe('saved\n')
  })

  it('drain waits for queued writes', async () => {
    const store = newStore()
    await seed(store, 'team', { 'docs/a.md': 'a\n' })
    let done = false
    const write = store.commit('team', edit('docs/a.md', 'b\n')).then(() => {
      done = true
    })
    await store.drain()
    expect(done).toBe(true)
    await write
  })
})

describe('GitStore: safety', () => {
  it('never follows symlinks pushed from outside: hidden, unreadable, unwritable', async () => {
    const secretDir = await makeTempDir('hearth-secret-')
    try {
      const secretFile = join(secretDir, 'secret.txt')
      await writeFile(secretFile, 'top secret\n')
      const store = newStore()
      const { outside } = await seed(store, 'team', { 'docs/a.md': 'a\n' })
      await outside.pushSymlinks({ 'docs/link.md': secretFile, escape: secretDir })
      await store.sync('team')

      expect((await store.listAll('team')).map((e) => e.path)).toEqual(['docs/a.md'])
      expect((await store.listTree('team')).map((e) => e.path)).toEqual(['docs'])
      expect((await store.listTree('team', 'docs')).map((e) => e.path)).toEqual(['docs/a.md'])
      await expect(store.readFile('team', 'docs/link.md')).rejects.toMatchObject({
        code: 'not_found',
      })
      await expect(store.readFile('team', 'escape/secret.txt')).rejects.toMatchObject({
        code: 'not_found',
      })

      const refused = [
        store.commit('team', edit('docs/link.md', 'pwned\n')),
        store.commit('team', edit('docs/link.md', null)),
        store.commit('team', edit('escape/secret.txt', 'pwned\n')),
        store.commit('team', edit('escape/new.txt', 'pwned\n')),
        store.commit('team', edit('escape/secret.txt', null)),
        store.move('team', 'docs/a.md', 'escape/a.md', ALICE),
        store.move('team', 'docs/link.md', 'docs/moved.md', ALICE),
      ]
      for (const attempt of refused) {
        await expect(attempt).rejects.toMatchObject({ code: 'bad_request' })
      }
      expect(await readFile(secretFile, 'utf8')).toBe('top secret\n')
      expect(existsSync(join(secretDir, 'new.txt'))).toBe(false)
      expect(existsSync(join(secretDir, 'a.md'))).toBe(false)

      // The space keeps working.
      expectStatus(await store.commit('team', edit('docs/a.md', 'a2\n')), 'committed')
    } finally {
      await removeDir(secretDir)
    }
  })

  it('validates conflict paths read back from the repo', async () => {
    const store = newStore()
    const { outside, cloneUrl } = await seed(store, 'team', { 'docs/a.md': 'a\n' })
    const forged = `refs/heads/conflicts/${ulid()}`
    await outside.pushEmptyCommit(forged, 'forged\n\nHearth-Conflict-Path: ../../etc/passwd')

    const fresh = newStore({}, join(root, 'data-fresh'))
    await fresh.ensureClone('team', cloneUrl)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await fresh.listConflicts('team')).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(forged))
    } finally {
      warn.mockRestore()
    }
    await expect(
      fresh.resolveConflict('team', forged, { content: 'x' }, ALICE),
    ).rejects.toMatchObject({
      code: 'bad_request',
    })
  })

  it('logs git’s output in full but keeps it out of error messages', async () => {
    let remote = ''
    let pushBroken = false
    const store = newStore({
      beforePush: async () => {
        if (pushBroken) await rename(remote, `${remote}.away`)
      },
    })
    remote = (await seed(store, 'team', { 'docs/a.md': 'a\n' })).remote
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      pushBroken = true
      await expect(store.commit('team', edit('docs/a.md', 'a2\n'))).rejects.toMatchObject({
        code: 'push_failed',
        message: 'Could not push team to the Git host',
      })
      pushBroken = false
      await expect(store.sync('team')).rejects.toMatchObject({
        code: 'host_error',
        message: 'Could not fetch team from the Git host',
      })
      expect(logged).toHaveBeenCalledTimes(2)
      for (const [, err] of logged.mock.calls) expect(err).toBeInstanceOf(GitError)
    } finally {
      logged.mockRestore()
      await rename(`${remote}.away`, remote)
    }
  })

  it('ensureClone on an existing clone re-points origin and discards half-finished work', async () => {
    const store = newStore()
    const { cloneUrl } = await seed(store, 'team', { 'docs/a.md': 'a\n' })
    const clone = join(root, 'data', 'repos', 'team')
    await writeFile(join(clone, 'docs', 'a.md'), 'half-written')
    await writeFile(join(clone, 'stray.md'), 'stray')

    await store.ensureClone('team', cloneUrl)

    expect(await runGit(clone, ['status', '--porcelain'])).toBe('')
    expect(await readFile(join(clone, 'docs', 'a.md'), 'utf8')).toBe('a\n')
  })
})
