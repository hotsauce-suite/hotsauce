import type { RouteObject } from 'react-router'

export type FilesRouteKind = 'browse' | 'recent' | 'item'

// One page for browsing and an open file, so opening one keeps the folder underneath.
const view = (kind: FilesRouteKind): Pick<RouteObject, 'lazy' | 'handle'> => ({
  handle: { filesKind: kind },
  lazy: async () => ({ Component: (await import('./FilesPage')).default }),
})

// Under /files (ARCHITECTURE §18.4).
export const filesRoutes: RouteObject[] = [
  { index: true, ...view('browse') },
  { path: 'recent', ...view('recent') },
  {
    path: 's/:token',
    lazy: async () => ({ Component: (await import('./SharedFilePage')).default }),
  },
  { path: ':space/:id', ...view('item') },
]
