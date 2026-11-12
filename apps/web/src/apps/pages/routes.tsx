import type { RouteObject } from 'react-router'

// Under /pages (ARCHITECTURE §20.2). Not an app on the rail: Pages belongs to Docs.
export const pagesRoutes: RouteObject[] = [
  { index: true, lazy: async () => ({ Component: (await import('./PagesRoute')).PagesList }) },
  {
    path: ':space/:id',
    lazy: async () => ({ Component: (await import('./PagesRoute')).PageRoute }),
  },
]
