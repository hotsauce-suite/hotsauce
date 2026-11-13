import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import { todayApi } from '../../api/today'
import { server } from '../../test/mockServer'
import { renderApp } from '../../test/renderApp'
import { isoDate, weekDays } from './tiles/MoreTiles'

const tileIds = (column: 0 | 1) =>
  within(screen.getByTestId(`today-column-${column}`))
    .getAllByTestId('today-edit-tile')
    .map((el) => el.dataset.tileId)

async function startEditing() {
  renderApp('/today')
  await screen.findByTestId('today-tasks')
  await userEvent.click(screen.getByTestId('today-edit'))
}

async function addTile(kind: string) {
  await userEvent.click(screen.getByTestId('today-add-tile'))
  await userEvent.click(screen.getByTestId(`today-add-${kind}`))
}

describe('Today tiles: editing (E1–E3)', () => {
  it('L3: with nothing saved, Today has the tiles it always had', async () => {
    renderApp('/today')
    expect(await screen.findByTestId('today-meetings')).toBeInTheDocument()
    expect(screen.getByTestId('today-tasks')).toBeInTheDocument()
    expect(screen.getByTestId('today-docs')).toBeInTheDocument()
    expect(screen.getByTestId('today-brief')).toBeInTheDocument()
    expect(screen.queryByTestId('today-starred')).toBeNull()
  })

  it('E1: Add tile offers only what is not shown, plus Board, and adds to the shorter column', async () => {
    await startEditing()
    await userEvent.click(screen.getByTestId('today-add-tile'))
    const menu = screen.getByTestId('today-add-tile-menu')
    expect(within(menu).queryByTestId('today-add-tasks')).toBeNull()
    expect(within(menu).getByTestId('today-add-board')).toBeInTheDocument()
    await userEvent.click(within(menu).getByTestId('today-add-starred'))
    expect(tileIds(0)).toEqual(['meetings', 'tasks', 'action-items', 'starred'])
    await addTile('board')
    await addTile('board')
    expect(tileIds(1).at(-1)).toBe('board')
    expect(tileIds(0).at(-1)).toBe('board-2')
  })

  it('E2: arrows, To right and ✕ rearrange tiles', async () => {
    await startEditing()
    const tasks = () =>
      screen
        .getAllByTestId('today-edit-tile')
        .find((t) => t.dataset.tileId === 'tasks') as HTMLElement
    await userEvent.click(within(tasks()).getByTestId('today-tile-up'))
    expect(tileIds(0)).toEqual(['tasks', 'meetings', 'action-items'])
    expect(within(tasks()).getByTestId('today-tile-up')).toBeDisabled()
    await userEvent.click(within(tasks()).getByTestId('today-tile-across'))
    expect(tileIds(1)).toEqual(['notes', 'docs', 'brief', 'tasks'])
    await userEvent.click(within(tasks()).getByTestId('today-tile-remove'))
    expect(tileIds(1)).toEqual(['notes', 'docs', 'brief'])
  })

  it('E3: Done saves, Cancel throws changes away, Reset restores the default', async () => {
    await startEditing()
    await addTile('dictate')
    await userEvent.click(screen.getByTestId('today-cancel'))
    expect(screen.queryByTestId('today-dictate')).toBeNull()

    await userEvent.click(screen.getByTestId('today-edit'))
    await addTile('dictate')
    await userEvent.click(screen.getByTestId('today-done'))
    expect(await screen.findByTestId('today-dictate-go')).toHaveAttribute('href', '/dictate')
    expect(screen.queryByTestId('today-edit-bar')).toBeNull()
    const saved = await todayApi.layout()
    expect(saved.saved).toBe(true)
    expect(saved.layout.columns[0].map((t) => t.kind)).toContain('dictate')

    await userEvent.click(screen.getByTestId('today-edit'))
    await userEvent.click(screen.getByTestId('today-reset'))
    expect(tileIds(0)).toEqual(['meetings', 'tasks', 'action-items'])
  })

  it('E3: a failed save says so and stays in edit mode', async () => {
    server.use(
      http.put('/api/today/layout', () =>
        HttpResponse.json(
          { error: { code: 'bad_request', message: 'No personal space' } },
          { status: 400 },
        ),
      ),
    )
    await startEditing()
    await addTile('clip')
    await userEvent.click(screen.getByTestId('today-done'))
    expect(await screen.findByTestId('today-layout-error')).toHaveTextContent('No personal space')
    expect(screen.getByTestId('today-edit-bar')).toBeInTheDocument()
  })
})

describe('Today tiles: the new tiles (T1–T5, E4)', () => {
  it('T1: Starred lists starred items', async () => {
    server.use(
      http.get('/api/stars', () =>
        HttpResponse.json([{ space: 'team', path: 'docs/plan.md', title: 'The plan' }]),
      ),
    )
    await startEditing()
    await addTile('starred')
    await userEvent.click(screen.getByTestId('today-done'))
    const item = await screen.findByTestId('today-starred-item')
    expect(item).toHaveTextContent('The plan')
  })

  it('T2: Record a clip goes to a new clip', async () => {
    await startEditing()
    await addTile('clip')
    expect(screen.getByTestId('today-clip-go')).toHaveAttribute('href', '/clips/new')
  })

  it('T3: People and Recent files list what they load', async () => {
    server.use(
      http.get('/api/files/recent', () =>
        HttpResponse.json({
          files: [
            {
              id: 'f1',
              space: 'team',
              name: 'Budget.xlsx',
              url: '/files/team/f1',
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
      ),
    )
    await startEditing()
    await addTile('people')
    await addTile('files')
    await userEvent.click(screen.getByTestId('today-done'))
    expect(await screen.findByTestId('today-file')).toHaveTextContent('Budget.xlsx')
    expect((await screen.findAllByTestId('today-person')).length).toBeGreaterThan(0)
  })

  it('E4, T4: a Board tile asks which board, then shows it', async () => {
    const board = {
      space: 'team',
      id: 'B1',
      path: 'boards/B1.md',
      blobOid: 'x',
      title: 'Launch map',
      created: new Date().toISOString(),
      createdBy: 'me',
      updated: new Date().toISOString(),
      updatedBy: null,
    }
    server.use(
      http.get('/api/boards', () => HttpResponse.json({ boards: [board] })),
      http.get('/api/boards/team/B1', () =>
        HttpResponse.json({ ...board, scene: { elements: [] }, texts: ['Hire', 'Ship'] }),
      ),
    )
    await startEditing()
    await addTile('board')
    await userEvent.click(screen.getByTestId('today-done'))
    await userEvent.selectOptions(await screen.findByTestId('today-board-choose'), 'team/B1')
    expect(await screen.findByTestId('today-board-open')).toHaveTextContent('Launch map')
    expect(screen.getByTestId('today-board-open')).toHaveTextContent('Hire · Ship')
    await waitFor(async () =>
      expect(JSON.stringify((await todayApi.layout()).layout)).toContain('"id":"B1"'),
    )
  })

  it('T5: This week runs Monday to Sunday and shows a picked day', async () => {
    const days = weekDays(new Date(2026, 10, 13))
    expect(days.map((d) => d.getDay())).toEqual([1, 2, 3, 4, 5, 6, 0])
    expect(isoDate(days[0] as Date)).toBe('2026-11-09')

    await startEditing()
    await addTile('week')
    await userEvent.click(screen.getByTestId('today-done'))
    const week = await screen.findByTestId('today-week')
    const buttons = await within(week).findAllByTestId('today-week-day')
    expect(buttons).toHaveLength(7)
    const today = buttons.find((b) => b.dataset.date === isoDate(new Date())) as HTMLElement
    expect(today).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(buttons[0] as HTMLElement)
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true')
  })
})
