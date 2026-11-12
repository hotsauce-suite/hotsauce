import { render, screen } from '@testing-library/react'
import { HttpResponse, http, type JsonBodyType } from 'msw'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it } from 'vitest'
import { AuthContext, type AuthState } from '../auth/AuthContext'
import { PAGE_SANDBOX } from '../components/PageFrame'
import { server } from '../test/mockServer'
import SharedLinkRoute from './SharedLinkRoute'

// The read-only link page (docs/plans/2026-11-12-share-pages.md R8, R11).

function open(status: AuthState['status'] = 'signed-out') {
  const auth: AuthState = { mode: 'dev', status, signOut: () => {} }
  const router = createMemoryRouter(
    [
      { path: '/s/:token', element: <SharedLinkRoute /> },
      { path: '/sign-in', element: <p>sign-in page</p> },
    ],
    { initialEntries: ['/s/tok_abcdefghijklmnop'] },
  )
  render(
    <AuthContext.Provider value={auth}>
      <RouterProvider router={router} />
    </AuthContext.Provider>,
  )
}

const shared = (body: JsonBodyType, status = 200) =>
  server.use(http.get('/api/shared/:token', () => HttpResponse.json(body, { status })))

describe('SharedLinkRoute', () => {
  it('shows a shared doc read-only, with links into the space left as text', async () => {
    shared({
      kind: 'doc',
      title: 'Q4 plan',
      markdown: '# Q4 plan\n\nSee [the budget](budget.md) and [the site](https://example.org).\n',
      updated: '2026-11-12T10:00:00Z',
      updatedBy: 'Alice',
    })
    open()
    expect(await screen.findByRole('heading', { name: 'Q4 plan' })).toBeTruthy()
    expect(screen.getByTestId('shared-meta').textContent).toMatch(/^Doc · Updated .* by Alice$/)
    expect(screen.getByText('the budget').closest('a')).toBeNull()
    expect(screen.getByRole('link', { name: 'the site' }).getAttribute('target')).toBe('_blank')
  })

  it('shows a page in a sandboxed frame that can’t reach Hearth', async () => {
    shared({
      kind: 'page',
      title: 'Report',
      markdown: '',
      html: '<h1>Hi</h1>',
      updated: null,
      updatedBy: null,
    })
    open('signed-in')
    const frame = (await screen.findByTestId('page-frame')) as HTMLIFrameElement
    expect(frame.getAttribute('sandbox')).toBe(PAGE_SANDBOX)
    expect(PAGE_SANDBOX).not.toContain('allow-same-origin')
    expect(frame.getAttribute('srcdoc')).toBe('<h1>Hi</h1>')
  })

  it('asks a signed-out visitor to sign in when links are for members only', async () => {
    shared({ error: { code: 'unauthorized', message: 'Sign in to open this link' } }, 401)
    open()
    expect(await screen.findByText('Sign in to read this')).toBeTruthy()
    expect(screen.getByTestId('shared-sign-in').getAttribute('href')).toBe('/sign-in')
  })

  it('says so when a link was turned off', async () => {
    shared({ error: { code: 'not_found', message: 'gone' } }, 404)
    open('signed-in')
    expect(await screen.findByText('This link doesn’t open')).toBeTruthy()
  })
})
