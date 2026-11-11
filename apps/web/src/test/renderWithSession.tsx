import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { SessionProvider } from '../state/session'

/** Renders `element` inside a memory router and a live session against the mock API. */
export function renderWithSession(
  element: ReactElement,
  initialPath = '/docs',
): { router: ReturnType<typeof createMemoryRouter> } {
  const router = createMemoryRouter(
    [
      { path: '/docs', element: <SessionProvider>{element}</SessionProvider> },
      { path: '/docs/:space/*', element: <p>Opened</p> },
      { path: '/meetings/:space/*', element: <p>Opened</p> },
    ],
    { initialEntries: [initialPath] },
  )
  render(<RouterProvider router={router} />)
  return { router }
}
