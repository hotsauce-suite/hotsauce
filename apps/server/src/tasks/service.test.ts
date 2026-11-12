import { createHash } from 'node:crypto'
import { newTaskFile, parseFrontmatter, patchFrontmatter } from '@hearth/format'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import type { Change, CommitResult } from '../git/index.js'
import { Index } from '../index/index.js'
import type { Space } from '../spaces/index.js'
import { compareTasks, isMine, resolveAssignee, Tasks, type TaskView } from './service.js'

const ALICE: Principal = {
  userId: 'u-alice',
  email: 'alice@example.test',
  name: 'Alice',
  handle: 'alice',
  isAdmin: false,
}
const BOB = 'bob@example.test'
const SPACES: Space[] = [
  { name: 'team', kind: 'team', label: 'Team' },
  { name: 'alice', kind: 'personal', label: 'Personal' },
]

const oid = (s: string) => createHash('sha1').update(s).digest('hex')

/** GitStore's read and commit, in memory; `beforeCommit` can sneak in a concurrent change. */
class FakeGit {
  readonly files = new Map<string, string>()
  readonly commits: Array<{ space: string; message: string; paths: string[] }> = []
  beforeCommit: ((space: string) => void) | null = null
  changed: Array<{ space: string; path: string }> = []

  put(space: string, path: string, content: string | null): void {
    if (content === null) this.files.delete(`${space}:${path}`)
    else this.files.set(`${space}:${path}`, content)
    this.changed.push({ space, path })
  }

  async readFile(space: string, path: string) {
    const content = this.files.get(`${space}:${path}`)
    if (content === undefined) throw new HearthError('not_found', `${path} not found`)
    return { content, blobOid: oid(content) }
  }

  async readBlobText(_space: string, blob: string): Promise<string> {
    for (const content of this.files.values()) if (oid(content) === blob) return content
    throw new HearthError('bad_request', 'Unknown blob')
  }

  async commit(
    space: string,
    args: {
      changes: Change[]
      message: string
      unchanged?: { path: string; blobOid: string | null }
    },
  ): Promise<CommitResult> {
    const hook = this.beforeCommit
    this.beforeCommit = null
    hook?.(space)
    if (args.unchanged) {
      const now = this.files.get(`${space}:${args.unchanged.path}`)
      // Like GitStore: a file deleted or moved since it was read is a conflict too.
      const ok =
        args.unchanged.blobOid === null
          ? now === undefined
          : now !== undefined && oid(now) === args.unchanged.blobOid
      if (!ok) throw new HearthError('conflict', 'changed')
    }
    for (const c of args.changes) this.put(space, c.path, c.content as string | null)
    this.commits.push({ space, message: args.message, paths: args.changes.map((c) => c.path) })
    const first = args.changes[0]
    return {
      status: 'committed',
      oid: String(this.commits.length),
      blobOid: oid(typeof first?.content === 'string' ? first.content : ''),
    }
  }
}

let git: FakeGit
let index: Index
let tasks: Tasks
let now: Date

beforeEach(() => {
  git = new FakeGit()
  index = new Index(':memory:')
  index.upsertSpace({ name: 'team', kind: 'team', ownerEmail: null })
  index.upsertSpace({ name: 'alice', kind: 'personal', ownerEmail: ALICE.email })
  index.upsertSpace({ name: 'bob', kind: 'personal', ownerEmail: BOB })
  now = new Date('2026-11-11T12:00:00Z')
  tasks = new Tasks({
    git,
    index,
    spaces: {
      visibleSpaces: async () => SPACES,
      canAccess: (_p, space) => space === 'team' || space === 'alice',
    },
    // What the Syncer does: index what changed.
    syncer: {
      afterHeadChanged: async () => {
        for (const { space, path } of git.changed.splice(0)) {
          const content = git.files.get(`${space}:${path}`)
          if (content === undefined) index.removeFiles(space, [path])
          else if (!path.startsWith('.')) {
            index.upsertFiles(space, [{ path, content, blobOid: oid(content) }])
          }
        }
      },
    },
    now: () => now,
    log: () => {},
  })
})

afterEach(() => index.close())

function view(overrides: Partial<TaskView>): TaskView {
  return {
    space: 'team',
    path: 'tasks/x.md',
    id: 'X',
    blobOid: '',
    title: 't',
    notes: '',
    status: 'open',
    priority: 4,
    due: null,
    tz: null,
    dueAt: null,
    recur: null,
    project: null,
    labels: [],
    assignee: null,
    createdBy: ALICE.email,
    created: '2026-11-01T00:00:00Z',
    completed: null,
    completedBy: null,
    order: null,
    source: null,
    mine: true,
    ...overrides,
  }
}

describe('compareTasks', () => {
  it('orders open tasks by date, time, priority, order and created; done by completion', () => {
    const list = [
      view({ id: 'none', due: null }),
      view({ id: 'later', due: '2026-11-14' }),
      view({ id: 'timed', due: '2026-11-12T09:00' }),
      view({ id: 'p1', due: '2026-11-12', priority: 1 }),
      view({ id: 'p4', due: '2026-11-12', priority: 4 }),
      view({ id: 'ordered', due: '2026-11-12', priority: 4, order: 1 }),
      view({ id: 'done-old', status: 'done', completed: '2026-11-01T00:00:00Z' }),
      view({ id: 'done-new', status: 'done', completed: '2026-11-10T00:00:00Z' }),
      view({ id: 'older', due: null, created: '2026-10-01T00:00:00Z' }),
    ]
    expect(list.sort(compareTasks).map((t) => t.id)).toEqual([
      'p1',
      'ordered',
      'p4',
      'timed',
      'later',
      'older',
      'none',
      'done-new',
      'done-old',
    ])
  })
})

describe('isMine', () => {
  const personal = new Set(['alice'])
  it('is my personal space, or team tasks assigned to me, or mine and unassigned', () => {
    const t = (space: string, assignee: string | null, createdBy: string) =>
      isMine({ space, assignee, createdBy }, ALICE, personal)
    expect(t('alice', null, ALICE.email)).toBe(true)
    expect(t('team', ALICE.email, BOB)).toBe(true)
    expect(t('team', null, ALICE.email)).toBe(true)
    expect(t('team', BOB, ALICE.email)).toBe(false)
    expect(t('team', null, BOB)).toBe(false)
  })
})

describe('resolveAssignee', () => {
  const people = [
    { email: 'alex.smith@example.test', name: 'Alex Smith', handle: 'alex-smith' },
    { email: BOB, name: 'Bob', handle: 'bob' },
  ]
  it('matches the handle, the email local part, then the email', () => {
    expect(resolveAssignee('bob', people)).toBe(BOB)
    expect(resolveAssignee('Alex-Smith', people)).toBe('alex.smith@example.test')
    expect(resolveAssignee('alex.smith', people)).toBe('alex.smith@example.test')
    expect(resolveAssignee('BOB@example.test', people)).toBe(BOB)
    expect(() => resolveAssignee('carol', people)).toThrow(/No member called "carol"/)
    expect(() => resolveAssignee('bob@elsewhere.com', people)).toThrow(HearthError)
  })

  it('keeps an invited namesake apart from the member', () => {
    const withGuests = [
      ...people,
      { email: 'bob@partner.org', name: 'Bob', handle: 'bob-partner-org' },
      { email: 'jo@partner.org', name: 'Jo', handle: 'jo-partner-org' },
      { email: 'jo@other.org', name: 'Jo', handle: 'jo-other-org' },
    ]
    expect(resolveAssignee('bob', withGuests)).toBe(BOB)
    expect(resolveAssignee('bob-partner-org', withGuests)).toBe('bob@partner.org')
    // Two people share the local part "jo" and neither has it as a handle: no guessing.
    expect(() => resolveAssignee('jo', withGuests)).toThrow(/No member called "jo"/)
  })
})

describe('Tasks', () => {
  it('lists from the index with filters, and reads notes from it', async () => {
    const a = await tasks.quickAdd(ALICE, { text: 'Call Sam tomorrow p1 #Ops', tz: 'UTC' })
    now = new Date('2026-11-11T12:01:00Z')
    await tasks.quickAdd(ALICE, { text: 'Team thing #Ops', tz: 'UTC', space: 'team' })
    now = new Date('2026-11-11T12:02:00Z')
    await tasks.quickAdd(ALICE, { text: 'Bob does it +bob', tz: 'UTC' })
    await tasks.update(ALICE, 'alice', a.id, { notes: 'Ask about the contract' })

    const all = await tasks.list(ALICE, {})
    expect(all.map((t) => t.title)).toEqual(['Call Sam', 'Team thing', 'Bob does it'])
    expect(all[0]?.notes).toBe('Ask about the contract')
    expect((await tasks.list(ALICE, { mine: true })).map((t) => t.title)).toEqual([
      'Call Sam',
      'Team thing',
    ])
    expect(
      (await tasks.list(ALICE, { project: 'Ops', space: 'team' })).map((t) => t.title),
    ).toEqual(['Team thing'])
    expect((await tasks.list(ALICE, { dueBefore: '2026-11-12' })).map((t) => t.title)).toEqual([
      'Call Sam',
    ])
    expect((await tasks.list(ALICE, { project: '' })).map((t) => t.title)).toEqual(['Bob does it'])
    expect(await tasks.list(ALICE, { limit: 1 })).toHaveLength(1)
    await expect(tasks.list(ALICE, { space: 'bob' })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('filters by a lower due date and by a dueAt window before the limit', async () => {
    await tasks.quickAdd(ALICE, { text: 'Overdue a yesterday', tz: 'UTC' })
    await tasks.quickAdd(ALICE, { text: 'Overdue b yesterday', tz: 'UTC' })
    await tasks.quickAdd(ALICE, { text: 'Due today', tz: 'UTC', space: 'team' })
    await tasks.quickAdd(ALICE, { text: 'Lunch today 12:00', tz: 'UTC' })
    await tasks.quickAdd(ALICE, { text: 'No date', tz: 'UTC' })
    expect(
      (await tasks.list(ALICE, { dueAfter: '2026-11-11', limit: 1 })).map((t) => t.title),
    ).toEqual(['Due'])
    expect(
      (
        await tasks.list(ALICE, {
          dueAtAfter: '2026-11-11T11:50:00Z',
          dueAtUntil: '2026-11-11T12:00:30Z',
          limit: 1,
        })
      ).map((t) => t.title),
    ).toEqual(['Lunch'])
  })

  it('creates in the personal space unless assigned to someone else', async () => {
    const mine = await tasks.create(ALICE, { title: 'Mine' })
    expect(mine.space).toBe('alice')
    const theirs = await tasks.create(ALICE, { title: 'Theirs', assignee: 'bob' })
    expect(theirs).toMatchObject({ space: 'team', assignee: BOB, mine: false })
    await expect(
      tasks.create(ALICE, { title: 'x', assignee: 'bob', space: 'alice' }),
    ).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('moves a recurring task forward on completion, in the member’s zone, keeping the time', async () => {
    // 2026-11-11 is a Wednesday; in Kolkata it is already the evening.
    const t = await tasks.create(ALICE, {
      title: 'Report',
      due: '2026-11-06T09:30',
      tz: 'Asia/Kolkata',
      recur: 'every friday',
    })
    const done = await tasks.complete(ALICE, 'alice', t.id, { tz: 'Asia/Kolkata' })
    expect(done).toMatchObject({ status: 'open', due: '2026-11-13T09:30', completed: null })
    expect(git.commits.at(-1)?.message).toBe('tasks: complete "Report"')

    const once = await tasks.create(ALICE, { title: 'Once' })
    const closed = await tasks.complete(ALICE, 'alice', once.id, { tz: 'UTC' })
    expect(closed).toMatchObject({
      status: 'done',
      completed: '2026-11-11T12:00:00Z',
      completedBy: ALICE.email,
    })
    // Completing it again changes nothing.
    const commits = git.commits.length
    await tasks.complete(ALICE, 'alice', once.id, { tz: 'UTC' })
    expect(git.commits).toHaveLength(commits)
  })

  it('re-reads and re-applies a field patch when another write lands first', async () => {
    const t = await tasks.create(ALICE, { title: 'Shared', priority: 3 })
    // Between our read and our commit, someone else sets the project.
    git.beforeCommit = (space) => {
      const path = `tasks/${t.id}.md`
      const current = git.files.get(`${space}:${path}`) ?? ''
      git.put(space, path, patchFrontmatter(current, { project: 'Ops' }))
    }
    const updated = await tasks.update(ALICE, 'alice', t.id, { priority: 1 })
    expect(updated).toMatchObject({ priority: 1, project: 'Ops' })
    const { data } = parseFrontmatter(git.files.get(`alice:tasks/${t.id}.md`) ?? '')
    expect(data).toMatchObject({ priority: 1, project: 'Ops' })
  })

  it('a stale patch, complete or delete of a task deleted meanwhile is not_found and stays deleted', async () => {
    const t = await tasks.create(ALICE, { title: 'Doomed' })
    const path = `tasks/${t.id}.md`
    const original = git.files.get(`alice:${path}`) ?? ''
    for (const write of [
      () => tasks.update(ALICE, 'alice', t.id, { priority: 1 }),
      () => tasks.complete(ALICE, 'alice', t.id, { tz: 'UTC' }),
      () => tasks.remove(ALICE, 'alice', t.id),
    ]) {
      git.put('alice', path, original)
      // Read, then someone deletes it before our commit.
      git.beforeCommit = (space) => git.put(space, path, null)
      await expect(write()).rejects.toMatchObject({ code: 'not_found' })
      expect(git.files.has(`alice:${path}`)).toBe(false)
    }
  })

  it('a PATCH tz is the member’s today, and the task’s zone only with a timed due', async () => {
    const timed = await tasks.create(ALICE, {
      title: 'Call NY',
      due: '2026-11-12T09:00',
      tz: 'America/New_York',
    })
    const kept = await tasks.update(ALICE, 'alice', timed.id, { priority: 2 }, undefined, {
      tz: 'Asia/Kolkata',
    })
    expect(kept.tz).toBe('America/New_York')
    // A recurring rule on an undated task starts on the member's today (UTC+14 is tomorrow).
    const undated = await tasks.create(ALICE, { title: 'Stretch' })
    const recurring = await tasks.update(
      ALICE,
      'alice',
      undated.id,
      { recur: 'every day' },
      undefined,
      { tz: 'Pacific/Kiritimati' },
    )
    expect(recurring).toMatchObject({ due: '2026-11-12', tz: null })
    // A hand-written timed due with no zone takes the member's.
    const file = newTaskFile({ title: 'No zone', createdBy: ALICE.email, due: '2026-11-12T09:00' })
    git.put('alice', file.path, file.text)
    const fixed = await tasks.update(ALICE, 'alice', file.id, { priority: 3 }, undefined, {
      tz: 'Asia/Kolkata',
    })
    expect(fixed).toMatchObject({ tz: 'Asia/Kolkata', priority: 3 })
  })

  it('gives up after three concurrent changes in a row', async () => {
    const t = await tasks.create(ALICE, { title: 'Busy' })
    let n = 0
    const sneak = (space: string) => {
      n++
      const path = `tasks/${t.id}.md`
      git.put(space, path, `${git.files.get(`${space}:${path}`)}x`)
      git.beforeCommit = sneak
    }
    git.beforeCommit = sneak
    await expect(tasks.update(ALICE, 'alice', t.id, { priority: 2 })).rejects.toMatchObject({
      code: 'conflict',
    })
    expect(n).toBe(3)
    git.beforeCommit = null
  })

  it('keeps hand edits: only the patched keys change', async () => {
    const file = newTaskFile({
      title: 'Hand made',
      createdBy: ALICE.email,
      id: '01JD3Z6Q8W8Y5G2N4K7M9P0R1S',
    })
    const text = file.text.replace('type: task\n', 'type: task\n# a comment kept\n')
    git.put('alice', file.path, text)
    const updated = await tasks.update(ALICE, 'alice', file.id, { priority: 2 })
    expect(updated.priority).toBe(2)
    expect(git.files.get(`alice:${file.path}`)).toContain('# a comment kept\n')
  })

  it('reopens, deletes to the trash, and moves between spaces', async () => {
    const t = await tasks.create(ALICE, { title: 'Wander', notes: 'Some notes' })
    await tasks.complete(ALICE, 'alice', t.id, { tz: 'UTC' })
    const reopened = await tasks.reopen(ALICE, 'alice', t.id)
    expect(reopened).toMatchObject({ status: 'open', completed: null, completedBy: null })
    expect(git.files.get(`alice:${t.path}`)).not.toContain('completed')

    const moved = await tasks.move(ALICE, 'alice', t.id, 'team')
    expect(moved).toMatchObject({ space: 'team', notes: 'Some notes' })
    expect(git.files.has(`alice:${t.path}`)).toBe(false)
    expect(git.files.has(`alice:.trash/2026-11-11/${t.path}`)).toBe(true)
    expect(git.commits.slice(-2).map((c) => [c.space, c.message])).toEqual([
      ['team', 'tasks: move "Wander"'],
      ['alice', 'tasks: move "Wander"'],
    ])

    await tasks.remove(ALICE, 'team', t.id)
    expect(git.commits.at(-1)?.message).toBe('tasks: delete "Wander"')
    expect(git.files.has(`team:.trash/2026-11-11/${t.path}`)).toBe(true)
    await expect(tasks.get(ALICE, 'team', t.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('counts as already imported only my personal tasks and team tasks I created', async () => {
    const src = (ref: string) => ({ kind: 'import' as const, from: 'todoist', ref })
    await tasks.create(ALICE, { title: 'Mine', source: src('mine') })
    await tasks.create(ALICE, { title: 'Moved to team', source: src('moved'), space: 'team' })
    // Bob imported the same CSV row into the team.
    const bobs = newTaskFile({ title: 'Bob’s', createdBy: BOB, source: src('shared') })
    git.put('team', bobs.path, bobs.text)
    index.upsertFiles('team', [{ path: bobs.path, content: bobs.text, blobOid: oid(bobs.text) }])
    expect([...(await tasks.importedRefs(ALICE, 'todoist'))].sort()).toEqual(['mine', 'moved'])
  })

  it('lists people: personal space owners and the caller', () => {
    expect(tasks.people(ALICE)).toEqual([
      { email: ALICE.email, name: 'Alice', handle: 'alice' },
      { email: BOB, name: 'Bob', handle: 'bob' },
    ])
  })
})
