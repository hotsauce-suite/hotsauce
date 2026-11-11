import { createBrowserRouter, Navigate } from 'react-router'
import { clipsRoutes } from './apps/clips/routes'
import { dictateRoutes } from './apps/dictate/routes'
import { meetingsRoutes } from './apps/meetings/routes'
import { AuthRoot, BootError } from './auth/AuthRoot'
import { loadBoot } from './brand/boot'
import AppShell from './components/AppShell'

// Route-level code splitting: the shell ships in the entry chunk so the sidebar paints at
// once; the editor (CodeMirror), sign-in and Clerk load on demand.
//
// A function, not a module-level router: creating it starts the first navigation (and the
// /api/health loader), which must wait until the dev mock API is listening.
export const createAppRouter = () =>
  createBrowserRouter([
    {
      id: 'root',
      loader: loadBoot,
      element: <AuthRoot />,
      errorElement: <BootError />,
      HydrateFallback: () => null,
      children: [
        { path: '/', element: <Navigate to="/docs" replace /> },
        {
          path: '/setup',
          lazy: async () => ({ Component: (await import('./routes/SetupRoute')).default }),
        },
        {
          path: '/sign-in',
          lazy: async () => ({ Component: (await import('./routes/SignInRoute')).default }),
        },
        {
          path: '/sso-callback',
          lazy: async () => ({
            Component: (await import('./auth/clerkAuth')).ClerkSsoCallback,
          }),
        },
        {
          // One shell around every app (src/apps/registry.ts), so switching keeps the session.
          element: <AppShell />,
          children: [
            {
              path: '/docs',
              children: [
                {
                  index: true,
                  lazy: async () => ({ Component: (await import('./routes/DocsIndex')).default }),
                },
                {
                  path: ':space/*',
                  lazy: async () => ({ Component: (await import('./routes/DocRoute')).default }),
                },
              ],
            },
            { path: '/meetings', children: meetingsRoutes },
            {
              path: '/settings',
              lazy: async () => ({ Component: (await import('./routes/SettingsRoute')).default }),
            },
            {
              path: '/settings/organization',
              lazy: async () => ({
                Component: (await import('./routes/OrgSettingsRoute')).default,
              }),
            },
            { path: '/dictate', children: dictateRoutes },
            { path: '/clips', children: clipsRoutes },
          ],
        },
        { path: '*', element: <Navigate to="/docs" replace /> },
      ],
    },
  ])
