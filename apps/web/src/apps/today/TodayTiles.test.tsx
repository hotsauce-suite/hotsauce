import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { todayApi } from '../../api/today'
import { TOUCH_QUERY } from '../../hooks/useMediaQuery'
import { IPHONE, pretend } from '../../test/devices'
import { server } from '../../test/mockServer'
import { renderApp } from '../../test/renderApp'
import { STACKED_QUERY } from './TodayTiles'
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

  it('a tile with nothing today hides, leaving no gap, and shows a placeholder in edit mode', async () => {
    server.use(http.get('/api/tasks/from-meetings', () => HttpResponse.json([])))
    renderApp('/today')
    await screen.findByTestId('today-tasks')
    // Meetings and Tasks only: From your meetings leaves no empty wrapper behind.
    expect(screen.getByTestId('today-column-0').children).toHaveLength(2)
    await userEvent.click(screen.getByTestId('today-edit'))
    expect(screen.getByTestId('today-placeholder-action-items')).toBeInTheDocument()
  })

  it('if the saved layout does not load, shows the default and does not allow editing', async () => {
    server.use(http.get('/api/today/layout', () => HttpResponse.json({}, { status: 500 })))
    renderApp('/today')
    expect(await screen.findByTestId('today-layout-error')).toHaveTextContent('didn’t load')
    expect(await screen.findByTestId('today-tasks')).toBeInTheDocument()
    expect(screen.getByTestId('today-edit')).toBeDisabled()
  })

  it('tiles being arranged are inert, and Escape closes Add tile', async () => {
    await startEditing()
    const tasks = screen.getByTestId('today-tasks')
    expect(tasks.closest('[inert]')).not.toBeNull()
    await userEvent.click(screen.getByTestId('today-add-tile'))
    expect(screen.getByTestId('today-add-tile-menu')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('today-add-tile-menu')).toBeNull()
  })

  it('E1: Add tile offers only what is not shown, plus Board, and adds to the shorter column', async () => {
    await startEditing()
    await userEvent.click(screen.getByTestId('today-add-tile'))
    const menu = screen.getByTestId('today-add-tile-menu')
    expect(within(menu).queryByTestId('today-add-tasks')).toBeNull()
    expect(within(menu).getByTestId('today-add-board')).toBeInTheDocument()
    await userEvent.click(within(menu).getByTestId('today-add-starred'))
    expect(tileIds(1)).toEqual(['notes', 'docs', 'brief', 'starred'])
    await addTile('board')
    await addTile('board')
    expect(tileIds(0).at(-1)).toBe('board')
    expect(tileIds(1).at(-1)).toBe('board-2')
  })

  it('E2: arrows, Other column and ✕ rearrange tiles', async () => {
    await startEditing()
    const tasks = () =>
      screen
        .getAllByTestId('today-edit-tile')
        .find((t) => t.dataset.tileId === 'tasks') as HTMLElement
    await userEvent.click(within(tasks()).getByTestId('today-tile-up'))
    expect(tileIds(0)).toEqual(['checkins', 'tasks', 'meetings', 'action-items'])
    await userEvent.click(within(tasks()).getByTestId('today-tile-up'))
    expect(tileIds(0)).toEqual(['tasks', 'checkins', 'meetings', 'action-items'])
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
    expect(saved.layout.columns[1].map((t) => t.kind)).toContain('dictate')

    await userEvent.click(screen.getByTestId('today-edit'))
    await userEvent.click(screen.getByTestId('today-reset'))
    expect(tileIds(0)).toEqual(['checkins', 'meetings', 'tasks', 'action-items'])
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

const frame = (id: string) =>
  screen.getAllByTestId('today-edit-tile').find((t) => t.dataset.tileId === id) as HTMLElement

describe('Today tiles: on a phone (E6, E7)', () => {
  it('E7: Edit Today is a small button below the tiles; the edit bar is pinned at the top', async () => {
    renderApp('/today')
    await screen.findByTestId('today-tasks')
    const edit = screen.getByTestId('today-edit')
    const tiles = screen.getByTestId('today-tiles')
    // Later in the page than every tile.
    expect(tiles.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(edit.className).toContain('text-xs')
    await userEvent.click(edit)
    const bar = screen.getByTestId('today-edit-bar')
    expect(tiles.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(bar.className).toContain('sticky top-0')
    expect(screen.queryByTestId('today-edit')).toBeNull()
  })

  it('E6: the arrows move a tile through the whole list, across the column break', async () => {
    pretend({ ua: IPHONE, touch: 5, queries: [STACKED_QUERY, TOUCH_QUERY] })
    await startEditing()
    // The bottom of the left column goes on down into the right one, and back up.
    expect(within(frame('action-items')).getByTestId('today-tile-down')).toBeEnabled()
    await userEvent.click(within(frame('action-items')).getByTestId('today-tile-down'))
    expect([...tileIds(0), ...tileIds(1)]).toEqual([
      'checkins',
      'meetings',
      'tasks',
      'notes',
      'action-items',
      'docs',
      'brief',
    ])
    await userEvent.click(within(frame('action-items')).getByTestId('today-tile-down'))
    await userEvent.click(within(frame('action-items')).getByTestId('today-tile-down'))
    expect(within(frame('action-items')).getByTestId('today-tile-down')).toBeDisabled()
    // The top of the right column goes up into the left one.
    expect(tileIds(1)).toEqual(['docs', 'brief', 'action-items'])
    await userEvent.click(within(frame('docs')).getByTestId('today-tile-up'))
    expect(tileIds(0).at(-1)).toBe('docs')
    expect(within(frame('checkins')).getByTestId('today-tile-up')).toBeDisabled()
    // One list: no "Other column", no drag-target boxes, and no browser drag from a long press.
    expect(screen.queryByTestId('today-tile-across')).toBeNull()
    expect(frame('tasks')).toHaveAttribute('draggable', 'false')
  })

  it('E6: a tile dragged by its handle with a finger lands where it is let go', async () => {
    pretend({ ua: IPHONE, touch: 5, queries: [STACKED_QUERY, TOUCH_QUERY] })
    await startEditing()
    const target = frame('docs')
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 500, 300, 200))
    const original = document.elementFromPoint
    document.elementFromPoint = () => target
    try {
      const grip = within(frame('checkins')).getByTestId('today-tile-grip')
      fireEvent.pointerDown(grip, { pointerType: 'touch', clientX: 10, clientY: 20 })
      expect(frame('checkins').className).toContain('opacity-50')
      // Lower half of Docs changed: after it.
      fireEvent.pointerMove(window, { pointerType: 'touch', clientX: 10, clientY: 650 })
      expect(within(target).getByTestId('today-drop-marker')).toHaveAttribute('data-side', 'after')
      expect(screen.getByTestId('today-drag-ghost')).toHaveTextContent('Check-in')
      fireEvent.pointerUp(window, { pointerType: 'touch', clientX: 10, clientY: 650 })
    } finally {
      document.elementFromPoint = original
    }
    expect(tileIds(0)).toEqual(['meetings', 'tasks', 'action-items'])
    expect(tileIds(1)).toEqual(['notes', 'docs', 'checkins', 'brief'])
    expect(screen.queryByTestId('today-drop-marker')).toBeNull()
    expect(screen.queryByTestId('today-drag-ghost')).toBeNull()
  })

  it('E6: letting go in a gap between tiles still lands where the bar last showed', async () => {
    pretend({ ua: IPHONE, touch: 5, queries: [STACKED_QUERY, TOUCH_QUERY] })
    await startEditing()
    const target = frame('docs')
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 500, 300, 200))
    const gap = document.createElement('div')
    document.body.append(gap)
    const original = document.elementFromPoint
    let under: Element = target
    document.elementFromPoint = () => under
    try {
      const grip = within(frame('checkins')).getByTestId('today-tile-grip')
      fireEvent.pointerDown(grip, { pointerType: 'touch', pointerId: 7, clientX: 10, clientY: 20 })
      fireEvent.pointerMove(window, {
        pointerType: 'touch',
        pointerId: 7,
        clientX: 10,
        clientY: 520,
      })
      // A second finger doesn't steer or end the drag.
      fireEvent.pointerUp(window, { pointerType: 'touch', pointerId: 8, clientX: 10, clientY: 900 })
      expect(screen.getByTestId('today-drag-ghost')).toBeInTheDocument()
      under = gap
      fireEvent.pointerMove(window, {
        pointerType: 'touch',
        pointerId: 7,
        clientX: 10,
        clientY: 495,
      })
      expect(within(target).getByTestId('today-drop-marker')).toHaveAttribute('data-side', 'before')
      fireEvent.pointerUp(window, { pointerType: 'touch', pointerId: 7, clientX: 10, clientY: 495 })
    } finally {
      document.elementFromPoint = original
      gap.remove()
    }
    expect(tileIds(1)).toEqual(['notes', 'checkins', 'docs', 'brief'])
  })

  it('E6: keyboard focus stays on the arrow when a tile crosses the column break', async () => {
    pretend({ ua: IPHONE, touch: 5, queries: [STACKED_QUERY, TOUCH_QUERY] })
    await startEditing()
    within(frame('action-items')).getByTestId('today-tile-down').focus()
    await userEvent.keyboard('{Enter}')
    expect(tileIds(1)[0]).toBe('action-items')
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(frame('action-items')).getByTestId('today-tile-down'),
      ),
    )
  })

  it('E6: a cancelled touch drag moves nothing, and a mouse never starts one', async () => {
    pretend({ ua: IPHONE, touch: 5, queries: [STACKED_QUERY, TOUCH_QUERY] })
    await startEditing()
    const target = frame('docs')
    const original = document.elementFromPoint
    document.elementFromPoint = () => target
    try {
      const grip = within(frame('checkins')).getByTestId('today-tile-grip')
      fireEvent.pointerDown(grip, { pointerType: 'touch', clientX: 10, clientY: 20 })
      fireEvent.pointerMove(window, { pointerType: 'touch', clientX: 10, clientY: 650 })
      fireEvent.pointerCancel(window, { pointerType: 'touch' })
      fireEvent.pointerDown(grip, { pointerType: 'mouse', clientX: 10, clientY: 20 })
      expect(frame('checkins').className).not.toContain('opacity-50')
      fireEvent.pointerUp(window, { pointerType: 'mouse', clientX: 10, clientY: 650 })
    } finally {
      document.elementFromPoint = original
    }
    expect(tileIds(0)).toEqual(['checkins', 'meetings', 'tasks', 'action-items'])
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
