import { act, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import { reportReachable, reportUnreachable, resetConnectionForTests } from '../lib/connection'
import { saveDraft } from '../lib/drafts'
import { rememberMember } from '../lib/offlineStart'
import { mockApi, server } from '../test/mockServer'
import { renderApp } from '../test/renderApp'

/** No answers from the server at all, as when the network is gone. */
function goOffline() {
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
    goOffline()
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
    saveDraft('team', 'docs/plans/q4-plan.md', 'abc', 'Kept text', { waiting: true })
    goOffline()
    await act(() => router.navigate('/tasks'))
    const empty = await screen.findByTestId('offline-empty')
    expect(empty).toHaveTextContent('Not available offline yet')
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
    goOffline()
    expect(screen.queryByTestId('offline-empty')).toBeNull()
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
      expect(screen.getByTestId('account-menu').getAttribute('aria-label') ?? '').toMatch(/grace@example\.test/),
    )
  })
})
