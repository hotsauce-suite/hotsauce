import { act, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import { api } from '../api/client'
import { reportReachable, reportUnreachable, resetConnectionForTests } from '../lib/connection'
import { saveDraft } from '../lib/drafts'
import { rememberMember } from '../lib/offlineStart'
import { mockApi, server } from '../test/mockServer'
import { renderApp } from '../test/renderApp'

// Requests the app has sent and not yet had answered. An answer that lands after the network
// "goes" would bring the app back online, as it should, so each test cuts it once things are quiet.
const inFlight = new Set<string>()
server.events.on('request:start', ({ requestId }) => inFlight.add(requestId))
server.events.on('request:end', ({ requestId }) => inFlight.delete(requestId))
// A request no handler answers has no end event (it fails at once).
server.events.on('request:unhandled', ({ requestId }) => inFlight.delete(requestId))

async function quiet(): Promise<void> {
  await waitFor(() => expect(inFlight.size).toBe(0))
  // The last answers reach the app's code a tick after the mock sends them.
  await act(() => new Promise((r) => setTimeout(r, 0)))
}

/** No answers from the server at all, as when the network is gone. */
async function goOffline() {
  await quiet()
  server.use(http.all('*', () => HttpResponse.error()))
  resetConnectionForTests(async () => false)
  act(() => reportUnreachable())
}

function backOnline() {
  server.resetHandlers(...mockApi().handlers)
  act(() => reportReachable())
}

// Opening Tasks the first time transforms its page, which can outlast the default 5 s.
describe('offline in the app (A3)', { timeout: 20_000 }, () => {
  it('shows the Offline bar and greys out what needs the server (A3.2, A3.3)', async () => {
    renderApp('/docs')
    const ask = await screen.findByTestId('assistant-open')
    expect(screen.queryByTestId('offline-bar')).toBeNull()
    expect(ask).toBeEnabled()
    await goOffline()
    expect(screen.getByTestId('offline-bar')).toHaveTextContent('Offline')
    expect(ask).toBeDisabled()
    expect(ask).toHaveAttribute('title', 'Needs a connection')
    backOnline()
    expect(screen.queryByTestId('offline-bar')).toBeNull()
    expect(ask).toBeEnabled()
  })

  it('a screen opened offline says "Not available offline yet", with docs kept here (A3.4)', async () => {
    const { router } = renderApp('/docs')
    await screen.findByTestId('assistant-open')
    const me = (await api.me()).principal.userId
    // The shell has learned who's signed in (what an offline screen lists drafts for).
    await waitFor(() => expect(localStorage.getItem('hotsauce.offline.member')).toContain(me))
    await goOffline()
    // Kept once offline, as an edit made offline is: while the app can still reach the server it
    // sends a waiting save itself, which took this one before the screen opened on a slow run.
    saveDraft(me, 'team', 'docs/plans/q4-plan.md', 'abc', 'Kept text', 'waiting')
    saveDraft('u-other', 'team', 'docs/other.md', 'abc', 'Not mine', 'waiting')
    await act(() => router.navigate('/tasks'))
    const empty = await screen.findByTestId('offline-empty')
    expect(empty).toHaveTextContent('Not available offline yet')
    expect(screen.queryByRole('link', { name: 'other' })).toBeNull()
    expect(screen.getByRole('link', { name: 'q4-plan' })).toHaveAttribute(
      'href',
      '/docs/team/docs/plans/q4-plan.md',
    )
    // Back online, the screen opens as usual.
    backOnline()
    await waitFor(() => expect(screen.queryByTestId('offline-empty')).toBeNull())
  })

  it('a screen already open when the connection drops keeps what it shows', async () => {
    const { router } = renderApp('/docs')
    await screen.findByTestId('assistant-open')
    await act(() => router.navigate('/tasks'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'))
    await goOffline()
    expect(screen.queryByTestId('offline-empty')).toBeNull()
  })

  it('an error answer from /api/me never shows the remembered member', async () => {
    rememberMember(
      {
        userId: 'u9',
        email: 'grace@example.test',
        name: 'Grace Hopper',
        handle: 'grace',
        isAdmin: false,
      },
      'Acme',
    )
    server.use(
      http.get('/api/me', () =>
        HttpResponse.json({ error: { code: 'internal', message: 'busy' } }, { status: 500 }),
      ),
    )
    renderApp('/docs')
    const account = await screen.findByTestId('account-menu')
    await new Promise((r) => setTimeout(r, 200))
    expect(account.getAttribute('aria-label')).not.toMatch(/grace@/)
  })

  it('the shell still knows who you are when /api/me can’t be reached', async () => {
    rememberMember(
      {
        userId: 'u9',
        email: 'grace@example.test',
        name: 'Grace Hopper',
        handle: 'grace',
        isAdmin: false,
      },
      'Acme',
    )
    server.use(http.get('/api/me', () => HttpResponse.error()))
    renderApp('/docs')
    await waitFor(() =>
      expect(screen.getByTestId('account-menu').getAttribute('aria-label') ?? '').toMatch(
        /grace@example\.test/,
      ),
    )
  })
})
