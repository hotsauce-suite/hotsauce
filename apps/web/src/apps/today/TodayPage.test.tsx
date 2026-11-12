import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { dictationApi } from '../../api/dictation'
import { localDay } from '../../api/today'
import { TOUCH_QUERY } from '../../hooks/useMediaQuery'
import { server } from '../../test/mockServer'
import { renderApp } from '../../test/renderApp'
import { MAC_APP_CARD_DISMISSED } from './TodayPage'

describe('Today', () => {
  it('T1: / opens Today, with the day’s meetings and Take notes', async () => {
    const { router } = renderApp('/')
    await waitFor(() => expect(router.state.location.pathname).toBe('/today'))
    const meetings = await screen.findAllByTestId('today-meeting')
    expect(meetings[0]?.dataset.eventId).toBe('evt-acme-sync')
    expect(within(meetings[0] as HTMLElement).getByTestId('today-take-notes')).toHaveAttribute(
      'href',
      '/meetings/start?event=evt-acme-sync',
    )
    expect(screen.getByTestId('app-switch-today')).toHaveAttribute('aria-current', 'page')
  })

  it('T4: a task added on Today is due today, and completing it takes it off', async () => {
    renderApp('/today')
    const add = await screen.findByTestId('today-quick-add')
    await userEvent.type(add, 'Water the plants{Enter}')
    const card = screen.getByTestId('today-tasks')
    const row = await within(card).findByText('Water the plants')
    const line = row.closest('[data-testid="today-task"]') as HTMLElement
    await userEvent.click(within(line).getByTestId('today-task-done'))
    await waitFor(() => expect(within(card).queryByText('Water the plants')).toBeNull())
  })

  it('T6: without the calendar it says why, and the rest still loads', async () => {
    server.use(
      http.get('/api/calendar/upcoming', () =>
        HttpResponse.json(
          { error: { code: 'forbidden', message: 'Connect your Google Calendar first.' } },
          { status: 403 },
        ),
      ),
    )
    renderApp('/today')
    expect(await screen.findByTestId('today-calendar-error')).toHaveTextContent(
      'Connect your Google Calendar first.',
    )
    expect(screen.getByTestId('today-tasks')).toBeInTheDocument()
    expect(screen.getByTestId('today-docs')).toBeInTheDocument()
  })

  it('asks for the member’s own day', () => {
    const d = localDay(new Date(2026, 10, 12, 23, 30))
    expect(d.date).toBe('2026-11-12')
    expect(Date.parse(d.to) - Date.parse(d.from)).toBeGreaterThanOrEqual(23 * 3_600_000)
  })
})

describe('Today: the Mac app card', () => {
  afterEach(() => {
    delete (window as { webkit?: unknown }).webkit
  })

  it('links to the download in Settings, and stays closed once closed', async () => {
    const user = userEvent.setup()
    renderApp('/today')
    const card = await screen.findByTestId('today-mac-app')
    expect(within(card).getByTestId('today-mac-app-link')).toHaveAttribute(
      'href',
      '/settings#mac-app',
    )
    await user.click(within(card).getByTestId('today-mac-app-dismiss'))
    expect(screen.queryByTestId('today-mac-app')).toBeNull()
    expect(localStorage.getItem(MAC_APP_CARD_DISMISSED)).toBe('1')
  })

  it('is not shown once closed in this browser', async () => {
    localStorage.setItem(MAC_APP_CARD_DISMISSED, '1')
    renderApp('/today')
    await screen.findByTestId('today-tasks')
    expect(screen.queryByTestId('today-mac-app')).toBeNull()
  })

  it('is not shown once a Mac is connected', async () => {
    let answered = false
    server.events.on('response:mocked', ({ request }) => {
      if (new URL(request.url).pathname === '/api/dictation/devices') answered = true
    })
    await dictationApi.connect('My Mac')
    renderApp('/today')
    await screen.findByTestId('today-tasks')
    await waitFor(() => expect(answered).toBe(true))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByTestId('today-mac-app')).toBeNull()
    server.events.removeAllListeners()
  })

  it('is not shown on a phone, and asks nothing', async () => {
    const real = window.matchMedia
    window.matchMedia = ((query: string) => ({
      ...real(query),
      matches: query === TOUCH_QUERY,
      media: query,
    })) as typeof window.matchMedia
    const asked: string[] = []
    server.events.on('request:start', ({ request }) => {
      asked.push(new URL(request.url).pathname)
    })
    try {
      renderApp('/today')
      await screen.findByTestId('today-tasks')
      expect(screen.queryByTestId('today-mac-app')).toBeNull()
      expect(asked).not.toContain('/downloads/Hotsauce.dmg')
      expect(asked).not.toContain('/api/dictation/devices')
    } finally {
      window.matchMedia = real
      server.events.removeAllListeners()
    }
  })

  it('is not shown inside the Mac app’s own window', async () => {
    ;(window as { webkit?: unknown }).webkit = {
      messageHandlers: { hearthSignIn: { postMessage: () => {} } },
    }
    const asked: string[] = []
    server.events.on('request:start', ({ request }) => {
      asked.push(new URL(request.url).pathname)
    })
    renderApp('/today')
    await screen.findByTestId('today-tasks')
    expect(screen.queryByTestId('today-mac-app')).toBeNull()
    expect(asked).not.toContain('/downloads/Hotsauce.dmg')
    server.events.removeAllListeners()
  })

  it('is not shown on a server without a Mac app build', async () => {
    let answered = false
    server.use(
      http.head('/downloads/Hotsauce.dmg', () => {
        answered = true
        return new HttpResponse(null, { status: 404 })
      }),
    )
    renderApp('/today')
    await screen.findByTestId('today-tasks')
    await waitFor(() => expect(answered).toBe(true))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByTestId('today-mac-app')).toBeNull()
  })
})
