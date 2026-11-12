import type { RouteObject } from 'react-router'

// Under /boards (ARCHITECTURE §15.4). The editor is its own chunk: only it loads Excalidraw.
export const boardsRoutes: RouteObject[] = [
  { index: true, lazy: async () => ({ Component: (await import('./BoardsPage')).default }) },
  {
    path: ':space/:id',
    lazy: async () => ({ Component: (await import('./BoardRoute')).default }),
  },
]
