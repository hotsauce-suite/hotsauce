import { parseQuickAdd } from '@hearth/format'
import { describe, expect, it } from 'vitest'
import type { TaskView } from '../../api/tasks'
import {
  belongs,
  chipsFor,
  completedCopy,
  dropIndex,
  dueWords,
  effectiveOrder,
  groupTasks,
  homeViewOf,
  isOverdue,
  lineFor,
  orderForMove,
  resolvePerson,
  sortTasks,
  viewQuery,
  withPatch,
} from './logic'
import { assignsSomeoneElse } from './QuickAdd'

const TODAY = '2026-11-11' // a Wednesday
const NOW = new Date('2026-11-11T17:00:00Z')

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    space: 'ada',
    path: 'tasks/X.md',
    id: over.id ?? 'X',
    blobOid: 'b',
    title: 'A task',
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
    createdBy: 'ada@example.test',
    created: '2026-11-01T12:00:00Z',
    completed: null,
    completedBy: null,
    order: null,
    source: null,
    mine: true,
    ...over,
  }
}

describe('drag order math', () => {
  const list = [
    task({ id: 'a', order: 100 }),
    task({ id: 'b', order: 200 }),
    task({ id: 'c', order: 300 }),
  ]

  it('lands on the midpoint of the new neighbors', () => {
    expect(orderForMove(list, 0, 1)).toBe(250) // a between b and c
    expect(orderForMove(list, 2, 1)).toBe(150) // c between a and b
  })

  it('steps past the end it lands on', () => {
    expect(orderForMove(list, 0, 2)).toBe(300 + 1024)
    expect(orderForMove(list, 2, 0)).toBe(100 - 1024)
  })

  it('is null when nothing moved', () => {
    expect(orderForMove(list, 1, 1)).toBeNull()
    expect(orderForMove([task()], 0, 1)).toBeNull()
  })

  it('places tasks never ordered by when they were made, so a drag can land between them', () => {
    const fresh = [
      task({ id: 'a', created: '2026-11-01T00:00:00Z' }),
      task({ id: 'b', created: '2026-11-02T00:00:00Z' }),
      task({ id: 'c', created: '2026-11-03T00:00:00Z' }),
    ]
    const b = Date.parse('2026-11-02T00:00:00Z') / 1000
    const c = Date.parse('2026-11-03T00:00:00Z') / 1000
    expect(effectiveOrder(fresh[1] as TaskView)).toBe(b)
    expect(orderForMove(fresh, 0, 1)).toBe((b + c) / 2)
    // And the result sorts where it was dropped.
    const moved = fresh.map((t) => (t.id === 'a' ? { ...t, order: (b + c) / 2 } : t))
    expect(sortTasks({ id: 'inbox' }, moved).map((t) => t.id)).toEqual(['b', 'a', 'c'])
  })

  it('finds the drop index from the rows’ middles', () => {
    const mids = [25, 75, 125, 175]
    expect(dropIndex(mids, 0, 25)).toBe(0)
    expect(dropIndex(mids, 0, 135)).toBe(2)
    expect(dropIndex(mids, 3, 10)).toBe(0)
    expect(dropIndex(mids, 1, 400)).toBe(3)
  })
})

describe('views', () => {
  it('asks the server for each view’s tasks', () => {
    // Inbox and Upcoming filter on the server, so the 500 cap can't crowd them out.
    expect(viewQuery({ id: 'inbox' }, NOW, TODAY)).toEqual({
      mine: true,
      status: 'open',
      project: '',
    })
    expect(viewQuery({ id: 'upcoming' }, NOW, TODAY)).toEqual({
      mine: true,
      status: 'open',
      dueAfter: TODAY,
    })
    expect(viewQuery({ id: 'today' }, NOW, TODAY)).toEqual({
      mine: true,
      status: 'open',
      dueBefore: TODAY,
    })
    // All tasks: every open task the member can see, theirs or not.
    expect(viewQuery({ id: 'all' }, NOW, TODAY)).toEqual({ mine: false, status: 'open' })
    expect(viewQuery({ id: 'done' }, NOW, TODAY).doneSince).toBe('2026-10-12T17:00:00.000Z')
    expect(viewQuery({ id: 'project', space: 'team', project: 'Ops' }, NOW, TODAY)).toEqual({
      status: 'open',
      space: 'team',
      project: 'Ops',
    })
  })

  it('keeps only what belongs', () => {
    const inbox = { id: 'inbox' } as const
    expect(belongs(inbox, task(), TODAY, NOW)).toBe(true)
    expect(belongs(inbox, task({ project: 'Ops' }), TODAY, NOW)).toBe(false)
    expect(belongs(inbox, task({ mine: false }), TODAY, NOW)).toBe(false)
    expect(belongs(inbox, task({ status: 'done' }), TODAY, NOW)).toBe(false)

    const today = { id: 'today' } as const
    expect(belongs(today, task({ due: '2026-11-09' }), TODAY, NOW)).toBe(true)
    expect(belongs(today, task({ due: '2026-11-11T15:00' }), TODAY, NOW)).toBe(true)
    expect(belongs(today, task({ due: '2026-11-12' }), TODAY, NOW)).toBe(false)
    expect(belongs(today, task(), TODAY, NOW)).toBe(false)

    const upcoming = { id: 'upcoming' } as const
    expect(belongs(upcoming, task({ due: '2026-11-11' }), TODAY, NOW)).toBe(true)
    expect(belongs(upcoming, task({ due: '2026-11-10' }), TODAY, NOW)).toBe(false)

    const project = { id: 'project', space: 'team', project: 'Ops' } as const
    expect(belongs(project, task({ space: 'team', project: 'Ops', mine: false }), TODAY, NOW)).toBe(
      true,
    )
    expect(belongs(project, task({ space: 'ada', project: 'Ops' }), TODAY, NOW)).toBe(false)

    const done = { id: 'done' } as const
    expect(
      belongs(done, task({ status: 'done', completed: '2026-11-10T00:00:00Z' }), TODAY, NOW),
    ).toBe(true)
    expect(
      belongs(done, task({ status: 'done', completed: '2026-09-01T00:00:00Z' }), TODAY, NOW),
    ).toBe(false)
  })

  it('splits Today into Overdue and Today', () => {
    const list = sortTasks({ id: 'today' }, [
      task({ id: 't', due: '2026-11-11' }),
      task({ id: 'o', due: '2026-11-08' }),
      task({ id: 'p1', due: '2026-11-11', priority: 1 }),
    ])
    const groups = groupTasks({ id: 'today' }, list, TODAY)
    expect(groups.map((g) => [g.key, g.tasks.map((t) => t.id)])).toEqual([
      ['overdue', ['o']],
      ['today', ['p1', 't']],
    ])
  })

  it('groups Upcoming by day for 14 days, then Later', () => {
    const list = sortTasks({ id: 'upcoming' }, [
      task({ id: 'later', due: '2026-11-25' }),
      task({ id: 'sat', due: '2026-11-14' }),
      task({ id: 'today3pm', due: '2026-11-11T15:00' }),
      task({ id: 'today', due: '2026-11-11' }),
      task({ id: 'tomorrow', due: '2026-11-12' }),
      task({ id: 'last', due: '2026-11-24' }),
    ])
    const groups = groupTasks({ id: 'upcoming' }, list, TODAY)
    expect(groups.map((g) => [g.title, g.tasks.map((t) => t.id)])).toEqual([
      ['Today', ['today', 'today3pm']],
      ['Tomorrow', ['tomorrow']],
      ['Sat Nov 14', ['sat']],
      ['Tue Nov 24', ['last']],
      ['Later', ['later']],
    ])
  })

  it('sends a linked task to the list it lives in', () => {
    expect(homeViewOf(task({ status: 'done' }), TODAY)).toEqual({ id: 'done' })
    expect(homeViewOf(task({ project: 'Ops', space: 'team' }), TODAY)).toEqual({
      id: 'project',
      space: 'team',
      project: 'Ops',
    })
    expect(homeViewOf(task({ due: '2026-11-11' }), TODAY)).toEqual({ id: 'today' })
    expect(homeViewOf(task({ due: '2026-11-20' }), TODAY)).toEqual({ id: 'upcoming' })
    expect(homeViewOf(task(), TODAY)).toEqual({ id: 'inbox' })
  })
})

describe('words', () => {
  it('says when a task is due', () => {
    expect(dueWords('2026-11-11', TODAY)).toBe('Today')
    expect(dueWords('2026-11-12T09:30', TODAY)).toBe('Tomorrow 9:30 AM')
    expect(dueWords('2026-11-10', TODAY)).toBe('Yesterday')
    expect(dueWords('2026-11-13T15:00', TODAY, { short: true })).toBe('Fri 3:00 PM')
    expect(dueWords('2026-11-17', TODAY)).toBe('Tuesday')
    expect(dueWords('2026-11-20', TODAY)).toBe('Nov 20')
    expect(dueWords('2027-01-04T00:00', TODAY)).toBe('Jan 4, 2027 12:00 AM')
  })

  it('knows overdue by date, or by time today', () => {
    expect(isOverdue(task({ due: '2026-11-10' }), TODAY, NOW)).toBe(true)
    expect(isOverdue(task({ due: '2026-11-11' }), TODAY, NOW)).toBe(false)
    expect(
      isOverdue(task({ due: '2026-11-11T09:00', dueAt: '2026-11-11T14:00:00Z' }), TODAY, NOW),
    ).toBe(true)
    expect(isOverdue(task({ due: '2026-11-10', status: 'done' }), TODAY, NOW)).toBe(false)
  })

  it('turns a quick-add line into chips', () => {
    const parsed = parseQuickAdd('Call Sam fri 3pm p1 #Ops @calls +alex every week', {
      today: TODAY,
    })
    expect(chipsFor(parsed, TODAY).map((c) => c.label)).toEqual(
      expect.arrayContaining(['P1', '#Ops', '@calls', '+alex', 'every week']),
    )
  })

  it('resolves +name by handle, email or local part', () => {
    const people = [{ email: 'priya@example.test', handle: 'priya', name: 'Priya' }]
    expect(resolvePerson(people, 'Priya')?.email).toBe('priya@example.test')
    expect(resolvePerson(people, 'priya@example.test')?.handle).toBe('priya')
    expect(resolvePerson(people, 'nobody')).toBeNull()
  })

  it('writes a proposed task back as a line that parses the same', () => {
    const reparse = (text: string) => parseQuickAdd(text, { today: TODAY })
    const spoken = reparse('Call Sam tomorrow 3pm p1 #Ops')
    expect(lineFor(spoken, reparse)).toBe('Call Sam tomorrow 3pm p1 #Ops')
    // Without tokens (a server that leaves them out), the fields are spelled out.
    const bare = { ...spoken, tokens: [] }
    const line = lineFor(bare, reparse)
    expect(line).toBe('Call Sam 2026-11-12 15:00 p1 #Ops')
    const again = reparse(line)
    expect([again.title, again.due, again.priority, again.project]).toEqual([
      'Call Sam',
      '2026-11-12T15:00',
      1,
      'Ops',
    ])
  })
})

describe('optimistic copies', () => {
  it('applies a patch, recomputing the due instant', () => {
    const next = withPatch(task(), { due: '2026-11-12T09:00', priority: 2 }, 'America/New_York')
    expect(next.priority).toBe(2)
    expect(next.tz).toBe('America/New_York')
    expect(next.dueAt).toBe('2026-11-12T14:00:00.000Z')
    expect(withPatch(next, { due: null }, 'UTC')).toMatchObject({
      due: null,
      dueAt: null,
      tz: null,
    })
  })

  it('completes, or moves a recurring task to its next date', () => {
    expect(completedCopy(task(), TODAY, NOW)).toMatchObject({ status: 'done' })
    expect(
      completedCopy(task({ recur: 'every week', due: '2026-11-11' }), TODAY, NOW),
    ).toMatchObject({ status: 'open', due: '2026-11-18' })
  })
})

describe('assignsSomeoneElse', () => {
  const me = 'ada@example.test'
  const people = [
    { email: me, name: 'Ada', handle: 'ada' },
    { email: 'priya@example.test', name: 'Priya', handle: 'priya' },
  ]
  const line = (text: string) => parseQuickAdd(text, { today: TODAY })
  it('is false for my own handle, even before people load', () => {
    expect(assignsSomeoneElse(line('Do it +ada'), [], me)).toBe(false)
    expect(assignsSomeoneElse(line('Do it +ada'), people, me)).toBe(false)
  })
  it('is true for someone else once people load, and leaves an unknown one to the server before', () => {
    expect(assignsSomeoneElse(line('Do it +priya'), people, me)).toBe(true)
    expect(assignsSomeoneElse(line('Do it +priya'), [], me)).toBe(false)
    expect(assignsSomeoneElse(line('Do it +nobody'), people, me)).toBe(true)
    expect(assignsSomeoneElse(line('Do it'), people, me)).toBe(false)
  })
})

describe('All tasks', () => {
  it('shows every open task and splits off the rest of the team’s', () => {
    const mine = task({ id: 'A', mine: true })
    const theirs = task({ id: 'B', mine: false, space: 'team', assignee: 'priya@example.test' })
    const done = task({ id: 'C', status: 'done' })
    expect(belongs({ id: 'all' }, theirs, TODAY, NOW)).toBe(true)
    expect(belongs({ id: 'all' }, done, TODAY, NOW)).toBe(false)
    expect(groupTasks({ id: 'all' }, [mine, theirs], TODAY).map((g) => g.title)).toEqual([
      'Yours',
      'Rest of the team',
    ])
    // A teammate's task opened by link sits in All tasks, the one list that shows it.
    expect(homeViewOf(theirs, TODAY)).toEqual({ id: 'all' })
    expect(groupTasks({ id: 'all' }, [mine], TODAY)).toEqual([
      { key: 'all', title: '', tasks: [mine] },
    ])
  })
})
