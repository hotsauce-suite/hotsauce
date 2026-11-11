import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HearthError } from '../../src/errors.js'
import {
  Index,
  Indexer,
  indexPath,
  type SearchHit,
  SNIPPET_CLOSE,
  SNIPPET_OPEN,
} from '../../src/index/index.js'
import { MIGRATIONS, migrate } from '../../src/index/schema.js'
import { personalCorpus, teamCorpus } from '../fixtures/corpus.js'
import { blobOid, MemoryGit } from '../fixtures/memory-git.js'

let dir: string
let file: string
let index: Index
let git: MemoryGit
let indexer: Indexer

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-index-'))
  file = indexPath(dir)
  index = new Index(file)
  git = new MemoryGit()
  git.seed('team', teamCorpus)
  git.seed('morgan', personalCorpus)
  indexer = new Indexer(git, index)
})

afterEach(() => {
  index.close()
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
})

const paths = (hits: SearchHit[]) => hits.map((h) => `${h.space}:${h.path}`)

describe('Index database', () => {
  it('is a WAL-mode file with sqlite-vec loaded', () => {
    expect(index.vecVersion()).toMatch(/^v\d+\.\d+/)
    const raw = new Database(file, { readonly: true })
    expect(raw.pragma('journal_mode', { simple: true })).toBe('wal')
    raw.close()
  })

  it('records the schema version and does not re-run migrations on reopen', async () => {
    await indexer.full('team')
    index.close()
    index = new Index(file)
    expect(index.getFile('team', 'docs/roadmap.md')?.title).toBe('Roadmap')

    const raw = new Database(file, { readonly: true })
    expect(raw.prepare('SELECT version FROM schema_version').pluck().get()).toBe(MIGRATIONS.length)
    raw.close()
  })

  it('applies only migrations newer than the recorded version', () => {
    index.close()
    const raw = new Database(file)
    migrate(raw, [...MIGRATIONS, 'CREATE TABLE extra (x INTEGER)'])
    expect(raw.prepare('SELECT version FROM schema_version').pluck().get()).toBe(
      MIGRATIONS.length + 1,
    )
    expect(
      raw.prepare("SELECT count(*) FROM sqlite_master WHERE name = 'extra'").pluck().get(),
    ).toBe(1)
    raw.close()
    index = new Index(':memory:') // keep afterEach's close() valid
  })

  it('migrates a v1 index: meetings kinds split, sync points forgotten so the next sync re-indexes', () => {
    index.close()
    fs.rmSync(file)
    const raw = new Database(file)
    migrate(raw, MIGRATIONS.slice(0, 1))
    const insert = raw.prepare(
      `INSERT INTO files (space, path, id, kind, title, body, blob_oid, size, mtime)
       VALUES ('team', ?, NULL, ?, 't', 'b', 'x', 1, 'now')`,
    )
    insert.run('meetings/2026/10/a.md', 'meetings')
    insert.run('meetings/2026/10/a.transcript.md', 'meetings')
    insert.run('docs/b.md', 'docs')
    raw.prepare("INSERT INTO sync_state VALUES ('team', 'abc', 'now')").run()
    raw.close()

    index = new Index(file)
    expect(index.getFile('team', 'meetings/2026/10/a.md')).toMatchObject({
      kind: 'meeting',
      frontmatter: null,
    })
    expect(index.getFile('team', 'meetings/2026/10/a.transcript.md')?.kind).toBe('transcript')
    expect(index.getFile('team', 'docs/b.md')?.kind).toBe('docs')
    expect(index.getSyncState('team')).toBeNull()
  })

  it('refuses a database written by a newer build', () => {
    index.close()
    const raw = new Database(file)
    raw.prepare('UPDATE schema_version SET version = 99').run()
    raw.close()
    expect(() => new Index(file)).toThrow(/newer than this build/)
    index = new Index(':memory:') // keep afterEach's close() valid
  })
})

describe('Indexer', () => {
  it('full() indexes markdown outside hidden folders with title, kind and id', async () => {
    await indexer.full('team')

    expect(index.getFile('team', 'docs/roadmap.md')).toMatchObject({
      id: '01JROADMAP0000000000000000',
      kind: 'docs',
      title: 'Roadmap',
      blobOid: blobOid(teamCorpus['docs/roadmap.md'] ?? ''),
    })
    expect(index.getFile('team', 'docs/hiring/plan.md')).toMatchObject({
      id: null,
      kind: 'docs',
      title: 'Hiring plan',
    })
    expect(index.getFile('team', 'docs/loose-thoughts.md')?.title).toBe('loose-thoughts')
    expect(index.getFile('team', 'meetings/2026/10/2026-10-07-standup.md')).toMatchObject({
      kind: 'meeting',
      title: 'Standup',
      frontmatter: {
        id: '01JSTANDUP0000000000000000',
        type: 'meeting',
        title: 'Standup',
        date: '2026-10-07',
      },
    })
    expect(index.getFile('team', 'docs/hiring/plan.md')?.frontmatter).toBeNull()
    expect(index.getFile('team', 'README.md')?.kind).toBe('other')

    expect(index.getFile('team', '.hearth/docs/FORMAT.md')).toBeNull()
    expect(index.getFile('team', '.trash/2026-10-01/docs/old-roadmap.md')).toBeNull()
    expect(index.getFile('team', 'assets/2026/10/logo-01JLOGO00.png')).toBeNull()

    expect(index.getSyncState('team')?.headOid).toBe(await git.headOid('team'))
  })

  it('full() replaces rows that no longer exist in git', async () => {
    index.upsertFiles('team', [{ path: 'docs/stale.md', content: '# Stale\n', blobOid: 'x' }])
    await indexer.full('team')
    expect(index.getFile('team', 'docs/stale.md')).toBeNull()
    expect(index.search('stale', { spaces: ['team'] })).toEqual([])
  })

  it('full() of one space leaves other spaces alone', async () => {
    await indexer.full('team')
    await indexer.full('morgan')
    git.write('team', 'docs/roadmap.md', null)
    await indexer.full('team')
    expect(index.getFile('morgan', 'docs/diary.md')).not.toBeNull()
  })

  it('incremental() upserts changed files and adds new ones', async () => {
    await indexer.full('team')
    git.write('team', 'docs/roadmap.md', '---\ntitle: Roadmap 2027\n---\nNow with lasers.\n')
    git.write('team', 'docs/new.md', '# Brand new\n\nAbout photonics.\n')
    await indexer.incremental('team', ['docs/roadmap.md', 'docs/new.md'])

    expect(index.getFile('team', 'docs/roadmap.md')?.title).toBe('Roadmap 2027')
    expect(paths(index.search('lasers', { spaces: ['team'] }))).toEqual(['team:docs/roadmap.md'])
    expect(index.search('quarter', { spaces: ['team'] })).toEqual([])
    expect(paths(index.search('photonics', { spaces: ['team'] }))).toEqual(['team:docs/new.md'])
    expect(index.getSyncState('team')?.headOid).toBe(await git.headOid('team'))
  })

  it('incremental() removes files that are gone', async () => {
    await indexer.full('team')
    git.write('team', 'docs/hiring/plan.md', null)
    await indexer.incremental('team', ['docs/hiring/plan.md'])

    expect(index.getFile('team', 'docs/hiring/plan.md')).toBeNull()
    expect(index.search('scientists', { spaces: ['team'] })).toEqual([])
  })

  it('incremental() ignores paths that are not indexable', async () => {
    await indexer.full('team')
    git.write('team', '.trash/2026-10-07/docs/roadmap.md', '# Trashed roadmap\n')
    git.write('team', 'assets/x.png', 'png')
    await indexer.incremental('team', ['.trash/2026-10-07/docs/roadmap.md', 'assets/x.png'])
    expect(index.getFile('team', '.trash/2026-10-07/docs/roadmap.md')).toBeNull()
    expect(index.getFile('team', 'assets/x.png')).toBeNull()
  })

  it('full() indexes a repo with no commits as empty and records no sync point', async () => {
    class EmptyGit extends MemoryGit {
      override async headOid(space: string): Promise<string> {
        throw new HearthError('not_found', `Space ${space} has no commits yet`)
      }
    }
    await indexer.full('team')
    expect(index.getFile('team', 'docs/roadmap.md')).not.toBeNull()
    const syncState = index.getSyncState('team')

    const empty = new EmptyGit()
    await empty.ensureClone('team', 'file:///remotes/team.git')
    await new Indexer(empty, index).full('team')

    expect(index.getFile('team', 'docs/roadmap.md')).toBeNull()
    expect(index.getSyncState('team')).toEqual(syncState)
  })

  it('propagates git errors other than not_found', async () => {
    class BrokenGit extends MemoryGit {
      override async readFile(): Promise<{ content: string; blobOid: string }> {
        throw new Error('git exploded')
      }
    }
    const broken = new BrokenGit()
    broken.seed('team', teamCorpus)
    await expect(
      new Indexer(broken, index).incremental('team', ['docs/roadmap.md']),
    ).rejects.toThrow('git exploded')
  })
})

describe('search', () => {
  beforeEach(async () => {
    await indexer.full('team')
    await indexer.full('morgan')
  })

  it('ranks a title hit above a body hit', () => {
    expect(paths(index.search('roadmap', { spaces: ['team'] }))).toEqual([
      'team:docs/roadmap.md',
      'team:docs/hiring/plan.md',
    ])
  })

  it('returns scores where higher is better', () => {
    const [first, second] = index.search('roadmap', { spaces: ['team'] })
    expect(first?.score).toBeGreaterThan(second?.score ?? Number.POSITIVE_INFINITY)
  })

  it('filters to the given spaces', () => {
    expect(index.search('zebrafish', { spaces: ['team'] })).toEqual([])
    expect(paths(index.search('zebrafish', { spaces: ['morgan'] }))).toEqual([
      'morgan:docs/diary.md',
    ])
    expect(paths(index.search('zebrafish', { spaces: ['team', 'morgan'] }))).toEqual([
      'morgan:docs/diary.md',
    ])
  })

  it('never returns a word from a space outside the filter', () => {
    const hits = index.search('plan', { spaces: ['team'] })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.space === 'team')).toBe(true)
    expect(index.search('plan', { spaces: ['jo'] })).toEqual([])
  })

  it('returns nothing for an empty space list', () => {
    expect(index.search('roadmap', { spaces: [] })).toEqual([])
  })

  it('highlights matches in the body snippet', () => {
    const [hit] = index.search('scientists', { spaces: ['team'] })
    expect(hit?.title).toBe('Hiring plan')
    expect(hit?.snippet).toContain(`${SNIPPET_OPEN}scientists${SNIPPET_CLOSE}`)
  })

  it('matches prefixes, stems and exact phrases', () => {
    expect(paths(index.search('sequenc', { spaces: ['team'] }))).toEqual([
      'team:meetings/2026/10/2026-10-07-standup.md',
    ])
    expect(paths(index.search('scientist', { spaces: ['team'] }))).toEqual([
      'team:docs/hiring/plan.md',
    ])
    expect(index.search('"sequencer budget"', { spaces: ['team'] })).toHaveLength(1)
    expect(index.search('"budget sequencer"', { spaces: ['team'] })).toEqual([])
  })

  it('ANDs terms', () => {
    expect(paths(index.search('hiring scientists', { spaces: ['team'] }))).toEqual([
      'team:docs/hiring/plan.md',
    ])
  })

  it('never throws on hostile input', () => {
    const inputs = [
      '"',
      '""',
      '"unterminated phrase',
      'a"b"c',
      "it's",
      'title:roadmap',
      'body: x',
      'NEAR(roadmap plan, 2)',
      'roadmap OR',
      'AND',
      'NOT NOT',
      '*',
      'plan*',
      '^roadmap',
      '-roadmap',
      '+roadmap',
      '(roadmap',
      'roadmap)',
      '{title body}: x',
      "'; DROP TABLE files; --",
      '\u0000',
      '\\',
      '🔥 roadmap',
      'x'.repeat(5000),
    ]
    for (const q of inputs) {
      expect(() => index.search(q, { spaces: ['team'] }), q).not.toThrow()
    }
    expect(index.getFile('team', 'docs/roadmap.md')).not.toBeNull()
  })

  it('clamps the limit', () => {
    expect(index.search('plan', { spaces: ['team'], limit: 1 })).toHaveLength(1)
    expect(index.search('plan', { spaces: ['team'], limit: 0 })).toHaveLength(1)
    expect(index.search('plan', { spaces: ['team'], limit: -5 })).toHaveLength(1)
  })
})

describe('meetings: listFiles, filtered search and passage ranking', () => {
  const note = (title: string, date: string, body: string) =>
    `---\nid: 01J${title.toUpperCase()}\ntype: meeting\ntitle: ${title}\ndate: ${date}\n` +
    `attendees:\n  - Dana Lee <dana@acme.com>\n---\n# ${title}\n\n${body}\n`

  beforeEach(async () => {
    git.write(
      'team',
      'meetings/2026/10/2026-10-08-acme.md',
      note('Acme', '2026-10-08T09:00:00-04:00', 'SSO before rollout.'),
    )
    git.write(
      'team',
      'meetings/2026/10/2026-10-08-acme.transcript.md',
      '[00:00:01] **Them:** We need SSO.\n',
    )
    git.write(
      'team',
      'meetings/clients/2026-10-01-beta.md',
      note('Beta', '2026-10-01T09:00:00-04:00', 'Pricing talk.'),
    )
    git.write(
      'team',
      'meetings/clients/2026-10-05-gamma.md',
      note('Gamma', '2026-10-05T09:00:00-04:00', 'SSO pricing.'),
    )
    await indexer.full('team')
  })

  it('lists one space by kind and prefix, by path or newest date first', () => {
    const list = (opts: Partial<Parameters<Index['listFiles']>[0]>) =>
      index.listFiles({ space: 'team', ...opts }).map((f) => f.path)

    expect(list({ kind: 'meeting' })).toEqual([
      'meetings/2026/10/2026-10-07-standup.md',
      'meetings/2026/10/2026-10-08-acme.md',
      'meetings/clients/2026-10-01-beta.md',
      'meetings/clients/2026-10-05-gamma.md',
    ])
    expect(list({ kind: 'meeting', order: 'date_desc' })).toEqual([
      'meetings/2026/10/2026-10-08-acme.md',
      'meetings/2026/10/2026-10-07-standup.md',
      'meetings/clients/2026-10-05-gamma.md',
      'meetings/clients/2026-10-01-beta.md',
    ])
    expect(list({ kind: 'transcript' })).toEqual(['meetings/2026/10/2026-10-08-acme.transcript.md'])
    expect(list({ prefix: 'meetings/clients/', limit: 1 })).toEqual([
      'meetings/clients/2026-10-01-beta.md',
    ])
    expect(list({ space: 'morgan', kind: 'meeting' })).toEqual([])
    expect(
      index.listFiles({ space: 'team', prefix: 'meetings/2026/10/2026-10-08-acme.md' })[0]
        ?.frontmatter,
    ).toMatchObject({
      attendees: ['Dana Lee <dana@acme.com>'],
    })
  })

  it('filters search by kind and prefix, and can match any word', () => {
    const search = (q: string, opts: Partial<Parameters<Index['search']>[1]> = {}) =>
      paths(index.search(q, { spaces: ['team', 'morgan'], ...opts }))

    expect(search('sso', { kinds: ['transcript'] })).toEqual([
      'team:meetings/2026/10/2026-10-08-acme.transcript.md',
    ])
    expect(search('sso', { kinds: ['meeting'], prefix: 'meetings/clients/' })).toEqual([
      'team:meetings/clients/2026-10-05-gamma.md',
    ])
    expect(search('sso pricing', { kinds: ['meeting'] })).toEqual([
      'team:meetings/clients/2026-10-05-gamma.md',
    ])
    // Both words rank first; either word alone still matches.
    const [first, ...rest] = search('What about SSO pricing?', {
      kinds: ['meeting'],
      anyTerm: true,
    })
    expect(first).toBe('team:meetings/clients/2026-10-05-gamma.md')
    expect(rest.sort()).toEqual([
      'team:meetings/2026/10/2026-10-08-acme.md',
      'team:meetings/clients/2026-10-01-beta.md',
    ])
  })

  it('ranks passages by bm25 over any word, and leaves nothing behind', () => {
    const passages = ['We talked about lunch.', 'SSO and pricing, again SSO.', 'Pricing only.']
    const ranked = index.rankPassages('What about SSO pricing?', passages, 10)
    expect(ranked.map((r) => r.index)).toEqual([1, 2])
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0)
    expect(index.rankPassages('pricing', passages, 1).map((r) => r.index)).toEqual([2])
    expect(index.rankPassages('lunch', ['x'], 5)).toEqual([])
    expect(index.rankPassages('?!', passages, 5)).toEqual([])
  })
})

describe('sync state, conflicts, recents and stars', () => {
  it('stores sync state per space', () => {
    expect(index.getSyncState('team')).toBeNull()
    index.setSyncState('team', 'abc')
    index.setSyncState('team', 'def')
    expect(index.getSyncState('team')?.headOid).toBe('def')
    expect(index.getSyncState('morgan')).toBeNull()
  })

  it('tracks conflicts per space', () => {
    index.addConflict('team', 'refs/heads/conflicts/01A', 'docs/a.md')
    index.addConflict('team', 'refs/heads/conflicts/01A', 'docs/a.md')
    index.addConflict('morgan', 'refs/heads/conflicts/01B', 'docs/b.md')
    expect(index.listConflicts('team')).toEqual([
      { ref: 'refs/heads/conflicts/01A', path: 'docs/a.md', createdAt: expect.any(String) },
    ])
    index.removeConflict('team', 'refs/heads/conflicts/01A')
    expect(index.listConflicts('team')).toEqual([])
    expect(index.listConflicts('morgan')).toHaveLength(1)
  })

  it('lists recents newest first with titles when indexed', async () => {
    await indexer.full('team')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-07T10:00:00Z'))
    index.touchRecent('u1', 'team', 'docs/roadmap.md')
    vi.setSystemTime(new Date('2026-10-07T11:00:00Z'))
    index.touchRecent('u1', 'team', 'docs/gone.md')
    index.touchRecent('u2', 'team', 'docs/hiring/plan.md')
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'))
    index.touchRecent('u1', 'team', 'docs/roadmap.md')

    expect(index.listRecents('u1')).toEqual([
      {
        space: 'team',
        path: 'docs/roadmap.md',
        title: 'Roadmap',
        openedAt: '2026-10-07T12:00:00.000Z',
      },
      { space: 'team', path: 'docs/gone.md', title: null, openedAt: '2026-10-07T11:00:00.000Z' },
    ])
    expect(index.listRecents('u1', 1)).toHaveLength(1)
  })

  it('stars and unstars per user', async () => {
    await indexer.full('team')
    index.setStarred('u1', 'team', 'docs/roadmap.md', true)
    index.setStarred('u1', 'team', 'docs/roadmap.md', true)
    index.setStarred('u1', 'team', 'docs/hiring/plan.md', true)
    index.setStarred('u2', 'team', 'README.md', true)
    index.setStarred('u1', 'team', 'docs/hiring/plan.md', false)
    expect(index.listStars('u1')).toEqual([
      { space: 'team', path: 'docs/roadmap.md', title: 'Roadmap' },
    ])
  })

  it('keeps recents and stars across a reindex', async () => {
    await indexer.full('team')
    index.setStarred('u1', 'team', 'docs/roadmap.md', true)
    await indexer.full('team')
    expect(index.listStars('u1')).toHaveLength(1)
  })
})

describe('space registry', () => {
  it('upserts, gets and lists spaces, keeping the first createdAt', () => {
    index.upsertSpace({ name: 'team', kind: 'team', ownerEmail: null })
    index.upsertSpace({ name: 'morgan', kind: 'personal', ownerEmail: 'morgan@example.test' })
    const created = index.getSpace('morgan')?.createdAt
    index.upsertSpace({ name: 'morgan', kind: 'personal', ownerEmail: 'morgan@example.test' })

    expect(index.getSpace('morgan')).toEqual({
      name: 'morgan',
      kind: 'personal',
      ownerEmail: 'morgan@example.test',
      createdAt: created,
    })
    expect(index.getSpace('nobody')).toBeNull()
    expect(index.listSpaces().map((s) => s.name)).toEqual(['morgan', 'team'])
  })

  it('requires an owner for personal spaces and none for team', () => {
    expect(() => index.upsertSpace({ name: 'x', kind: 'personal', ownerEmail: null })).toThrow(
      /CHECK constraint/,
    )
    expect(() =>
      index.upsertSpace({ name: 'team', kind: 'team', ownerEmail: 'a@example.test' }),
    ).toThrow(/CHECK constraint/)
  })

  it('survives a reindex of the space', async () => {
    index.upsertSpace({ name: 'team', kind: 'team', ownerEmail: null })
    await indexer.full('team')
    expect(index.getSpace('team')).not.toBeNull()
  })
})
