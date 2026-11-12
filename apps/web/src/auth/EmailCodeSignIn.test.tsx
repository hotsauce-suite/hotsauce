import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Clerk's hooks are code we don't own: they are faked here, the way Clerk documents them.
const clerk = vi.hoisted(() => ({
  signIn: {
    create: vi.fn(),
    prepareFirstFactor: vi.fn(),
    attemptFirstFactor: vi.fn(),
  },
  signUp: {
    create: vi.fn(),
    prepareEmailAddressVerification: vi.fn(),
    attemptEmailAddressVerification: vi.fn(),
  },
  setActive: vi.fn(),
}))

vi.mock('@clerk/react/legacy', () => ({
  useSignIn: () => ({ isLoaded: true, signIn: clerk.signIn, setActive: clerk.setActive }),
  useSignUp: () => ({ isLoaded: true, signUp: clerk.signUp, setActive: clerk.setActive }),
}))
vi.mock('@clerk/react/errors', () => ({
  isClerkAPIResponseError: (e: unknown) => typeof e === 'object' && e !== null && 'clerkError' in e,
}))
vi.mock('@clerk/react', () => ({
  AuthenticateWithRedirectCallback: () => null,
  ClerkFailed: () => null,
  ClerkProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => ({}),
}))

import { ClerkEmailCodeSignIn } from './clerkAuth'

function renderIt() {
  const router = createMemoryRouter(
    [
      { path: '/sign-in', element: <ClerkEmailCodeSignIn returnTo="/meetings" /> },
      { path: '/meetings', element: <p>meetings home</p> },
    ],
    { initialEntries: ['/sign-in'] },
  )
  render(<RouterProvider router={router} />)
  return router
}

const clerkError = (code: string, longMessage = code) => ({
  clerkError: true,
  errors: [{ code, message: code, longMessage }],
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ClerkEmailCodeSignIn', () => {
  it('signs a returning invited person in with the emailed code', async () => {
    clerk.signIn.create.mockResolvedValue({
      supportedFirstFactors: [{ strategy: 'email_code', emailAddressId: 'idn_1' }],
    })
    clerk.signIn.attemptFirstFactor.mockResolvedValue({
      status: 'complete',
      createdSessionId: 'sess_1',
    })
    const user = userEvent.setup()
    renderIt()
    await user.click(screen.getByTestId('email-code-open'))
    await user.type(screen.getByTestId('email-code-email'), 'jo@partner.org')
    await user.click(screen.getByRole('button', { name: 'Email me a code' }))
    expect(clerk.signIn.create).toHaveBeenCalledWith({ identifier: 'jo@partner.org' })
    expect(clerk.signIn.prepareFirstFactor).toHaveBeenCalledWith({
      strategy: 'email_code',
      emailAddressId: 'idn_1',
    })
    await user.type(await screen.findByTestId('email-code-value'), '424242')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(clerk.signIn.attemptFirstFactor).toHaveBeenCalledWith({
      strategy: 'email_code',
      code: '424242',
    })
    expect(clerk.setActive).toHaveBeenCalledWith({ session: 'sess_1' })
    expect(await screen.findByText('meetings home')).toBeInTheDocument()
    expect(clerk.signUp.create).not.toHaveBeenCalled()
  })

  it('signs a first-time invited person up instead', async () => {
    clerk.signIn.create.mockRejectedValue(clerkError('form_identifier_not_found'))
    clerk.signUp.attemptEmailAddressVerification.mockResolvedValue({
      status: 'complete',
      createdSessionId: 'sess_2',
    })
    const user = userEvent.setup()
    renderIt()
    await user.click(screen.getByTestId('email-code-open'))
    await user.type(screen.getByTestId('email-code-email'), 'new@partner.org')
    await user.click(screen.getByRole('button', { name: 'Email me a code' }))
    expect(clerk.signUp.create).toHaveBeenCalledWith({ emailAddress: 'new@partner.org' })
    expect(clerk.signUp.prepareEmailAddressVerification).toHaveBeenCalledWith({
      strategy: 'email_code',
    })
    await user.type(await screen.findByTestId('email-code-value'), '111111')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(clerk.setActive).toHaveBeenCalledWith({ session: 'sess_2' })
    expect(await screen.findByText('meetings home')).toBeInTheDocument()
  })

  it('shows Clerk’s message for a wrong code and stays put', async () => {
    clerk.signIn.create.mockResolvedValue({
      supportedFirstFactors: [{ strategy: 'email_code', emailAddressId: 'idn_1' }],
    })
    clerk.signIn.attemptFirstFactor.mockRejectedValue(
      clerkError('form_code_incorrect', 'Incorrect code'),
    )
    const user = userEvent.setup()
    renderIt()
    await user.click(screen.getByTestId('email-code-open'))
    await user.type(screen.getByTestId('email-code-email'), 'jo@partner.org')
    await user.click(screen.getByRole('button', { name: 'Email me a code' }))
    await user.type(await screen.findByTestId('email-code-value'), '000000')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect code')
    expect(clerk.setActive).not.toHaveBeenCalled()
  })

  it('says so when email codes are off in Clerk', async () => {
    clerk.signIn.create.mockResolvedValue({
      supportedFirstFactors: [{ strategy: 'oauth_google' }],
    })
    const user = userEvent.setup()
    renderIt()
    await user.click(screen.getByTestId('email-code-open'))
    await user.type(screen.getByTestId('email-code-email'), 'jo@partner.org')
    await user.click(screen.getByRole('button', { name: 'Email me a code' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('aren’t turned on')
  })
})
