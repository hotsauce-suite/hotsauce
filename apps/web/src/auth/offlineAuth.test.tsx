import { act, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { reportReachable, reportUnreachable, resetConnectionForTests } from '../lib/connection'
import { rememberedMember, rememberMember } from '../lib/offlineStart'
import SignInRoute from '../routes/SignInRoute'
import { AuthContext, useAuthState } from './AuthContext'
import { DevAuthProvider } from './devAuth'
import { OfflineAuthProvider } from './offlineAuth'

function Status() {
  const auth = useAuthState()
  return (
    <div>
      <span data-testid="status">{auth.status}</span>
      <button type="button" onClick={auth.signOut}>
        Sign out
      </button>
    </div>
  )
}

const ada = { userId: 'u1', email: 'ada@example.test', name: 'Ada', handle: 'ada', isAdmin: false }

describe('starting offline (A2)', () => {
  it('opens as the remembered member (A2.3)', () => {
    rememberMember(ada, 'Acme')
    render(
      <OfflineAuthProvider mode="clerk">
        <Status />
      </OfflineAuthProvider>,
    )
    expect(screen.getByTestId('status')).toHaveTextContent('signed-in')
  })

  it('with nobody remembered, it’s signed out', () => {
    render(
      <OfflineAuthProvider mode="clerk">
        <Status />
      </OfflineAuthProvider>,
    )
    expect(screen.getByTestId('status')).toHaveTextContent('signed-out')
  })

  it('reloads into the normal sign-in once the server answers again (A2.4)', () => {
    resetConnectionForTests(async () => false)
    reportUnreachable()
    rememberMember(ada, 'Acme')
    const reload = vi.fn()
    render(
      <OfflineAuthProvider mode="clerk" reload={reload}>
        <Status />
      </OfflineAuthProvider>,
    )
    expect(reload).not.toHaveBeenCalled()
    act(() => reportReachable())
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('signing out forgets the member, offline and in dev sign-in (A2.2)', () => {
    rememberMember(ada, 'Acme')
    const { unmount } = render(
      <OfflineAuthProvider mode="dev">
        <Status />
      </OfflineAuthProvider>,
    )
    act(() => screen.getByRole('button', { name: 'Sign out' }).click())
    expect(rememberedMember()).toBeNull()
    expect(screen.getByTestId('status')).toHaveTextContent('signed-out')
    unmount()

    rememberMember(ada, 'Acme')
    localStorage.setItem('hearth.devUser', ada.email)
    render(
      <DevAuthProvider>
        <Status />
      </DevAuthProvider>,
    )
    act(() => screen.getByRole('button', { name: 'Sign out' }).click())
    expect(rememberedMember()).toBeNull()
  })
})

it('offline with nobody remembered, the sign-in page says it needs a connection (A2.3)', async () => {
  const router = createMemoryRouter(
    [
      {
        id: 'root',
        path: '/sign-in',
        element: (
          <AuthContext.Provider
            value={{ mode: 'clerk', status: 'signed-out', offline: true, signOut: () => {} }}
          >
            <SignInRoute />
          </AuthContext.Provider>
        ),
      },
    ],
    { initialEntries: ['/sign-in'] },
  )
  render(<RouterProvider router={router} />)
  expect(await screen.findByTestId('signin-offline')).toHaveTextContent('You’re offline')
})
