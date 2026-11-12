import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import { localDay } from '../../api/today'
import { server } from '../../test/mockServer'
import { renderApp } from '../../test/renderApp'

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
