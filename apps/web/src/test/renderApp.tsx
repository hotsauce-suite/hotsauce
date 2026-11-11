import { configure, render } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { dictateRoutes } from '../apps/dictate/routes'
import { meetingsRoutes } from '../apps/meetings/routes'
import { AuthContext, type AuthState } from '../auth/AuthContext'
import { loadBoot } from '../brand/boot'
import AppShell from '../components/AppShell'

// Routes load lazily; the first visit to an editor page imports CodeMirror, which can take
// more than the default second on a busy machine with a cold transform cache.
configure({ asyncUtilTimeout: 5000 })

const SIGNED_IN: AuthState = { mode: 'dev', status: 'signed-in', signOut: () => {} }

/** The signed-in app (shell, sidebar, Docs and Meetings routes) at `initialPath`, in memory. */
export function renderApp(
  initialPath: string,
  auth: Partial<AuthState> = {},
): { router: ReturnType<typeof createMemoryRouter> } {
  const router = createMemoryRouter(
    [
      {
        // Like the real root: names and brand from the mock /api/health and /api/org/brand.
        id: 'root',
        loader: loadBoot,
        element: (
          <AuthContext.Provider value={{ ...SIGNED_IN, ...auth } as AuthState}>
            <AppShell />
          </AuthContext.Provider>
        ),
        HydrateFallback: () => null,
        children: [
          {
            path: '/docs',
            children: [
              {
                index: true,
                lazy: async () => ({ Component: (await import('../routes/DocsIndex')).default }),
              },
              {
                path: ':space/*',
                lazy: async () => ({ Component: (await import('../routes/DocRoute')).default }),
              },
            ],
          },
          { path: '/meetings', children: meetingsRoutes },
          {
            path: '/settings',
            lazy: async () => ({ Component: (await import('../routes/SettingsRoute')).default }),
          },
          { path: '/dictate', children: dictateRoutes },
        ],
      },
    ],
    { initialEntries: [initialPath] },
  )
  render(<RouterProvider router={router} />)
  return { router }
}
