import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it } from 'vitest'
import { server } from '../../../test/mockServer'
import { renderApp } from '../../../test/renderApp'
import BookPage, { startOfLocalWeek } from './BookPage'

// Booking links (ARCHITECTURE §19.4): the member's page in Meetings and the public page.

const WEEKDAY: Array<[string, string]> = [['00:00', '23:45']]
const everyDay = {
  sun: WEEKDAY,
  mon: WEEKDAY,
  tue: WEEKDAY,
  wed: WEEKDAY,
  thu: WEEKDAY,
  fri: WEEKDAY,
  sat: WEEKDAY,
}

describe('Booking links', () => {
  it('makes a link from Meetings and shows its public address', async () => {
    renderApp('/meetings/booking')
    await userEvent.click(await screen.findByTestId('booking-new'))
    await userEvent.type(screen.getByTestId('booking-title'), 'Intro call')
    expect(screen.getByTestId('booking-slug')).toHaveValue('intro-call')
    await userEvent.click(screen.getByTestId('booking-add-question'))
    await userEvent.type(screen.getByTestId('booking-question'), 'What about?')
    await userEvent.click(screen.getByTestId('booking-save'))
    const card = await screen.findByTestId('booking-link')
    expect(card).toHaveAttribute('data-slug', 'intro-call')
    expect(within(card).getByTestId('booking-url')).toHaveTextContent('/book/ada/intro-call')
    expect(within(card).getByText(/30 min · Mon, Tue, Wed, Thu, Fri/)).toBeInTheDocument()
  })

  it('S7: without calendar write access it shows how to turn links on', async () => {
    server.use(
      http.get('/api/booking', () =>
        HttpResponse.json({
          ready: false,
          missing: 'scope',
          canTakeBookings: true,
          handle: 'ada',
          links: [],
        }),
      ),
    )
    renderApp('/meetings/booking')
    expect(await screen.findByTestId('booking-turn-on')).toHaveTextContent('Turn on booking links')
    expect(screen.queryByTestId('booking-new')).not.toBeInTheDocument()
  })
})

describe('the public booking page', () => {
  async function withLink() {
    const res = await fetch('/api/booking/chat', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Quick chat',
        minutes: 30,
        tz: 'UTC',
        hours: everyDay,
        bufferBefore: 0,
        bufferAfter: 0,
        noticeMinutes: 0,
        horizonDays: 30,
        dailyCap: null,
        questions: ['Anything to prepare?'],
        description: 'Say hi.',
        active: true,
        blobOid: null,
      }),
    })
    expect(res.ok).toBe(true)
    const router = createMemoryRouter([{ path: '/book/:handle/:slug', element: <BookPage /> }], {
      initialEntries: ['/book/ada/chat'],
    })
    render(<RouterProvider router={router} />)
  }

  it('picks a time, books it, and then the time is gone', async () => {
    await withLink()
    expect(await screen.findByTestId('book-title')).toHaveTextContent('Quick chat')
    const first = (await screen.findAllByTestId('book-time'))[0]
    const start = first?.dataset.start
    if (!first || !start) throw new Error('no open times')
    await userEvent.click(first)
    await userEvent.type(screen.getByTestId('book-name'), 'Jo Park')
    await userEvent.type(screen.getByTestId('book-email'), 'jo@bolt.example')
    await userEvent.type(screen.getByTestId('book-answer'), 'Nothing')
    await userEvent.click(screen.getByTestId('book-submit'))
    expect(await screen.findByTestId('book-done')).toHaveTextContent('You’re booked')
    const page = await (await fetch('/api/book/ada/chat')).json()
    expect(page.slots.map((s: { start: string }) => s.start)).not.toContain(start)
  })

  it('S4: a time taken meanwhile sends the booker back to pick another', async () => {
    await withLink()
    const first = (await screen.findAllByTestId('book-time'))[0]
    const start = first?.dataset.start
    if (!first || !start) throw new Error('no open times')
    await userEvent.click(first)
    // Someone else books it first.
    await fetch('/api/book/ada/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ start, name: 'X', email: 'x@y.test', answers: [], token: 'dev-pass' }),
    })
    await userEvent.type(screen.getByTestId('book-name'), 'Jo Park')
    await userEvent.type(screen.getByTestId('book-email'), 'jo@bolt.example')
    await userEvent.click(screen.getByTestId('book-submit'))
    expect(await screen.findByTestId('book-notice')).toHaveTextContent('That time was just taken')
    await waitFor(() =>
      expect(screen.getAllByTestId('book-time').map((b) => b.dataset.start)).not.toContain(start),
    )
  })

  it('W6: weeks run Monday to Sunday', async () => {
    await withLink()
    const week = await screen.findByTestId('book-week')
    const start = new Date(`${week.dataset.start}T12:00:00`)
    expect(start.getDay()).toBe(1)
    const monday = startOfLocalWeek(Date.now())
    // This week, or next week when nothing is left in this one.
    expect(
      [monday, monday + 7 * 86_400_000].map((ms) => new Date(ms).toLocaleDateString('en-CA')),
    ).toContain(week.dataset.start)
    if (week.dataset.start === new Date(monday).toLocaleDateString('en-CA'))
      expect(screen.getByRole('button', { name: 'Earlier week' })).toBeDisabled()
    expect(startOfLocalWeek(new Date(2026, 10, 15, 20).getTime())).toBe(
      new Date(2026, 10, 9).getTime(),
    )
    expect(startOfLocalWeek(new Date(2026, 10, 9, 0, 30).getTime())).toBe(
      new Date(2026, 10, 9).getTime(),
    )
  })

  it('a missing link says so', async () => {
    const router = createMemoryRouter([{ path: '/book/:handle/:slug', element: <BookPage /> }], {
      initialEntries: ['/book/ada/nope'],
    })
    render(<RouterProvider router={router} />)
    expect(await screen.findByText('This booking link doesn’t exist')).toBeInTheDocument()
  })
})
