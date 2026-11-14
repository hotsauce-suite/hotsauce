import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { useState } from 'react'
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

// docs/PLAN-mac-onboarding.md R8: signing in also connects Dictate, the token only over the bridge.
describe('/desktop/finish connects Dictate', () => {
  afterEach(() => {
    delete (window as { webkit?: unknown }).webkit
  })

  const app = (status: unknown) => {
    const dictate = vi.fn(async (message: { type: string; token?: string }) =>
      message.type === 'status' ? status : { ok: true, account: 'ada@example.com' },
    )
    Object.assign(window, {
      webkit: {
        messageHandlers: {
          hearthTicket: { postMessage: async () => 'tkt_9' },
          hearthDictateConnect: { postMessage: dictate },
        },
      },
    })
    return dictate
  }

  it('creates a device named after the Mac and hands its token to the app', async () => {
    const dictate = app({ needed: true, deviceName: 'Ada’s MacBook' })
    let created: unknown = null
    server.use(
      http.post('/api/dictation/devices', async ({ request }) => {
        created = await request.json()
        return HttpResponse.json({
          id: 'd1',
          name: 'Ada’s MacBook',
          createdAt: '2026-11-14T00:00:00Z',
          lastUsedAt: null,
          token: 'hdt_secret_token_value_123456',
        })
      }),
    )
    const signInWithTicket = vi.fn(async () => {})
    renderAt('/desktop/finish', { status: 'signed-out', signInWithTicket })
    expect(await screen.findByText('today home')).toBeInTheDocument()
    expect(created).toEqual({ name: 'Ada’s MacBook' })
    expect(dictate).toHaveBeenCalledWith({
      type: 'connect',
      token: 'hdt_secret_token_value_123456',
    })
    expect(window.location.href).not.toContain('hdt_')
  })

  it('creates nothing for a Mac already connected to this server', async () => {
    const dictate = app({ needed: false, deviceName: 'Mac' })
    const posted = vi.fn()
    server.use(
      http.post('/api/dictation/devices', () => {
        posted()
        return HttpResponse.json({})
      }),
    )
    renderAt('/desktop/finish', { status: 'signed-out', signInWithTicket: vi.fn(async () => {}) })
    expect(await screen.findByText('today home')).toBeInTheDocument()
    expect(posted).not.toHaveBeenCalled()
    expect(dictate).toHaveBeenCalledTimes(1)
  })

  it('still opens Today when connecting Dictate fails', async () => {
    app({ needed: true, deviceName: 'Mac' })
    server.use(
      http.post('/api/dictation/devices', () =>
        HttpResponse.json({ error: 'no' }, { status: 500 }),
      ),
    )
    renderAt('/desktop/finish', { status: 'signed-out', signInWithTicket: vi.fn(async () => {}) })
    expect(await screen.findByText('today home')).toBeInTheDocument()
  })

  it('does nothing in an older app without the bridge', async () => {
    Object.assign(window, {
      webkit: { messageHandlers: { hearthTicket: { postMessage: async () => 'tkt_9' } } },
    })
    const posted = vi.fn()
    server.use(
      http.post('/api/dictation/devices', () => {
        posted()
        return HttpResponse.json({})
      }),
    )
    renderAt('/desktop/finish', { status: 'signed-out', signInWithTicket: vi.fn(async () => {}) })
    expect(await screen.findByText('today home')).toBeInTheDocument()
    expect(posted).not.toHaveBeenCalled()
  })
})

describe('/desktop/finish stays until Dictate is connected', () => {
  afterEach(() => {
    delete (window as { webkit?: unknown }).webkit
  })

  it('doesn’t leave the finish page the moment auth turns signed-in', async () => {
    let answerStatus: (value: unknown) => void = () => {}
    const dictate = vi.fn(
      (message: { type: string }) =>
        new Promise((resolve) => {
          if (message.type === 'status') answerStatus = resolve
          else resolve({ ok: false, error: 'no' })
        }),
    )
    Object.assign(window, {
      webkit: {
        messageHandlers: {
          hearthTicket: { postMessage: async () => 'tkt_9' },
          hearthDictateConnect: { postMessage: dictate },
        },
      },
    })
    let flip: () => void = () => {}
    function Harness() {
      const [status, setStatus] = useState<'signed-out' | 'signed-in'>('signed-out')
      flip = () => setStatus('signed-in')
      const value = {
        mode: 'dev',
        status,
        signOut: () => {},
        signInWithTicket: async () => flip(),
      } as unknown as AuthState
      const [router] = useState(() =>
        createMemoryRouter(
          [
            { path: '/desktop/finish', element: <DesktopFinishRoute /> },
            { path: '/today', element: <p>today home</p> },
          ],
          { initialEntries: ['/desktop/finish'] },
        ),
      )
      return (
        <AuthContext.Provider value={value}>
          <RouterProvider router={router} />
        </AuthContext.Provider>
      )
    }
    render(<Harness />)
    await waitFor(() => expect(dictate).toHaveBeenCalledWith({ type: 'status' }))
    // Signed in, Dictate's handoff still under way: still on the finish page.
    expect(screen.queryByText('today home')).toBeNull()
    expect(screen.getByText('Signing in…')).toBeInTheDocument()
    await act(async () => answerStatus({ needed: false, deviceName: 'Mac' }))
    expect(await screen.findByText('today home')).toBeInTheDocument()
  })
})
