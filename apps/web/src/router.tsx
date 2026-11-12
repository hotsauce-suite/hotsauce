import { createBrowserRouter, Navigate } from 'react-router'
import { boardsRoutes } from './apps/boards/routes'
import { briefcastRoutes } from './apps/briefcast/routes'
import { clipsRoutes } from './apps/clips/routes'
import { dictateRoutes } from './apps/dictate/routes'
import { filesRoutes } from './apps/files/routes'
import { formsRoutes } from './apps/forms/routes'
import { meetingsRoutes } from './apps/meetings/routes'
import { notesRoutes } from './apps/notes/routes'
import { pagesRoutes } from './apps/pages/routes'
import { peopleRoutes } from './apps/people/routes'
import { tasksRoutes } from './apps/tasks/routes'
import { todayRoutes } from './apps/today/routes'
import { AuthRoot, BootError } from './auth/AuthRoot'
import { loadBoot } from './brand/boot'
import AppShell from './components/AppShell'
import { Launch } from './routes/Launch'

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
        { path: '/', element: <Launch /> },
        {
          path: '/setup',
          lazy: async () => ({ Component: (await import('./routes/SetupRoute')).default }),
        },
        {
          path: '/sign-in',
          lazy: async () => ({ Component: (await import('./routes/SignInRoute')).default }),
        },
        {
          // The Mac app's sign-in through the browser (ARCHITECTURE §9.4.1).
          path: '/desktop/connect',
          lazy: async () => ({ Component: (await import('./routes/DesktopConnectRoute')).default }),
        },
        {
          path: '/desktop/finish',
          lazy: async () => ({ Component: (await import('./routes/DesktopFinishRoute')).default }),
        },
        {
          // A booking link's public page (ARCHITECTURE §19): signed out, no app shell.
          path: '/book/:handle/:slug',
          lazy: async () => ({
            Component: (await import('./apps/meetings/booking/BookPage')).default,
          }),
        },
        {
          // A read-only link (ARCHITECTURE §20): outside the shell, signed out when allowed.
          path: '/s/:token',
          lazy: async () => ({ Component: (await import('./routes/SharedLinkRoute')).default }),
        },
        {
          // A form's fill page (ARCHITECTURE §21.3): outside the shell, signed out for a public form.
          path: '/f/:link',
          lazy: async () => ({ Component: (await import('./apps/forms/FillPage')).default }),
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
            {
              path: '/feedback',
              lazy: async () => ({ Component: (await import('./routes/FeedbackRoute')).default }),
            },
            { path: '/dictate', children: dictateRoutes },
            { path: '/clips', children: clipsRoutes },
            { path: '/tasks', children: tasksRoutes },
            { path: '/notes', children: notesRoutes },
            { path: '/boards', children: boardsRoutes },
            { path: '/people', children: peopleRoutes },
            { path: '/today', children: todayRoutes },
            { path: '/files', children: filesRoutes },
            { path: '/forms', children: formsRoutes },
            { path: '/briefcast', children: briefcastRoutes },
            { path: '/pages', children: pagesRoutes },
          ],
        },
        { path: '*', element: <Navigate to="/docs" replace /> },
      ],
    },
  ])
