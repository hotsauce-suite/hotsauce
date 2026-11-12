import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthState } from '../auth/AuthContext'
import { product } from '../brand/product'
import { server, TEST_USER } from '../test/mockServer'
import DesktopConnectRoute from './DesktopConnectRoute'
import DesktopFinishRoute from './DesktopFinishRoute'

const STATE = 'Abc_123-'.repeat(5)

function renderAt(path: string, auth: Partial<AuthState>) {
  const value = { mode: 'dev', status: 'signed-in', signOut: () => {}, ...auth } as AuthState
  const router = createMemoryRouter(
    [
      { path: '/desktop/connect', element: <DesktopConnectRoute /> },
      { path: '/desktop/finish', element: <DesktopFinishRoute /> },
      { path: '/sign-in', element: <p>sign-in page</p> },
      { path: '/today', element: <p>today home</p> },
    ],
    { initialEntries: [path] },
  )
  render(
    <AuthContext.Provider value={value}>
      <RouterProvider router={router} />
    </AuthContext.Provider>,
  )
  return router
}

describe('/desktop/connect', () => {
  it('asks first, then hands a one-time ticket back to the app', async () => {
    let asked = 0
    server.use(
      http.post('/api/desktop/ticket', () => {
        asked += 1
        return HttpResponse.json({ ticket: 'tkt_1' })
      }),
    )
    const user = userEvent.setup()
    renderAt(`/desktop/connect?state=${STATE}`, {})
    expect(await screen.findByText(TEST_USER)).toBeInTheDocument()
    // Nothing is minted until the member confirms.
    expect(asked).toBe(0)
    await user.click(screen.getByRole('button', { name: 'Sign in to the Mac app' }))
    const open = await screen.findByRole('link', { name: `Open ${product()}` })
    expect(open).toHaveAttribute('href', `hearth://auth/callback?state=${STATE}&ticket=tkt_1`)
    expect(asked).toBe(1)
  })

  it('sends a signed-out member to sign in, then back here', async () => {
    const router = renderAt(`/desktop/connect?state=${STATE}`, { status: 'signed-out' })
    expect(await screen.findByText('sign-in page')).toBeInTheDocument()
    expect(router.state.location.state).toEqual({ from: `/desktop/connect?state=${STATE}` })
  })

  it('refuses a link without the app’s state', async () => {
    renderAt('/desktop/connect?state=short', {})
    expect(await screen.findByText(/didn’t come from the app/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('/desktop/finish', () => {
  afterEach(() => {
    delete (window as { webkit?: unknown }).webkit
  })

  const appHands = (ticket: string | null) =>
    Object.assign(window, {
      webkit: { messageHandlers: { hearthTicket: { postMessage: async () => ticket } } },
    })

  it('signs in with the ticket the app hands over and opens Today', async () => {
    appHands('tkt_9')
    const signInWithTicket = vi.fn(async () => {})
    renderAt('/desktop/finish', { status: 'signed-out', signInWithTicket })
    await waitFor(() => expect(signInWithTicket).toHaveBeenCalledWith('tkt_9'))
    expect(await screen.findByText('today home')).toBeInTheDocument()
  })

  it('ignores a ticket in the address: only the app can supply one', async () => {
    window.history.replaceState(null, '', '/desktop/finish#ticket=attacker')
    const signInWithTicket = vi.fn(async () => {})
    renderAt('/desktop/finish#ticket=attacker', { status: 'signed-out', signInWithTicket })
    expect(await screen.findByText('Couldn’t sign in')).toBeInTheDocument()
    expect(signInWithTicket).not.toHaveBeenCalled()
    window.history.replaceState(null, '', '/')
  })

  it('says so when the ticket is refused', async () => {
    appHands('used')
    const signInWithTicket = vi.fn(async () => {
      throw new Error('Ticket expired.')
    })
    renderAt('/desktop/finish', { status: 'signed-out', signInWithTicket })
    expect(await screen.findByText(/Ticket expired\./)).toBeInTheDocument()
  })
})
