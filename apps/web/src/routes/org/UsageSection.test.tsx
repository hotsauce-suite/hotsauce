import { render, screen, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import type { AppUsage, UsageReport } from '../../api/usage'
import { server } from '../../test/mockServer'
import { UsageSection } from './UsageSection'

// docs/PLAN-app-usage.md, U11 and U12.

const WEEKS = Array.from({ length: 12 }, (_, i) =>
  new Date(Date.UTC(2026, 7, 31 + i * 7)).toISOString().slice(0, 10),
)

function usage(id: string, perWeek: number[], people = 1): AppUsage {
  const weeks = WEEKS.map((week, i) => ({
    week,
    created: perWeek[i] ?? 0,
    changed: perWeek[i] ?? 0,
    people: (perWeek[i] ?? 0) > 0 ? people : 0,
  }))
  const total = perWeek.reduce((a, b) => a + b, 0)
  return {
    id,
    weeks,
    total: { created: total, changed: total, people: total > 0 ? people : 0 },
    peopleLast4Weeks: total > 0 ? people : 0,
  }
}

const report: UsageReport = {
  generatedAt: '2026-11-18T12:00:00Z',
  weeks: WEEKS,
  apps: [
    usage('tasks', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 3),
    usage('links', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1], 1),
    usage('boards', []),
    usage('pages', []),
  ],
  dictate: { connectedMacs: 2, usedLast7Days: 1 },
}

describe('Settings → Organization → Usage', () => {
  it('lists used apps busiest first with a chart each, and the unused ones on one line', async () => {
    server.use(http.get('*/api/admin/org/usage', () => HttpResponse.json(report)))
    render(<UsageSection />)
    const list = await screen.findByTestId('usage-apps')
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((r) => r.dataset.testid)).toEqual(['usage-tasks', 'usage-links'])
    expect(rows[0]).toHaveTextContent('78 items made or changed (78 new)')
    expect(rows[0]).toHaveTextContent('3 people in the last 4 weeks')
    expect(within(rows[0] as HTMLElement).getByRole('img')).toHaveAccessibleName(/Tasks: 1, 2, 3/)
    expect(screen.getByTestId('usage-unused')).toHaveTextContent('Boards, Pages')
  })

  it('says why Dictate, Today and Chat have no chart (U12)', async () => {
    server.use(http.get('*/api/admin/org/usage', () => HttpResponse.json(report)))
    render(<UsageSection />)
    expect(await screen.findByTestId('usage-dictate')).toHaveTextContent(
      '2 Macs connected, 1 used in the last 7 days',
    )
    expect(screen.getByTestId('usage-notes')).toHaveTextContent('Today and Chat aren’t counted')
  })

  it('has every number in a table too', async () => {
    server.use(http.get('*/api/admin/org/usage', () => HttpResponse.json(report)))
    render(<UsageSection />)
    const table = await screen.findByTestId('usage-table')
    expect(within(table).getAllByRole('row')).toHaveLength(5)
  })

  it('shows an error it can’t load', async () => {
    server.use(
      http.get('*/api/admin/org/usage', () =>
        HttpResponse.json(
          { error: { code: 'forbidden', message: 'Only an admin can see usage' } },
          { status: 403 },
        ),
      ),
    )
    render(<UsageSection />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Only an admin can see usage')
  })
})
