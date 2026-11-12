import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Principal } from '../auth/index.js'
import { FakePushSender } from '../meetings/reminders/sender.js'
import { ReminderStore } from '../meetings/reminders/store.js'
import { dueForReminder, TaskReminders, taskReminderKey } from './reminders.js'
import type { TaskView } from './service.js'

const ALICE: Principal = {
  userId: 'u-alice',
  email: 'alice@example.test',
  name: 'Alice',
  handle: 'alice',
  isAdmin: false,
}
const NOW = new Date('2026-11-11T15:00:00Z')

function task(id: string, dueAt: string | null, overrides: Partial<TaskView> = {}): TaskView {
  return {
    space: 'alice',
    path: `tasks/${id}.md`,
    id,
    blobOid: '',
    title: `Task ${id}`,
    notes: '',
    status: 'open',
    priority: 4,
    due: dueAt ? '2026-11-11T15:00' : null,
    tz: dueAt ? 'UTC' : null,
    dueAt,
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

describe('dueForReminder', () => {
  it('takes open timed tasks of mine due in (now − 10 min, now + 30 s]', () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString()
    const tasks = [
      task('now', at(0)),
      task('soon', at(30_000)),
      task('too-soon', at(30_001)),
      task('late', at(-9 * 60_000)),
      task('too-late', at(-10 * 60_000)),
      task('untimed', null),
      task('done', at(0), { status: 'done' }),
      task('theirs', at(0), { mine: false }),
    ]
    expect(dueForReminder(tasks, NOW).map((t) => t.id)).toEqual(['now', 'soon', 'late'])
  })
})

describe('TaskReminders', () => {
  let dir: string
  let store: ReminderStore
  let sender: FakePushSender
  let open: TaskView[]
  const sub = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    keys: { p256dh: 'p', auth: 'a' },
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hearth-task-reminders-'))
    store = new ReminderStore(dir)
    sender = new FakePushSender()
    open = [task('A', NOW.toISOString(), { project: 'Ops' }), task('B', NOW.toISOString())]
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  const reminders = () =>
    new TaskReminders({
      store,
      sender,
      tasks: { list: async () => open, accessibleSpaces: () => [] },
      now: () => NOW,
      log: () => {},
    })

  it('pushes each due task once, to every browser of the member', async () => {
    await store.subscribe(ALICE, sub)
    await store.subscribe(ALICE, { ...sub, endpoint: 'https://fcm.googleapis.com/fcm/send/def' })
    const r = reminders()
    await r.tick()
    await r.tick()
    expect(sender.sent.map((s) => s.payload)).toEqual([
      { title: 'Due now: Task A', body: 'Ops', url: '/tasks/today', tag: 'task-A' },
      { title: 'Due now: Task A', body: 'Ops', url: '/tasks/today', tag: 'task-A' },
      { title: 'Due now: Task B', body: 'Tasks', url: '/tasks/today', tag: 'task-B' },
      { title: 'Due now: Task B', body: 'Tasks', url: '/tasks/today', tag: 'task-B' },
    ])
    expect(await store.wasSent(taskReminderKey(ALICE.email, open[0] as TaskView))).toBe(true)
    expect(taskReminderKey(ALICE.email, open[0] as TaskView)).toBe(
      `task ${ALICE.email} A ${NOW.toISOString()}`,
    )
  })

  it('reminds again when the task moves to a new time', async () => {
    await store.subscribe(ALICE, sub)
    const r = reminders()
    open = [task('A', NOW.toISOString())]
    await r.tick()
    open = [task('A', new Date(NOW.getTime() + 20_000).toISOString())]
    await r.tick()
    expect(sender.sent).toHaveLength(2)
  })

  it('asks the list only for timed tasks in the window, so its limit can’t drop a due one', async () => {
    await store.subscribe(ALICE, sub)
    const filters: unknown[] = []
    await new TaskReminders({
      store,
      sender,
      tasks: {
        list: async (_p, filter) => {
          filters.push(filter)
          return open
        },
        accessibleSpaces: () => [],
      },
      now: () => NOW,
      log: () => {},
    }).tick()
    expect(filters).toEqual([
      {
        status: 'open',
        mine: true,
        dueAtAfter: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
        dueAtUntil: new Date(NOW.getTime() + 30_000).toISOString(),
      },
    ])
  })

  it('sends nothing without subscribers', async () => {
    await reminders().tick()
    expect(sender.sent).toEqual([])
  })
})
