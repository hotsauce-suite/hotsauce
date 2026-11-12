import { describe, expect, it } from 'vitest'
import {
  COLUMNS,
  columnOf,
  decide,
  LABELS,
  run,
} from '../../../../.github/scripts/feedback-board.mjs'
import { FEEDBACK_STATUSES, statusLabel } from './tracker.js'

// The board-sync Action (plan R10), driven against a fake GitHub.

describe('board columns and app statuses', () => {
  it('are the same set, in the same order', () => {
    expect(COLUMNS.map((c) => c.name.toLowerCase())).toEqual([...FEEDBACK_STATUSES])
    for (const s of FEEDBACK_STATUSES) {
      expect(LABELS.map((l) => l.name)).toContain(statusLabel(s))
    }
  })
})

describe('columnOf', () => {
  it('reads the status label, else closed is Shipped and open is New', () => {
    expect(columnOf(['feedback', 'status: needs decision'], 'open')).toBe('Needs decision')
    expect(columnOf(['feedback'], 'closed')).toBe('Shipped')
    expect(columnOf(['feedback'], 'open')).toBe('New')
  })
})

describe('decide', () => {
  const base = { column: 'Approved', labelColumn: 'Needs decision' }
  it('lets the newer change win', () => {
    expect(
      decide({
        ...base,
        columnUpdatedAt: '2026-11-12T10:00:00Z',
        labelUpdatedAt: '2026-11-12T09:00:00Z',
      }),
    ).toBe('set-labels')
    expect(
      decide({
        ...base,
        columnUpdatedAt: '2026-11-12T08:00:00Z',
        labelUpdatedAt: '2026-11-12T09:00:00Z',
      }),
    ).toBe('set-column')
  })
  it('puts a card with no column where its labels say', () => {
    expect(
      decide({ column: null, columnUpdatedAt: null, labelColumn: 'New', labelUpdatedAt: null }),
    ).toBe('set-column')
  })
  it('does nothing when they agree', () => {
    expect(
      decide({ column: 'New', columnUpdatedAt: null, labelColumn: 'New', labelUpdatedAt: null }),
    ).toBe('none')
  })
})

function fakeGitHub(state: {
  labels: string[]
  issues: { number: number; node_id: string; labels: { name: string }[]; state: string }[]
  items: {
    id: string
    number: number
    state: string
    labels: string[]
    column: string | null
    columnUpdatedAt: string | null
  }[]
  events: Record<number, { event: string; label?: { name: string }; created_at: string }[]>
}) {
  const calls: string[] = []
  const options = COLUMNS.map((c, i) => ({ id: `opt${i}`, name: c.name }))
  const listLabelsForRepo = Symbol('labels')
  const listForRepo = Symbol('issues')
  const listEvents = Symbol('events')
  const github = {
    paginate: async (fn: symbol, args: { issue_number?: number }) => {
      if (fn === listLabelsForRepo) return state.labels.map((name) => ({ name }))
      if (fn === listForRepo) return state.issues
      if (fn === listEvents) return state.events[args.issue_number ?? 0] ?? []
      throw new Error('unexpected paginate')
    },
    rest: {
      issues: {
        listLabelsForRepo,
        listForRepo,
        listEvents,
        createLabel: async (l: { name: string }) => {
          calls.push(`createLabel ${l.name}`)
          state.labels.push(l.name)
        },
        removeLabel: async (a: { issue_number: number; name: string }) =>
          calls.push(`removeLabel #${a.issue_number} ${a.name}`),
        addLabels: async (a: { issue_number: number; labels: string[] }) =>
          calls.push(`addLabels #${a.issue_number} ${a.labels.join(',')}`),
        update: async (a: { issue_number: number; state: string }) =>
          calls.push(`update #${a.issue_number} ${a.state}`),
      },
    },
    graphql: async (query: string, vars: Record<string, unknown>) => {
      if (query.includes('projectsV2(')) {
        return {
          organization: {
            projectsV2: {
              nodes: [
                {
                  id: 'P',
                  title: 'Feedback',
                  url: 'https://github.com/orgs/o/projects/1',
                  closed: false,
                  field: { id: 'F', options },
                },
              ],
            },
          },
        }
      }
      if (query.includes('addProjectV2ItemById')) {
        calls.push(`addItem ${vars.contentId}`)
        return { addProjectV2ItemById: { item: { id: `item-${vars.contentId}` } } }
      }
      if (query.includes('updateProjectV2ItemFieldValue')) {
        const name = options.find((o) => o.id === vars.optionId)?.name
        calls.push(`setColumn ${vars.itemId} ${name}`)
        return {}
      }
      if (query.includes('items(first')) {
        return {
          node: {
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: state.items.map((i) => ({
                id: i.id,
                fieldValueByName: i.column
                  ? { name: i.column, updatedAt: i.columnUpdatedAt }
                  : null,
                content: {
                  number: i.number,
                  state: i.state === 'closed' ? 'CLOSED' : 'OPEN',
                  repository: { nameWithOwner: 'o/r' },
                  labels: { nodes: i.labels.map((name) => ({ name })) },
                },
              })),
            },
          },
        }
      }
      throw new Error(`unexpected graphql ${query.slice(0, 60)}`)
    },
  }
  const notices: string[] = []
  const core = { notice: (m: string) => notices.push(m), info: () => {}, setOutput: () => {} }
  return { github, core, calls, notices }
}

const context = (payload: unknown = {}) => ({ repo: { owner: 'o', repo: 'r' }, payload })

describe('run', () => {
  it('without the token only creates the labels', async () => {
    const f = fakeGitHub({ labels: ['bug'], issues: [], items: [], events: {} })
    await run({ ...f, context: context(), mode: 'sweep', hasToken: false })
    expect(f.calls).toContain('createLabel feedback')
    expect(f.calls).not.toContain('createLabel bug')
    expect(f.calls.some((c) => c.startsWith('setColumn'))).toBe(false)
    expect(f.notices[0]).toContain('FEEDBACK_PROJECT_TOKEN')
  })

  it('on an issue event, puts the card in the column its labels say', async () => {
    const f = fakeGitHub({ labels: LABELS.map((l) => l.name), issues: [], items: [], events: {} })
    await run({
      ...f,
      context: context({
        action: 'labeled',
        label: { name: 'status: needs info' },
        issue: {
          node_id: 'I1',
          state: 'open',
          labels: [{ name: 'feedback' }, { name: 'status: needs info' }],
        },
      }),
      mode: 'event',
      hasToken: true,
    })
    expect(f.calls).toEqual(['addItem I1', 'setColumn item-I1 Needs info'])
  })

  it('on an event that is not a status change, leaves the card where the owner put it', async () => {
    const f = fakeGitHub({ labels: LABELS.map((l) => l.name), issues: [], items: [], events: {} })
    await run({
      ...f,
      context: context({
        action: 'labeled',
        label: { name: 'bug' },
        issue: { node_id: 'I1', state: 'open', labels: [{ name: 'feedback' }, { name: 'bug' }] },
      }),
      mode: 'event',
      hasToken: true,
    })
    expect(f.calls).toEqual([])
  })

  it('on a sweep, a card moved after the last label change sets the labels and closes', async () => {
    const f = fakeGitHub({
      labels: LABELS.map((l) => l.name),
      issues: [],
      items: [
        {
          id: 'A',
          number: 5,
          state: 'open',
          labels: ['feedback', 'idea', 'status: needs decision'],
          column: 'Declined',
          columnUpdatedAt: '2026-11-12T10:00:00Z',
        },
        {
          id: 'B',
          number: 6,
          state: 'open',
          labels: ['feedback', 'bug', 'status: approved'],
          column: 'Needs decision',
          columnUpdatedAt: '2026-11-12T08:00:00Z',
        },
      ],
      events: {
        5: [
          {
            event: 'labeled',
            label: { name: 'status: needs decision' },
            created_at: '2026-11-12T09:00:00Z',
          },
        ],
        6: [
          {
            event: 'labeled',
            label: { name: 'status: approved' },
            created_at: '2026-11-12T09:00:00Z',
          },
        ],
      },
    })
    await run({ ...f, context: context(), mode: 'sweep', hasToken: true })
    expect(f.calls).toEqual([
      'removeLabel #5 status: needs decision',
      'addLabels #5 status: declined',
      'update #5 closed',
      'setColumn B Approved',
    ])
  })

  it('on a sweep, adds feedback issues missing from the board', async () => {
    const f = fakeGitHub({
      labels: LABELS.map((l) => l.name),
      issues: [
        {
          number: 9,
          node_id: 'I9',
          state: 'open',
          labels: [{ name: 'feedback' }, { name: 'status: new' }],
        },
      ],
      items: [],
      events: {},
    })
    await run({ ...f, context: context(), mode: 'sweep', hasToken: true })
    expect(f.calls).toEqual(['addItem I9', 'setColumn item-I9 New'])
  })
})
