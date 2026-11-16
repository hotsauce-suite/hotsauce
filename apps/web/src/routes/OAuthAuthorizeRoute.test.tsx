import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthState } from '../auth/AuthContext'
import { product } from '../brand/product'
import { server, TEST_USER } from '../test/mockServer'
import OAuthAuthorizeRoute from './OAuthAuthorizeRoute'

const QS = '?client_id=c1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&state=s1'

function renderAt(path: string, auth: Partial<AuthState> = {}) {
  const value = { mode: 'dev', status: 'signed-in', signOut: () => {}, ...auth } as AuthState
  const router = createMemoryRouter(
    [
      { path: '/oauth/authorize', element: <OAuthAuthorizeRoute /> },
      { path: '/sign-in', element: <p>sign-in page</p> },
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

const check = {
  clientName: 'Claude',
  clientId: 'c1',
  redirectHost: 'claude.ai',
  verified: true,
  cancelUrl: 'https://claude.ai/cb?error=access_denied&state=s1',
}

describe('/oauth/authorize', () => {
  const assign = vi.fn()
  afterEach(() => assign.mockReset())

  it('asks first, then sends the browser back with what the server returned', async () => {
    let allowed: unknown = null
    server.use(
      http.get('/api/oauth/authorize', ({ request }) => {
        expect(new URL(request.url).search).toBe(QS)
        return HttpResponse.json(check)
      }),
      http.post('/api/oauth/authorize', async ({ request }) => {
        allowed = await request.json()
        return HttpResponse.json({ redirect: 'https://claude.ai/cb?code=htc_1&state=s1' })
      }),
    )
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign },
    })
    const user = userEvent.setup()
    renderAt(`/oauth/authorize${QS}`)
    expect(
      await screen.findByRole('heading', { name: `Let Claude use your ${product()}?` }),
    ).toBeInTheDocument()
    expect(await screen.findByText(TEST_USER)).toBeInTheDocument()
    expect(screen.getByText('claude.ai')).toBeInTheDocument()
    expect(screen.queryByTestId('oauth-unverified')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Cancel' })).toHaveAttribute('href', check.cancelUrl)
    expect(allowed).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Allow' }))
    expect(await screen.findByText(/You can close this tab/)).toBeInTheDocument()
    expect(allowed).toEqual({
      client_id: 'c1',
      redirect_uri: 'https://claude.ai/cb',
      state: 's1',
    })
    expect(assign).toHaveBeenCalledWith('https://claude.ai/cb?code=htc_1&state=s1')
  })

  it('leads with the return address when the app names itself', async () => {
    server.use(
      http.get('/api/oauth/authorize', () =>
        HttpResponse.json({
          ...check,
          redirectHost: 'claude-auth.example',
          verified: false,
        }),
      ),
    )
    renderAt(`/oauth/authorize${QS}`)
    expect(
      await screen.findByRole('heading', {
        name: `Let claude-auth.example use your ${product()}?`,
      }),
    ).toBeInTheDocument()
    expect(screen.getByTestId('oauth-unverified')).toHaveTextContent('calls itself “Claude”')
  })

  it('shows a bad request on the page and offers no Allow', async () => {
    server.use(
      http.get('/api/oauth/authorize', () =>
        HttpResponse.json(
          {
            error: { code: 'bad_request', message: 'This app isn’t registered with this server.' },
          },
          { status: 400 },
        ),
      ),
    )
    renderAt(`/oauth/authorize${QS}`)
    expect(await screen.findByText(/isn’t registered/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
  })

  it('sends a signed-out member to sign in, then back here', async () => {
    const router = renderAt(`/oauth/authorize${QS}`, { status: 'signed-out' })
    expect(await screen.findByText('sign-in page')).toBeInTheDocument()
    expect(router.state.location.state).toEqual({ from: `/oauth/authorize${QS}` })
  })
})
