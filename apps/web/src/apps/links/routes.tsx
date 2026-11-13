import type { RouteObject } from 'react-router'

// Under /links (ARCHITECTURE §23.6).
export const linksRoutes: RouteObject[] = [
  { index: true, lazy: async () => ({ Component: (await import('./LinksPage')).default }) },
  { path: 'save', lazy: async () => ({ Component: (await import('./SaveLinkPage')).default }) },
  {
    path: ':space/:id',
    lazy: async () => ({ Component: (await import('./LinkReader')).default }),
  },
]
