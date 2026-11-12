import { configure, render } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { briefcastRoutes } from '../apps/briefcast/routes'
import { dictateRoutes } from '../apps/dictate/routes'
import { linksRoutes } from '../apps/links/routes'
import { meetingsRoutes } from '../apps/meetings/routes'
import { notesRoutes } from '../apps/notes/routes'
import { peopleRoutes } from '../apps/people/routes'
import { tasksRoutes } from '../apps/tasks/routes'
import { todayRoutes } from '../apps/today/routes'
import { AuthContext, type AuthState } from '../auth/AuthContext'
import { loadBoot } from '../brand/boot'
import AppShell from '../components/AppShell'
import { Launch } from '../routes/Launch'

// Routes load lazily; the first visit to an editor page imports CodeMirror, which can take
// more than the default second on a busy machine with a cold transform cache.
configure({ asyncUtilTimeout: 5000 })

const SIGNED_IN: AuthState = { mode: 'dev', status: 'signed-in', signOut: () => {} }

/** The signed-in app (shell, sidebar, Today, Docs, Meetings, Dictate, Tasks, Notes and People routes) at `initialPath`, in memory. */
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
          { path: '/', element: <Launch /> },
          { path: '/today', children: todayRoutes },
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
          { path: '/tasks', children: tasksRoutes },
          { path: '/notes', children: notesRoutes },
          { path: '/links', children: linksRoutes },
          { path: '/people', children: peopleRoutes },
          { path: '/briefcast', children: briefcastRoutes },
        ],
      },
    ],
    { initialEntries: [initialPath] },
  )
  render(<RouterProvider router={router} />)
  return { router }
}
