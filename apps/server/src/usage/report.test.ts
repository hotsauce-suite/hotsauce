import { describe, expect, it } from 'vitest'
import type { ActivityCommit } from '../git/index.js'
import { appOfPath, buildUsageReport, type UsageInput, weekOf, weekStarts } from './report.js'

// docs/PLAN-app-usage.md, U2 and U4–U9.

const NOW = new Date('2026-11-18T12:00:00Z') // a Wednesday; its week starts Monday 2026-11-16

function input(over: Partial<UsageInput> = {}): UsageInput {
  return {
    now: NOW,
    weeks: 12,
    spaces: [],
    clips: [],
    dictateDevices: [],
    ignoreEmails: ['hotsauce@acme.example'],
    ...over,
  }
}

const commit = (
  email: string,
  date: string,
  files: ActivityCommit['files'],
  subject = 'docs: edit',
): ActivityCommit => ({ email, date, subject, files })

const app = (report: ReturnType<typeof buildUsageReport>, id: string) => {
  const found = report.apps.find((a) => a.id === id)
  if (!found) throw new Error(`no ${id}`)
  return found
}

describe('weeks', () => {
  it('starts weeks on Monday, UTC', () => {
    expect(weekOf(new Date('2026-11-16T00:00:00Z'))).toBe('2026-11-16')
    expect(weekOf(new Date('2026-11-22T23:59:59Z'))).toBe('2026-11-16')
    expect(weekOf(new Date('2026-11-15T23:59:59Z'))).toBe('2026-11-09')
  })

  it('lists the window oldest first, the current week last', () => {
    const weeks = weekStarts(NOW, 12)
    expect(weeks).toHaveLength(12)
    expect(weeks.at(-1)).toBe('2026-11-16')
    expect(weeks[0]).toBe('2026-08-31')
  })

  it('crosses a year end', () => {
    expect(weekOf(new Date('2027-01-01T08:00:00Z'))).toBe('2026-12-28')
  })
})

describe('appOfPath (U4)', () => {
  it('maps a top folder to its app', () => {
    expect(appOfPath('tasks/01J.md')).toBe('tasks')
    expect(appOfPath('links/01J.md')).toBe('links')
    expect(appOfPath('forms/01J/01K.md')).toBe('forms')
    expect(appOfPath('checkins/01J/2026-11-16/01K.md')).toBe('checkins')
    expect(appOfPath('pages/01J.html')).toBe('pages')
  })

  it('counts any other visible file as Docs, like the web app does', () => {
    expect(appOfPath('README.md')).toBe('docs')
    expect(appOfPath('docs/plan.md')).toBe('docs')
    expect(appOfPath('Projects/plan.md')).toBe('docs')
    expect(appOfPath('assets/photo.png')).toBe('docs')
  })

  it('counts Briefcast episodes and nothing else hidden', () => {
    expect(appOfPath('.hearth/briefcast/2026-11-16.md')).toBe('briefcast')
    expect(appOfPath('.hearth/space.yaml')).toBeNull()
    expect(appOfPath('.hearth/brief/brief.md')).toBeNull()
    expect(appOfPath('.trash/docs/old.md')).toBeNull()
    expect(appOfPath('docs/.draft.md')).toBeNull()
  })
})

describe('buildUsageReport', () => {
  it('counts created, changed and people per week per app (U2)', () => {
    const report = buildUsageReport(
      input({
        spaces: [
          {
            space: 'team',
            commits: [
              commit('ann@acme.com', '2026-11-16T09:00:00Z', [
                { path: 'tasks/a.md', change: 'added' },
              ]),
              commit('bo@acme.com', '2026-11-17T09:00:00Z', [
                { path: 'tasks/a.md', change: 'changed' },
                { path: 'tasks/b.md', change: 'added' },
              ]),
              commit('ann@acme.com', '2026-11-10T09:00:00Z', [
                { path: 'tasks/old.md', change: 'changed' },
              ]),
            ],
          },
        ],
      }),
    )
    const tasks = app(report, 'tasks')
    expect(tasks.weeks.at(-1)).toEqual({ week: '2026-11-16', created: 2, changed: 2, people: 2 })
    expect(tasks.weeks.at(-2)).toEqual({ week: '2026-11-09', created: 0, changed: 1, people: 1 })
    expect(tasks.total).toEqual({ created: 2, changed: 3, people: 2 })
    expect(tasks.peopleLast4Weeks).toBe(2)
  })

  it('counts an item changed many times in a week once (U6)', () => {
    const edits = Array.from({ length: 20 }, (_, i) =>
      commit('ann@acme.com', `2026-11-16T09:${String(i).padStart(2, '0')}:00Z`, [
        { path: 'docs/plan.md', change: 'changed' },
      ]),
    )
    const docs = app(
      buildUsageReport(input({ spaces: [{ space: 'team', commits: edits }] })),
      'docs',
    )
    expect(docs.weeks.at(-1)).toMatchObject({ changed: 1, people: 1 })
  })

  it('keeps the same path in two spaces apart (U3)', () => {
    const files: ActivityCommit['files'] = [{ path: 'notes/a.md', change: 'added' }]
    const report = buildUsageReport(
      input({
        spaces: [
          { space: 'team', commits: [commit('ann@acme.com', '2026-11-16T09:00:00Z', files)] },
          { space: 'bo', commits: [commit('bo@acme.com', '2026-11-16T09:00:00Z', files)] },
        ],
      }),
    )
    expect(app(report, 'notes').total).toEqual({ created: 2, changed: 2, people: 2 })
  })

  it('leaves out Hotsauce’s own changes, new spaces’ seed files and hidden files (U4, U5)', () => {
    const report = buildUsageReport(
      input({
        spaces: [
          {
            space: 'team',
            commits: [
              commit('Hotsauce@Acme.Example', '2026-11-16T09:00:00Z', [
                { path: 'checkins/x/2026-11-16/summary.md', change: 'added' },
              ]),
              commit('ann@acme.com', '2026-11-16T09:00:00Z', [
                { path: '.hearth/space.yaml', change: 'changed' },
              ]),
              commit(
                'ann@acme.com',
                '2026-11-16T09:00:00Z',
                [{ path: 'README.md', change: 'added' }],
                'hotsauce: create space "ann"',
              ),
            ],
          },
        ],
      }),
    )
    for (const a of report.apps) expect(a.total).toEqual({ created: 0, changed: 0, people: 0 })
  })

  it('ignores anything before the window or after now', () => {
    const report = buildUsageReport(
      input({
        spaces: [
          {
            space: 'team',
            commits: [
              commit('ann@acme.com', '2026-08-30T23:59:59Z', [{ path: 'a.md', change: 'added' }]),
              commit('ann@acme.com', '2026-11-19T09:00:00Z', [{ path: 'b.md', change: 'added' }]),
              commit('ann@acme.com', 'not a date', [{ path: 'c.md', change: 'added' }]),
            ],
          },
        ],
      }),
    )
    expect(app(report, 'docs').total.changed).toBe(0)
  })

  it('counts clips from their own list (U7)', () => {
    const report = buildUsageReport(
      input({
        clips: [
          { id: 'c1', ownerEmail: 'ann@acme.com', createdAt: '2026-11-16T10:00:00Z' },
          { id: 'c2', ownerEmail: 'ANN@acme.com', createdAt: '2026-11-17T10:00:00Z' },
          { id: 'c3', ownerEmail: 'bo@acme.com', createdAt: '2026-11-02T10:00:00Z' },
        ],
      }),
    )
    const clips = app(report, 'clips')
    expect(clips.weeks.at(-1)).toMatchObject({ created: 2, people: 1 })
    expect(clips.total).toEqual({ created: 3, changed: 3, people: 2 })
  })

  it('reports only how many Macs Dictate has and how many were used this week (U8)', () => {
    const report = buildUsageReport(
      input({
        dictateDevices: [
          { lastUsedAt: '2026-11-17T10:00:00Z' },
          { lastUsedAt: '2026-11-01T10:00:00Z' },
          { lastUsedAt: null },
        ],
      }),
    )
    expect(report.dictate).toEqual({ connectedMacs: 3, usedLast7Days: 1 })
  })

  it('puts the busiest app first and lists every app (U11)', () => {
    const report = buildUsageReport(
      input({
        spaces: [
          {
            space: 'team',
            commits: [
              commit('ann@acme.com', '2026-11-16T09:00:00Z', [
                { path: 'links/a.md', change: 'added' },
                { path: 'links/b.md', change: 'added' },
                { path: 'tasks/a.md', change: 'added' },
              ]),
            ],
          },
        ],
      }),
    )
    expect(report.apps.slice(0, 2).map((a) => a.id)).toEqual(['links', 'tasks'])
    expect(report.apps).toHaveLength(14)
    expect(report.weeks).toHaveLength(12)
  })

  it('never carries a path, a space or an address (U9)', () => {
    const report = buildUsageReport(
      input({
        spaces: [
          {
            space: 'secret-space',
            commits: [
              commit('ann@acme.com', '2026-11-16T09:00:00Z', [
                { path: 'docs/Secret plan.md', change: 'added' },
              ]),
            ],
          },
        ],
        clips: [{ id: 'clip-id-1', ownerEmail: 'bo@acme.com', createdAt: '2026-11-16T10:00:00Z' }],
      }),
    )
    const text = JSON.stringify(report)
    for (const leak of ['secret', 'Secret', 'ann@', 'bo@', 'clip-id-1']) {
      expect(text).not.toContain(leak)
    }
  })
})
