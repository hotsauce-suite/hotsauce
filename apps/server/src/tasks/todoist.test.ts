import { describe, expect, it } from 'vitest'
import type { Principal } from '../auth/index.js'
import {
  type ImportedTask,
  mapTodoistApi,
  mapTodoistDue,
  parseCsv,
  parseTodoistCsv,
  TodoistImport,
} from './todoist.js'

const ALICE: Principal = {
  userId: 'u-alice',
  email: 'alice@example.test',
  name: 'Alice',
  handle: 'alice',
  isAdmin: false,
}

describe('mapTodoistDue', () => {
  it('keeps dates, reads floating times in the task’s zone, converts UTC times', () => {
    expect(mapTodoistDue({ date: '2026-11-13' }, 'UTC')).toEqual({ due: '2026-11-13' })
    expect(mapTodoistDue({ date: '2026-11-13T15:00:00', timezone: null }, 'Asia/Kolkata')).toEqual({
      due: '2026-11-13T15:00',
      tz: 'Asia/Kolkata',
    })
    expect(
      mapTodoistDue(
        { date: '2026-11-13', datetime: '2026-11-13T20:00:00Z', timezone: 'America/New_York' },
        'UTC',
      ),
    ).toEqual({ due: '2026-11-13T15:00', tz: 'America/New_York' })
    expect(mapTodoistDue({ date: 'someday' }, 'UTC')).toBeNull()
  })
})

describe('mapTodoistApi', () => {
  it('maps priorities inverted, projects, sections, labels, sub-tasks and recurrence', () => {
    const tasks = mapTodoistApi(
      {
        projects: [
          { id: '1', name: 'Inbox', inbox_project: true },
          { id: '2', name: 'Board' },
        ],
        sections: [{ id: '9', name: 'Prep', project_id: '2' }],
        tasks: [
          {
            id: 'a',
            content: 'Send deck',
            description: 'v3',
            priority: 4,
            project_id: '2',
            section_id: '9',
            labels: ['work'],
          },
          { id: 'b', content: 'Fix slide 4', priority: 3, project_id: '2', parent_id: 'a' },
          {
            id: 'c',
            content: 'Water plants',
            priority: 1,
            project_id: '1',
            due: { date: '2026-11-13', is_recurring: true, string: 'every friday' },
          },
          {
            id: 'd',
            content: 'Gym',
            project_id: '1',
            due: { date: '2026-11-13', is_recurring: true, string: 'every 3rd tuesday' },
          },
          { nonsense: true },
        ],
      },
      { tz: 'UTC' },
    )
    const pick = (t: ImportedTask) => ({
      title: t.title,
      notes: t.notes,
      priority: t.priority,
      project: t.project,
      labels: t.labels,
      due: t.due,
      recur: t.recur,
      ref: t.source.ref,
    })
    expect(tasks.map(pick)).toEqual([
      {
        title: 'Send deck',
        notes: 'v3',
        priority: 1,
        project: 'Board',
        labels: ['Prep', 'work'],
        due: undefined,
        recur: undefined,
        ref: 'a',
      },
      {
        title: 'Fix slide 4',
        notes: 'Sub-task of: Send deck',
        priority: 2,
        project: 'Board',
        labels: [],
        due: undefined,
        recur: undefined,
        ref: 'b',
      },
      {
        title: 'Water plants',
        notes: undefined,
        priority: 4,
        project: undefined,
        labels: [],
        due: '2026-11-13',
        recur: 'every friday',
        ref: 'c',
      },
      {
        title: 'Gym',
        notes: 'Repeats: every 3rd tuesday',
        priority: undefined,
        project: undefined,
        labels: [],
        due: '2026-11-13',
        recur: undefined,
        ref: 'd',
      },
    ])
    expect(tasks[0]?.source).toEqual({ kind: 'import', from: 'todoist', ref: 'a' })
  })
})

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, commas and line breaks in fields, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\n\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"\nthere'],
    ])
  })
})

describe('parseTodoistCsv', () => {
  const csv = [
    'TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT',
    'task,Plan offsite @travel,,1,1,Alice (1),,every month,en,America/New_York,,',
    'note,A comment,,,,,,,,,,',
    'section,Logistics,,,,,,,,,,',
    'task,Book hotel,Near the venue,4,1,Alice (1),,nov 20 3pm,en,America/New_York,,',
    'task,Ask about checkout,,2,2,Alice (1),,someday maybe,en,,,',
    'task,Book hotel,,4,1,Alice (1),,,en,,,',
  ].join('\n')

  it('maps rows: sections to labels, indents to sub-tasks, dates by quick add', () => {
    const tasks = parseTodoistCsv(csv, { projectName: 'Offsite', today: '2026-11-11', tz: 'UTC' })
    expect(
      tasks.map((t) => ({
        title: t.title,
        notes: t.notes,
        priority: t.priority,
        due: t.due,
        tz: t.tz,
        recur: t.recur,
        labels: t.labels,
        project: t.project,
      })),
    ).toEqual([
      {
        title: 'Plan offsite',
        notes: undefined,
        priority: 1,
        due: '2026-11-11',
        tz: undefined,
        recur: 'every month',
        labels: ['travel'],
        project: 'Offsite',
      },
      {
        title: 'Book hotel',
        notes: 'Near the venue',
        priority: undefined,
        due: '2026-11-20T15:00',
        tz: 'America/New_York',
        recur: undefined,
        labels: ['Logistics'],
        project: 'Offsite',
      },
      {
        title: 'Ask about checkout',
        notes: 'Sub-task of: Book hotel\n\nDue in Todoist: someday maybe',
        priority: 2,
        due: undefined,
        tz: undefined,
        recur: undefined,
        labels: ['Logistics'],
        project: 'Offsite',
      },
      {
        title: 'Book hotel',
        notes: undefined,
        priority: undefined,
        due: undefined,
        tz: undefined,
        recur: undefined,
        labels: ['Logistics'],
        project: 'Offsite',
      },
    ])
    // Rows have no id: the ref is stable across exports, and a repeated row gets its own.
    const again = parseTodoistCsv(csv, { projectName: 'Offsite', today: '2026-11-11', tz: 'UTC' })
    expect(again.map((t) => t.source.ref)).toEqual(tasks.map((t) => t.source.ref))
    expect(tasks[1]?.source.ref).not.toBe(tasks[3]?.source.ref)
    expect(tasks[3]?.source.ref).toMatch(/^csv:[0-9a-f]{16}:2$/)
  })

  it('puts Inbox tasks in no project, and refuses a file that isn’t an export', () => {
    const tasks = parseTodoistCsv('TYPE,CONTENT\ntask,Milk', {
      projectName: 'Inbox',
      today: '2026-11-11',
      tz: 'UTC',
    })
    expect(tasks[0]?.project).toBeUndefined()
    expect(() =>
      parseTodoistCsv('name,email\nx,y', { projectName: 'X', today: '2026-11-11', tz: 'UTC' }),
    ).toThrow(/Todoist CSV/)
  })
})

describe('TodoistImport', () => {
  function setup(pages: Record<string, unknown[][]>, imported = new Set<string>()) {
    const requests: Array<{ url: URL; auth: string | null }> = []
    const written: ImportedTask[][] = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      const auth = new Headers(init?.headers).get('authorization')
      requests.push({ url, auth })
      if (auth !== 'Bearer tok') return new Response('nope', { status: 403 })
      const endpoint = url.pathname.split('/').pop() ?? ''
      const list = pages[endpoint] ?? [[]]
      const n = Number(url.searchParams.get('cursor') ?? 0)
      return Response.json({
        results: list[n] ?? [],
        next_cursor: n + 1 < list.length ? String(n + 1) : null,
      })
    }
    const importer = new TodoistImport({
      fetch,
      tasks: {
        personalSpace: async () => 'alice',
        importedRefs: async () => imported,
        addMany: async (_p, _space, tasks, message) => {
          written.push(tasks as ImportedTask[])
          expect(message).toBe(`tasks: import ${tasks.length} from Todoist`)
        },
      },
    })
    return { importer, requests, written }
  }

  it('follows cursors, sends the token as a bearer, and skips what was imported', async () => {
    const { importer, requests, written } = setup(
      {
        projects: [[{ id: 'p', name: 'Ops' }]],
        tasks: [
          [{ id: '1', content: 'One', project_id: 'p' }],
          [
            { id: '2', content: 'Two', project_id: 'p' },
            { id: '3', content: 'Three' },
          ],
        ],
      },
      new Set(['1']),
    )
    const result = await importer.import(ALICE, { token: 'tok' })
    expect(result).toEqual({ imported: 2, skipped: 1, projects: ['Ops'] })
    expect(written[0]?.map((t) => t.title)).toEqual(['Two', 'Three'])
    const taskCalls = requests.filter((r) => r.url.pathname === '/api/v1/tasks')
    expect(taskCalls.map((r) => r.url.searchParams.get('cursor'))).toEqual([null, '1'])
    expect(requests.every((r) => r.url.origin === 'https://api.todoist.com')).toBe(true)
    expect(requests.every((r) => r.auth === 'Bearer tok')).toBe(true)
  })

  it('says so when Todoist refuses the token, without echoing it', async () => {
    const { importer } = setup({})
    const err = await importer.import(ALICE, { token: 'wrong-secret' }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'bad_request' })
    expect(String((err as Error).message)).not.toContain('wrong-secret')
  })
})
