import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Index } from '../index/index.js'
import { AccountStore, type LegacyMemberLists } from './store.js'

const A = 'a@acme.example'
const B = 'b@acme.example'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'hotsauce-account-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('AccountStore (R1)', () => {
  it('keeps recents, stars and pins per member', () => {
    const s = new AccountStore(':memory:')
    s.touchRecent(A, 'team', 'a.md')
    s.touchRecent(A, 'team', 'b.md')
    s.touchRecent(B, 'team', 'c.md')
    expect(s.listRecents(A, 20).map((r) => r.path)).toEqual(['b.md', 'a.md'])
    expect(s.listRecents(A, 1)).toHaveLength(1)

    s.setStarred(A, 'team', 'z.md', true)
    s.setStarred(A, 'alice', 'y.md', true)
    s.setStarred(A, 'team', 'z.md', true)
    expect(s.listStars(A)).toEqual([
      { space: 'alice', path: 'y.md' },
      { space: 'team', path: 'z.md' },
    ])
    s.setStarred(A, 'team', 'z.md', false)
    expect(s.listStars(A)).toEqual([{ space: 'alice', path: 'y.md' }])
    expect(s.listStars(B)).toEqual([])

    expect(s.getPins(A)).toBeNull()
    s.setPins(A, ['tasks', 'docs'])
    expect(s.getPins(A)).toEqual(['tasks', 'docs'])
    s.setPins(A, [])
    expect(s.getPins(A)).toEqual([])
    s.close()
  })

  it('keeps them across a restart', () => {
    const file = path.join(dir, 'account.sqlite')
    const s = new AccountStore(file)
    s.setStarred(A, 'team', 'a.md', true)
    s.setPins(A, ['today'])
    s.close()
    const again = new AccountStore(file)
    expect(again.listStars(A)).toEqual([{ space: 'team', path: 'a.md' }])
    expect(again.getPins(A)).toEqual(['today'])
    again.close()
  })

  it('never lowers the saved schema version (a rollback keeps a newer file)', () => {
    const file = path.join(dir, 'account.sqlite')
    new AccountStore(file).close()
    const raw = new Database(file)
    raw.prepare('UPDATE schema_version SET version = 99').run()
    raw.close()
    new AccountStore(file).close()
    const check = new Database(file, { readonly: true })
    expect(check.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 99 })
    check.close()
  })
})

describe('copying from the index (R4)', () => {
  const old: LegacyMemberLists = {
    recents: [{ user: A, space: 'team', path: 'r.md', openedAt: '2026-11-01T00:00:00.000Z' }],
    stars: [
      { user: A, space: 'team', path: 's.md' },
      { user: B, space: 'team', path: 't.md' },
    ],
    pins: [{ user: A, apps: '["tasks","today"]' }],
  }

  it('copies every row on first start; an unstar after it sticks', () => {
    const s = new AccountStore(':memory:')
    expect(s.syncFromIndex(() => old)).toBe('copied')
    expect(s.listRecents(A, 20)).toEqual([
      { space: 'team', path: 'r.md', openedAt: '2026-11-01T00:00:00.000Z' },
    ])
    expect(s.listStars(A)).toEqual([{ space: 'team', path: 's.md' }])
    expect(s.listStars(B)).toEqual([{ space: 'team', path: 't.md' }])
    expect(s.getPins(A)).toEqual(['tasks', 'today'])

    s.setStarred(A, 'team', 's.md', false)
    expect(s.syncFromIndex(() => old)).toBe('unchanged')
    expect(s.listStars(A)).toEqual([])
    s.close()
  })

  it('keeps what is already here over the old copy on first start', () => {
    const s = new AccountStore(':memory:')
    s.setPins(A, ['docs'])
    s.touchRecent(A, 'team', 'r.md')
    s.syncFromIndex(() => old)
    expect(s.getPins(A)).toEqual(['docs'])
    expect(s.listRecents(A, 20)[0]?.openedAt).not.toBe('2026-11-01T00:00:00.000Z')
    s.close()
  })

  it('after a rollback, what members did on the older release comes back on the next upgrade', () => {
    const s = new AccountStore(':memory:')
    s.syncFromIndex(() => old)
    s.setStarred(A, 'team', 'new-here.md', true)
    // The older release ran again: A unstarred s.md and re-pinned; B's lists are unchanged.
    const onOlder: LegacyMemberLists = {
      ...old,
      stars: [{ user: B, space: 'team', path: 't.md' }],
      pins: [{ user: A, apps: '["chat"]' }],
    }
    expect(s.syncFromIndex(() => onOlder)).toBe('replaced')
    expect(s.listStars(A)).toEqual([])
    expect(s.getPins(A)).toEqual(['chat'])
    expect(s.listStars(B)).toEqual([{ space: 'team', path: 't.md' }])
    expect(s.syncFromIndex(() => onOlder)).toBe('unchanged')
    s.close()
  })

  it('ignores old tables a rebuilt index left empty', () => {
    const s = new AccountStore(':memory:')
    s.syncFromIndex(() => old)
    expect(s.syncFromIndex(() => ({ recents: [], stars: [], pins: [] }))).toBe('unchanged')
    expect(s.listStars(A)).toHaveLength(1)
    s.close()
  })

  it('copies nothing and tries again next start when reading the index fails', () => {
    const s = new AccountStore(':memory:')
    expect(() =>
      s.syncFromIndex(() => {
        throw new Error('disk')
      }),
    ).toThrow('disk')
    expect(s.syncFromIndex(() => old)).toBe('copied')
    expect(s.listStars(A)).toHaveLength(1)
    s.close()
  })

  it('reads what an older release left in index.sqlite', () => {
    const file = path.join(dir, 'index.sqlite')
    new Index(file).close()
    const raw = new Database(file)
    raw.prepare('INSERT INTO recents VALUES (?, ?, ?, ?)').run(A, 'team', 'r.md', '2026-11-01')
    raw.prepare('INSERT INTO stars VALUES (?, ?, ?)').run(A, 'team', 's.md')
    raw.prepare('INSERT INTO pins VALUES (?, ?)').run(A, '["chat"]')
    raw.close()
    const index = new Index(file)
    expect(index.legacyMemberLists()).toEqual({
      recents: [{ user: A, space: 'team', path: 'r.md', openedAt: '2026-11-01' }],
      stars: [{ user: A, space: 'team', path: 's.md' }],
      pins: [{ user: A, apps: '["chat"]' }],
    })
    index.close()
  })
})
