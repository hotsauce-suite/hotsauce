import {
  defaultTodayLayout,
  offerGettingStarted,
  type TodayLayout,
  updateTile,
} from '@hotsauce/format'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dictationApi } from '../../../api/dictation'
import { TOUCH_QUERY } from '../../../hooks/useMediaQuery'
import { IPHONE, pretend } from '../../../test/devices'
import { server } from '../../../test/mockServer'
import { renderApp } from '../../../test/renderApp'

// The Getting started tile (docs/PLAN-getting-started.md, T1–T6).

const step = (id: string) =>
  screen.getAllByTestId('today-start-step').find((el) => el.dataset.step === id) as
    | HTMLElement
    | undefined

/** Every layout the page saves, in order. */
function watchSaves(): TodayLayout[] {
  const saves: TodayLayout[] = []
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'PUT' && new URL(request.url).pathname === '/api/today/layout')
      void request
        .clone()
        .json()
        .then((body: { layout: TodayLayout }) => saves.push(body.layout))
  })
  return saves
}

const kinds = (layout: TodayLayout) => layout.columns.flat().map((t) => t.kind)

const noCalendar = () =>
  server.use(
    http.get('/api/calendar/upcoming', () =>
      HttpResponse.json(
        { error: { code: 'forbidden', message: 'Google Calendar is not connected.' } },
        { status: 403 },
      ),
    ),
  )

afterEach(() => {
  server.events.removeAllListeners()
  vi.restoreAllMocks()
})

describe('Getting started on Today', () => {
  it('T1: is the first tile for a new member, with steps ticked from what is really so', async () => {
    renderApp('/today')
    const tile = await screen.findByTestId('today-start')
    expect(screen.getByTestId('today-column-0').firstElementChild?.contains(tile)).toBe(true)
    // The sample calendar is connected; no Mac yet; Docs not opened from here.
    await waitFor(() => expect(step('mac')?.dataset.done).toBe('false'))
    expect(step('calendar')?.dataset.done).toBe('true')
    expect(step('docs')?.dataset.done).toBe('false')
    expect(screen.getByTestId('today-start-count')).toHaveTextContent('1 of 3')
    expect(within(tile).getByTestId('today-start-mac')).toHaveAttribute(
      'href',
      '/settings/apps#mac-app',
    )
    // A done step offers nothing more to do.
    expect(within(tile).queryByTestId('today-start-calendar')).toBeNull()
  })

  it('T1/T6: with no calendar, the step and the Meetings tile both lead to Connections', async () => {
    noCalendar()
    renderApp('/today')
    await screen.findByTestId('today-start')
    expect(step('calendar')?.dataset.done).toBe('false')
    expect(screen.getByTestId('today-start-calendar')).toHaveAttribute(
      'href',
      '/settings/connections#calendars',
    )
    const connect = screen.getByTestId('today-calendar-connect')
    expect(within(connect).getByRole('link', { name: 'Connect calendar' })).toHaveAttribute(
      'href',
      '/settings/connections#calendars',
    )
    // It isn't worded as an error.
    expect(screen.queryByTestId('today-calendar-error')).toBeNull()
  })

  it('T1: a connected Mac ticks the Mac step', async () => {
    await dictationApi.connect('My Mac')
    renderApp('/today')
    await screen.findByTestId('today-start')
    await waitFor(() => expect(step('mac')?.dataset.done).toBe('true'))
    expect(screen.getByTestId('today-start-count')).toHaveTextContent('2 of 3')
  })

  it('T1: inside the Mac app the Mac step is already done', async () => {
    ;(window as { webkit?: unknown }).webkit = {
      messageHandlers: { hearthSignIn: { postMessage: () => {} } },
    }
    try {
      renderApp('/today')
      await screen.findByTestId('today-start')
      expect(step('mac')?.dataset.done).toBe('true')
    } finally {
      delete (window as { webkit?: unknown }).webkit
    }
  })

  it('T1: a server with no Mac build has two steps', async () => {
    server.use(http.head('/downloads/Hotsauce.dmg', () => new HttpResponse(null, { status: 404 })))
    renderApp('/today')
    await screen.findByTestId('today-start')
    await waitFor(() => expect(step('mac')).toBeUndefined())
    expect(screen.getByTestId('today-start-count')).toHaveTextContent('1 of 2')
    expect(screen.getByTestId('today-start')).toHaveTextContent('Two things')
  })

  it('T1: on a phone the second step is the Home Screen', async () => {
    pretend({ ua: IPHONE, touch: 5, queries: [TOUCH_QUERY] })
    renderApp('/today')
    await screen.findByTestId('today-start')
    expect(step('mac')).toBeUndefined()
    expect(step('home')?.dataset.done).toBe('false')
    expect(screen.getByTestId('today-start-home')).toHaveAttribute('href', '/settings/apps')
  })

  it('T2: Open Docs records the step and opens Docs', async () => {
    const saves = watchSaves()
    const { router } = renderApp('/today')
    await userEvent.click(await screen.findByTestId('today-start-docs'))
    await waitFor(() => expect(router.state.location.pathname.startsWith('/docs')).toBe(true))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.columns[0][0]).toEqual({ id: 'start', kind: 'start', openedDocs: true })
  })

  it('T3/T5: Hide removes it at once and saves; the Mac app card takes over', async () => {
    const saves = watchSaves()
    renderApp('/today')
    await screen.findByTestId('today-start')
    expect(screen.queryByTestId('today-mac-app')).toBeNull()
    await userEvent.click(screen.getByTestId('today-start-hide'))
    expect(screen.queryByTestId('today-start')).toBeNull()
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(kinds(saves[0] as TodayLayout)).not.toContain('start')
    expect(await screen.findByTestId('today-mac-app')).toBeInTheDocument()
  })

  it('T4: with every step done it says so, stays for this visit, and is saved away once', async () => {
    await dictationApi.connect('My Mac')
    const offered = offerGettingStarted(defaultTodayLayout())
    const done = updateTile(offered, { id: 'start', kind: 'start', openedDocs: true })
    server.use(
      http.get('/api/today/layout', () => HttpResponse.json({ layout: done, saved: true })),
    )
    const saves = watchSaves()
    renderApp('/today')
    expect(await screen.findByTestId('today-start-finished')).toHaveTextContent('You’re set')
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(kinds(saves[0] as TodayLayout)).not.toContain('start')
    await new Promise((r) => setTimeout(r, 50))
    expect(saves).toHaveLength(1)
    expect(screen.getByTestId('today-start')).toBeInTheDocument()
  })

  it('is one of the tiles Add tile offers once hidden', async () => {
    renderApp('/today')
    await userEvent.click(await screen.findByTestId('today-start-hide'))
    await userEvent.click(screen.getByTestId('today-edit'))
    await userEvent.click(screen.getByTestId('today-add-tile'))
    expect(screen.getByTestId('today-add-start')).toHaveTextContent('Getting started')
  })
})

describe('Getting started: replay from Settings (R1, R2)', () => {
  it('R1: the help strip under the Settings menu links to it', async () => {
    renderApp('/settings')
    expect(await screen.findByTestId('settings-getting-started')).toHaveAttribute(
      'href',
      '/today?start=1',
    )
  })

  it('R2: /today?start=1 puts a fresh tile back at the top, saves it, and cleans the address', async () => {
    server.use(
      http.get('/api/today/layout', () =>
        HttpResponse.json({
          layout: { ...defaultTodayLayout(), gettingStarted: 'dismissed' },
          saved: true,
        }),
      ),
    )
    const saves = watchSaves()
    const { router } = renderApp('/today?start=1')
    const tile = await screen.findByTestId('today-start')
    expect(screen.getByTestId('today-column-0').firstElementChild?.contains(tile)).toBe(true)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.columns[0][0]).toEqual({ id: 'start', kind: 'start' })
    await waitFor(() => expect(router.state.location.search).toBe(''))
  })

  it('R2: with the tile already showing, replay changes nothing', async () => {
    const saves = watchSaves()
    const { router } = renderApp('/today?start=1')
    await screen.findByTestId('today-start')
    await waitFor(() => expect(router.state.location.search).toBe(''))
    expect(saves).toHaveLength(0)
  })
})
