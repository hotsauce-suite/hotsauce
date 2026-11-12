import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { meetingsApi } from '../../api/meetings'
import { mockApi, server } from '../../test/mockServer'
import { renderApp } from '../../test/renderApp'
import { AudioRing } from './audio/ring-buffer'
import { beginLive, currentLive, notesDraftKey } from './live/controller'

afterEach(async () => {
  await currentLive()?.dispose()
})

describe('Meetings home', () => {
  it('shows the calendar with Take notes, then the meetings grouped by day', async () => {
    renderApp('/meetings')
    expect(await screen.findByTestId('meetings-home')).toBeInTheDocument()

    const events = await screen.findAllByTestId('calendar-event')
    expect(events.map((e) => e.dataset.eventId)).toEqual(['evt-acme-sync', 'evt-weekly-planning'])
    const acme = events[0] as HTMLElement
    expect(within(acme).getByText('In 1 min')).toBeInTheDocument()
    expect(within(acme).getByTestId('take-notes')).toHaveAttribute(
      'href',
      '/meetings/start?event=evt-acme-sync',
    )
    expect(screen.getByTestId('new-meeting')).toHaveAttribute('href', '/meetings/start')

    const list = screen.getByTestId('meeting-list')
    await waitFor(() => expect(within(list).getAllByTestId('meeting-item')).toHaveLength(3))
    const titles = within(list)
      .getAllByTestId('meeting-item')
      .map((el) => el.querySelector('.font-medium')?.textContent)
    // Newest first: yesterday's two, then the team's from two days ago.
    expect(titles).toEqual(['Priya 1:1', 'Acme kickoff', 'Pilot debrief'])
    expect(within(list).getByText('Yesterday')).toBeInTheDocument()
    const first = within(list).getAllByTestId('meeting-item')[0] as HTMLElement
    expect(first.dataset.path).toMatch(/^meetings\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}-priya-1-1\.md$/)
    expect(first).toHaveAttribute('href', `/meetings/ada/${first.dataset.path}`)
  })

  it('filters the list by company through the API', async () => {
    renderApp('/meetings')
    const list = await screen.findByTestId('meeting-list')
    await waitFor(() => expect(within(list).getAllByTestId('meeting-item')).toHaveLength(3))
    await userEvent.selectOptions(screen.getByLabelText('Company'), 'acme.com')
    await waitFor(() => expect(within(list).getAllByTestId('meeting-item')).toHaveLength(1))
    expect(within(list).getByText('Acme kickoff')).toBeInTheDocument()
  })
})

describe('unsaved meetings on Home', () => {
  it('lists the member’s unsaved meetings above the calendar, newest first, with Resume and Stop', async () => {
    const api = mockApi()
    const standup = await meetingsApi.createSession({ title: 'Morning standup' })
    const followUp = await meetingsApi.createSession({ title: 'Acme follow-up' })
    await meetingsApi.pause(followUp.id)
    const done = await meetingsApi.createSession({ title: 'Already saved' })
    await meetingsApi.stop(done.id)
    const halfSaved = await meetingsApi.createSession({ title: 'Save failed' })
    api.meetings.failStop = true
    await expect(meetingsApi.stop(halfSaved.id)).rejects.toThrow()
    api.meetings.failStop = false

    renderApp('/meetings')
    await waitFor(() => expect(screen.getAllByTestId('open-session')).toHaveLength(3))
    const rows = screen.getAllByTestId('open-session')
    expect(rows.map((r) => r.dataset.sessionId)).toEqual([halfSaved.id, followUp.id, standup.id])
    const [stopped, paused, recording] = rows as [HTMLElement, HTMLElement, HTMLElement]
    expect(stopped).toHaveTextContent('Save failed')
    expect(stopped).toHaveTextContent('Stopped')
    expect(paused).toHaveTextContent('Acme follow-up')
    expect(paused).toHaveTextContent('Paused')
    expect(recording).toHaveTextContent('Recording')
    expect(within(recording).getByTestId('open-session-resume')).toHaveAttribute(
      'href',
      `/meetings/live/${standup.id}`,
    )
    // Above the calendar.
    const calendar = (await screen.findAllByTestId('calendar-event'))[0] as HTMLElement
    expect(recording.compareDocumentPosition(calendar) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })

  it('Stop saves the meeting with this device’s notes and opens the note', async () => {
    const session = await meetingsApi.createSession({ title: 'Left running' })
    localStorage.setItem(notesDraftKey(session.id), 'typed before the tab closed')
    const { router } = renderApp('/meetings')
    const row = await screen.findByTestId('open-session')
    await userEvent.click(within(row).getByTestId('open-session-stop'))
    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/^\/meetings\/ada\/meetings\/.+\.md$/),
    )
    const api = mockApi()
    expect(api.meetings.sessions.get(session.id)?.state).toBe('saved')
    expect(api.repo.space('ada').files.get(`.hearth/meetings/raw/${session.id}.md`)).toBe(
      'typed before the tab closed',
    )
  })

  it('shows nothing, and no error, when the server can’t list sessions', async () => {
    await meetingsApi.createSession({ title: 'Invisible' })
    server.use(
      http.get('/api/meetings/sessions', () =>
        HttpResponse.json(
          { error: { code: 'not_found', message: 'No such API route' } },
          { status: 404 },
        ),
      ),
    )
    renderApp('/meetings')
    await screen.findAllByTestId('calendar-event')
    await waitFor(() => expect(screen.getAllByTestId('meeting-item')).toHaveLength(3))
    expect(screen.queryByTestId('open-session')).toBeNull()
    expect(screen.queryByText(/No such API route/)).toBeNull()
  })
})

describe('the app switch', () => {
  it('moves between Docs and Meetings in one click and returns to where each was', async () => {
    const { router } = renderApp('/docs/team/docs/welcome.md')
    expect(await screen.findByTestId('editor')).toBeInTheDocument()
    expect(screen.getByTestId('app-switch-docs')).toHaveAttribute('aria-current', 'page')

    await userEvent.click(screen.getByTestId('app-switch-meetings'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/meetings'))
    expect(await screen.findByTestId('meetings-home')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Meetings' })).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('app-switch-docs'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/docs/team/docs/welcome.md'))
    // The same sidebar frame throughout: one aside, its body swapped.
    expect(screen.getAllByTestId('sidebar')).toHaveLength(1)
  })

  it('shows one recording indicator on other pages while a meeting is live', async () => {
    const session = await meetingsApi.createSession({ title: 'Acme sync' })
    beginLive(session, { ring: new AudioRing({ factory: null }) })
    const { router } = renderApp('/docs')
    const strip = await screen.findByTestId('recording-indicator')
    expect(strip).toHaveAttribute('href', `/meetings/live/${session.id}`)
    expect(strip).toHaveTextContent('Acme sync')
    await waitFor(() => expect(document.title).toBe('● Recording · Acme sync'))

    await userEvent.click(strip)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/meetings/live/${session.id}`))
    // On the live page the indicator sits in its header instead.
    await screen.findByTestId('live-notepad')
    expect(screen.getAllByTestId('recording-indicator')).toHaveLength(1)
  })
})

describe('open action items on Home', () => {
  const items = [
    {
      space: 'ada',
      path: 'meetings/2026/11/2026-11-08-acme-kickoff.md',
      title: 'Acme kickoff',
      date: '2026-11-08T10:00:00Z',
      items: [
        { line: 12, text: 'Ada: send the pilot scope' },
        { line: 13, text: 'Dana: share the data sheet' },
      ],
    },
  ]

  it('lists each open item with a link to its line, and ticks one off', async () => {
    const ticked: unknown[] = []
    server.use(
      http.get('/api/meetings/action-items', () => HttpResponse.json(items)),
      http.post('/api/meetings/action-items/done', async ({ request }) => {
        ticked.push(await request.json())
        return HttpResponse.json({ ok: true })
      }),
    )
    renderApp('/meetings')
    const section = await screen.findByTestId('action-items')
    const rows = within(section).getAllByTestId('action-item')
    expect(rows.map((r) => r.querySelector('span span')?.textContent)).toEqual([
      'Ada: send the pilot scope',
      'Dana: share the data sheet',
    ])
    expect(
      within(rows[0] as HTMLElement).getByRole('link', { name: 'Acme kickoff' }),
    ).toHaveAttribute('href', `/meetings/ada/${items[0]?.path}#L12`)

    await userEvent.click(screen.getByLabelText('Mark done: Ada: send the pilot scope'))
    await waitFor(() => expect(within(section).getAllByTestId('action-item')).toHaveLength(1))
    expect(ticked).toEqual([
      { space: 'ada', path: items[0]?.path, line: 12, text: 'Ada: send the pilot scope' },
    ])
  })

  it('puts the item back and says why when the tick fails', async () => {
    server.use(
      http.get('/api/meetings/action-items', () => HttpResponse.json(items)),
      http.post('/api/meetings/action-items/done', () =>
        HttpResponse.json(
          {
            error: {
              code: 'conflict',
              message: 'That action item changed; reload to see the latest',
            },
          },
          { status: 409 },
        ),
      ),
    )
    renderApp('/meetings')
    await screen.findByTestId('action-items')
    await userEvent.click(screen.getByLabelText('Mark done: Dana: share the data sheet'))
    expect(await screen.findByRole('alert')).toHaveTextContent('That action item changed')
    expect(screen.getAllByTestId('action-item')).toHaveLength(2)
  })

  it('stays hidden when there are none', async () => {
    renderApp('/meetings')
    await screen.findByTestId('meeting-list')
    expect(screen.queryByTestId('action-items')).not.toBeInTheDocument()
  })
})

describe('calendar errors on Home', () => {
  it('says why the calendar was refused, and that a meeting can still start', async () => {
    server.use(
      http.get('/api/calendar/upcoming', () =>
        HttpResponse.json(
          {
            error: {
              code: 'forbidden',
              message:
                'Google Calendar refused access. Sign in with Google again and allow calendar access.',
            },
          },
          { status: 403 },
        ),
      ),
    )
    renderApp('/meetings')
    expect(await screen.findByTestId('calendar-failed')).toHaveTextContent(
      'Google Calendar refused access. Sign in with Google again and allow calendar access. You can still start a meeting yourself.',
    )
  })

  it('falls back to a plain message when the calendar fails otherwise', async () => {
    server.use(http.get('/api/calendar/upcoming', () => HttpResponse.error()))
    renderApp('/meetings')
    expect(await screen.findByTestId('calendar-failed')).toHaveTextContent(
      'Your calendar didn’t load. You can still start a meeting yourself.',
    )
  })
})

describe('calendar sync on Home', () => {
  it('asks the server to sync once on open, then reloads the calendar', async () => {
    const calls: string[] = []
    const onRequest = ({ request }: { request: Request }) => {
      const { pathname } = new URL(request.url)
      if (pathname.startsWith('/api/calendar/')) calls.push(`${request.method} ${pathname}`)
    }
    server.events.on('request:start', onRequest)
    try {
      renderApp('/meetings')
      // Generous waits: on a loaded machine the third request can take over a second.
      await screen.findAllByTestId('calendar-event', {}, { timeout: 5000 })
      await screen.findByTestId('coverage', {}, { timeout: 5000 })
      await waitFor(
        () => expect(calls.filter((c) => c === 'GET /api/calendar/upcoming')).toHaveLength(2),
        { timeout: 5000 },
      )
      expect(calls.filter((c) => c === 'POST /api/calendar/refresh')).toHaveLength(1)
      // The second read of upcoming comes after the refresh.
      expect(calls.lastIndexOf('GET /api/calendar/upcoming')).toBeGreaterThan(
        calls.indexOf('POST /api/calendar/refresh'),
      )
    } finally {
      server.events.removeListener('request:start', onRequest)
    }
  })

  it('lists recent meetings newest first, linking the ones with notes', async () => {
    renderApp('/meetings')
    const coverage = await screen.findByTestId('coverage')
    const rows = within(coverage).getAllByTestId('coverage-item')
    expect(rows.map((r) => [r.dataset.eventId, r.dataset.hasNotes])).toEqual([
      ['evt-acme-kickoff', 'true'],
      ['evt-bolt-intro', 'false'],
    ])
    const [kickoff, bolt] = rows as [HTMLElement, HTMLElement]
    expect(kickoff).toHaveTextContent('Acme kickoff')
    expect(kickoff).toHaveTextContent('Dana Lee')
    const link = within(kickoff).getByTestId('coverage-note-link')
    expect(link).toHaveTextContent('Notes')
    expect(link.getAttribute('href')).toMatch(
      /^\/meetings\/ada\/meetings\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}-acme-kickoff\.md$/,
    )
    expect(bolt).toHaveTextContent('Intro call with Bolt')
    expect(bolt).toHaveTextContent('No notes')
    expect(within(bolt).queryByTestId('coverage-note-link')).toBeNull()
  })

  it('stays quiet while Google answers', async () => {
    renderApp('/meetings')
    await screen.findByTestId('coverage')
    expect(screen.queryByTestId('calendar-status')).toBeNull()
  })

  it('says when the calendar shown is from before a failed sync', async () => {
    const api = mockApi()
    api.meetings.calendarStatus = {
      lastSyncedAt: new Date().toISOString(),
      error: 'Google Calendar returned 503',
    }
    renderApp('/meetings')
    const line = await screen.findByTestId('calendar-status')
    expect(line).toHaveTextContent(/^Calendar last updated \d{1,2}:\d{2}/)
    expect(line).toHaveTextContent('Google didn’t answer: Google Calendar returned 503')
    // The cached events are still there.
    expect(screen.getAllByTestId('calendar-event')).toHaveLength(2)
    expect(screen.queryByTestId('calendar-failed')).toBeNull()
  })

  it('shows only the failure when the calendar itself didn’t load', async () => {
    mockApi().meetings.calendarStatus = { lastSyncedAt: null, error: 'Google is down' }
    server.use(http.get('/api/calendar/upcoming', () => HttpResponse.error()))
    renderApp('/meetings')
    await screen.findByTestId('calendar-failed')
    await screen.findByTestId('coverage')
    expect(screen.queryByTestId('calendar-status')).toBeNull()
  })

  it('hides Recent meetings when the server can’t say', async () => {
    server.use(http.get('/api/calendar/coverage', () => HttpResponse.error()))
    renderApp('/meetings')
    await waitFor(() => expect(screen.getAllByTestId('meeting-item')).toHaveLength(3))
    expect(screen.queryByTestId('coverage')).toBeNull()
  })
})
