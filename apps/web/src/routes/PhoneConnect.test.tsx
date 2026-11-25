import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthState } from '../auth/AuthContext'
import { product } from '../brand/product'
import { phoneCallback } from '../lib/phone'
import { server, TEST_USER } from '../test/mockServer'
import PhoneConnectRoute from './PhoneConnectRoute'

// docs/PLAN-android.md R5: the Android app's widgets connect only after the member allows it.

const STATE = 'Abc_123-'.repeat(5)

function renderAt(path: string, auth: Partial<AuthState>) {
  const value = { mode: 'dev', status: 'signed-in', signOut: () => {}, ...auth } as AuthState
  const router = createMemoryRouter(
    [
      { path: '/phone/connect', element: <PhoneConnectRoute /> },
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

afterEach(() => vi.unstubAllGlobals())

describe('/phone/connect', () => {
  it('R5: asks first, then makes a phone device and hands its token back to the app', async () => {
    const made: unknown[] = []
    server.use(
      http.post('/api/dictation/devices', async ({ request }) => {
        made.push(await request.json())
        return HttpResponse.json(
          { id: 'd1', kind: 'phone', name: 'Android phone', createdAt: '', token: 'hpt_secret' },
          { status: 201 },
        )
      }),
    )
    const user = userEvent.setup()
    renderAt(`/phone/connect?state=${STATE}`, {})
    expect(await screen.findByText(TEST_USER)).toBeInTheDocument()
    expect(made).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Allow' }))
    const back = await screen.findByRole('link', { name: `Back to ${product()}` })
    expect(made).toEqual([{ name: 'Android phone', kind: 'phone' }])
    expect(back).toHaveAttribute('href', phoneCallback(STATE, 'hpt_secret'))
    expect(back.getAttribute('href')).toMatch(
      /^intent:\/\/connect#Intent;scheme=hotsauce;package=work\.hotsauce\.app;S\.state=.+;S\.token=hpt_secret;end$/,
    )
  })

  it('R5: Not now goes back to the app with no token', async () => {
    renderAt(`/phone/connect?state=${STATE}`, {})
    const no = await screen.findByRole('link', { name: 'Not now' })
    expect(no.getAttribute('href')).toContain('S.declined=1')
    expect(no.getAttribute('href')).not.toContain('S.token')
  })

  it('R5: refuses a link that didn’t come from the app', async () => {
    renderAt('/phone/connect?state=short', {})
    expect(await screen.findByText(/didn’t come from the app/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
  })

  it('R5: sends a signed-out member to sign in first, then back', async () => {
    const router = renderAt(`/phone/connect?state=${STATE}`, { status: 'signed-out' })
    expect(await screen.findByText('sign-in page')).toBeInTheDocument()
    expect(router.state.location.state).toEqual({ from: `/phone/connect?state=${STATE}` })
  })

  it('R5: refuses a token with characters an intent could misread', () => {
    expect(() => phoneCallback(STATE, 'hpt_a;S.x=1')).toThrow()
  })
})
