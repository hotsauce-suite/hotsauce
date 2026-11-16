import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { runGit } from '../../src/git/index.js'
import { indexPath } from '../../src/index/index.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// For you (docs/PLAN-comments.md slice 2, R12 and R14 to R18; ARCHITECTURE §27.5) through the API
// with dev auth. The clock For you reads can be moved on, so Later can come due.

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const CAROL = 'carol@example.test'
const DOC = 'docs/pilot-plan.md'
const OTHER = 'docs/budget.md'
const HOUR = 3_600_000

let root: string
let services: Services
let app: ReturnType<typeof createApp>
let shift = 0
let config: ReturnType<typeof loadConfig>

beforeEach(async () => {
  shift = 0
  root = await makeTempDir('hotsauce-for-you-')
  config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    PUBLIC_URL: 'https://hotsauce.example.test',
  })
  await start()
  for (const who of [ALICE, BOB, CAROL]) await api('GET', '/api/me', { as: who })
  await write('team', DOC, '# Pilot plan\n\nThe budget is in section two.\n')
  await write('team', OTHER, '# Budget\n')
})

afterEach(async () => {
  await stop()
  await removeDir(root)
})

async function start(): Promise<void> {
  services = createServices(config, { forYouNow: () => new Date(Date.now() + shift) })
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
}

async function stop(): Promise<void> {
  await services.comments.idle()
  await services.checkinScheduler.close()
  await services.meetings.sessions.close()
  services.meetings.calendarSync?.cache.close()
  services.index.close()
  services.dictation.store.close()
}

// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the assertions
async function api<T = any>(
  method: string,
  path: string,
  opts: { as?: string; json?: unknown; status?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'x-hearth-dev-user': opts.as ?? ALICE }
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  const res = await app.request(path, {
    method,
    headers,
    ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
  })
  const text = await res.text()
  expect(res.status, `${method} ${path} → ${text}`).toBe(opts.status ?? 200)
  return (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as T
}

const write = (space: string, path: string, content: string, as = ALICE) =>
  api('PUT', `/api/spaces/${space}/file`, { as, json: { path, content } })

const comment = (path: string, text: string, as = ALICE) =>
  api('POST', '/api/comments', { as, json: { space: 'team', path, text }, status: 201 })

const forYou = (as = BOB) => api('GET', '/api/for-you', { as })

const mark = (item: string, json: unknown, as = BOB) =>
  api('POST', `/api/for-you/${item}`, { as, json })

describe('the list (R12)', () => {
  it('lists each item that mentions me, newest first, with who, when and where it opens', async () => {
    expect(await forYou()).toEqual({ items: [], unseen: 0, canMark: true })
    const first = await comment(DOC, '@Bob can you check the numbers?')
    await comment(DOC, 'Just a note, nobody named.')
    const later = await comment(OTHER, 'Over to you @bob', CAROL)
    // Naming yourself, or someone else, isn't for Bob.
    await comment(DOC, '@Bob noted, thanks', BOB)
    await comment(OTHER, '@Alice see this', CAROL)

    const view = await forYou()
    expect(view.unseen).toBe(2)
    expect(view.items).toMatchObject([
      {
        item: later.item,
        path: OTHER,
        title: 'Budget',
        kind: 'docs',
        url: `/docs/team/docs/budget.md#comment-${later.id}`,
        comment: { id: later.id, author: CAROL, name: 'Carol', text: 'Over to you @bob' },
        mentions: 1,
        unseen: true,
      },
      { item: first.item, path: DOC, comment: { id: first.id, name: 'Alice' }, mentions: 1 },
    ])
    expect(view.items[0].at).toBe(later.created)
    // Alice's list has Carol's mention only.
    expect((await forYou(ALICE)).items.map((i: { path: string }) => i.path)).toEqual([OTHER])
  })

  it('opens a task or a meeting note where it lives, and drops an item that is deleted', async () => {
    const task = await api('POST', '/api/tasks', {
      json: { title: 'Order pipette tips', space: 'team' },
      status: 201,
    })
    const made = await comment(task.path, '@Bob yours?')
    expect((await forYou()).items[0]).toMatchObject({
      kind: 'task',
      title: 'Order pipette tips',
      url: `/tasks/item/team/${task.id}#comment-${made.id}`,
    })
    await api('DELETE', `/api/tasks/team/${task.id}`, { status: 204 })
    expect((await forYou()).items).toEqual([])
  })

  it('groups an item’s mentions and shows the newest', async () => {
    await comment(DOC, '@Bob one')
    const second = await comment(DOC, '@Bob two', CAROL)
    const [item] = (await forYou()).items
    expect(item).toMatchObject({ mentions: 2, comment: { id: second.id, text: '@Bob two' } })
  })
})

describe('seen, Done and Later (R14, R15, R16)', () => {
  it('opening an item lowers the count and keeps it listed; a new mention counts again', async () => {
    const c = await comment(DOC, '@Bob please look')
    const seen = await mark(c.item, { action: 'seen' })
    expect(seen.unseen).toBe(0)
    expect(seen.items).toMatchObject([{ item: c.item, unseen: false }])
    // Opening it again writes nothing more.
    const commits = await bobLog()
    await mark(c.item, { action: 'seen' })
    expect(await bobLog()).toEqual(commits)
    await comment(DOC, '@Bob and this', CAROL)
    expect((await forYou()).unseen).toBe(1)
  })

  it('Done removes it; a new mention brings it back at the top; Undo puts it back', async () => {
    const a = await comment(DOC, '@Bob first')
    const b = await comment(OTHER, '@Bob second')
    const done = await mark(a.item, { action: 'done' })
    expect(done.items.map((i: { item: string }) => i.item)).toEqual([b.item])
    expect((await mark(a.item, { action: 'undone' })).items).toHaveLength(2)
    await mark(a.item, { action: 'done' })
    await comment(DOC, '@Bob again', CAROL)
    const back = await forYou()
    expect(back.items.map((i: { item: string }) => i.item)).toEqual([a.item, b.item])
    expect(back.items[0].unseen).toBe(true)
  })

  it('Later hides it until 9 AM in my zone, then it is back at the top and counts', async () => {
    const a = await comment(DOC, '@Bob first')
    const b = await comment(OTHER, '@Bob second')
    await mark(a.item, { action: 'seen' })
    const hidden = await mark(a.item, { action: 'later', when: 'tomorrow', zone: 'UTC' })
    expect(hidden.items.map((i: { item: string }) => i.item)).toEqual([b.item])
    // 9 AM tomorrow, UTC: at most 33 hours away.
    shift = 34 * HOUR
    const back = await forYou()
    expect(back.items.map((i: { item: string }) => i.item)).toEqual([a.item, b.item])
    expect(back.items[0]).toMatchObject({ unseen: true })
    expect(back.items[0].at.endsWith('T09:00:00.000Z')).toBe(true)
    expect(back.unseen).toBe(2)
  })

  it('an edit that names me counts from the edit, and brings a Done item back', async () => {
    const a = await comment(DOC, 'Who can check the numbers?')
    const b = await comment(OTHER, '@Bob second')
    expect((await forYou()).items.map((i: { item: string }) => i.item)).toEqual([b.item])
    await new Promise((r) => setTimeout(r, 5))
    await api('PATCH', `/api/comments/${a.item}/${a.id}`, {
      json: { text: '@Bob can you check the numbers?' },
    })
    const view = await forYou()
    expect(view.items.map((i: { item: string }) => i.item)).toEqual([a.item, b.item])
    expect(view.items[0].at > b.created).toBe(true)
    // Done, then an edit that keeps naming me doesn't bring it back.
    await mark(a.item, { action: 'done' })
    await api('PATCH', `/api/comments/${a.item}/${a.id}`, {
      json: { text: '@Bob can you check the numbers today?' },
    })
    expect((await forYou()).items.map((i: { item: string }) => i.item)).toEqual([b.item])
  })

  it('refuses a zone it does not know, and an id that cannot be an item', async () => {
    const a = await comment(DOC, '@Bob first')
    await api('POST', `/api/for-you/${a.item}`, {
      as: BOB,
      json: { action: 'later', when: 'monday', zone: 'Mars/Olympus' },
      status: 400,
    })
    await api('POST', '/api/for-you/..%2Fx', { as: BOB, json: { action: 'done' }, status: 400 })
  })
})

describe('my marks are mine, kept in Git (R17, R18)', () => {
  it('follow me across a reindex, sit in my personal space, and nobody else sees them', async () => {
    const a = await comment(DOC, '@Bob and @Carol please look')
    await mark(a.item, { action: 'done' })
    expect((await forYou(CAROL)).items).toHaveLength(1)
    expect(await bobFiles()).toContain('.hearth/for-you.json')
    expect(await runGit(join(root, 'data', 'repos', 'team'), ['ls-files'])).not.toContain('for-you')
    expect((await bobLog())[0]).toBe('Bob <bob@example.test>|for you: done "Pilot plan"')

    // A restart with the index deleted: the marks come back from Git.
    await stop()
    for (const end of ['', '-wal', '-shm']) {
      await rm(indexPath(join(root, 'data')) + end, { force: true })
    }
    await start()
    await services.indexer.full('team')
    await services.indexer.full('bob')
    expect((await forYou()).items).toEqual([])
    expect((await forYou(CAROL)).items).toHaveLength(1)
  })

  it('reads 5,000 indexed files under 200 ms, with no Git reads', async () => {
    const a = await comment(DOC, '@Bob first')
    await mark(a.item, { action: 'seen' })
    const files = Array.from({ length: 5_000 }, (_, i) => ({
      path: `docs/bulk/${i}.md`,
      content: `---\nid: bulk-${i}\n---\n# Doc ${i}\n\nFiller text about the pilot.\n`,
      blobOid: '0'.repeat(40),
    }))
    services.index.upsertFiles('team', files)
    await forYou()
    const git = services.git as unknown as { readFile: (...args: unknown[]) => Promise<unknown> }
    const readFile = git.readFile
    let reads = 0
    git.readFile = (...args: unknown[]) => {
      reads++
      return readFile.apply(services.git, args)
    }
    try {
      const started = performance.now()
      const view = await forYou()
      const took = performance.now() - started
      expect(view.items).toHaveLength(1)
      expect(reads).toBe(0)
      expect(took).toBeLessThan(200)
    } finally {
      git.readFile = readFile
    }
  })
})

async function bobFiles(): Promise<string> {
  return runGit(join(root, 'data', 'repos', 'bob'), ['ls-files'])
}

async function bobLog(): Promise<string[]> {
  const out = await runGit(join(root, 'data', 'repos', 'bob'), ['log', '--format=%an <%ae>|%s'])
  return out.split('\n').filter(Boolean)
}
