import type { RouteObject } from 'react-router'

export type NotesRouteKind = 'board' | 'archive' | 'trash' | 'label' | 'item'

// One component for every view, told which by the route's handle: opening a note (or closing
// it) keeps the board, its composer and its scroll.
const view = (kind: NotesRouteKind): Pick<RouteObject, 'lazy' | 'handle'> => ({
  handle: { notesKind: kind },
  lazy: async () => ({ Component: (await import('./NotesPage')).default }),
})

// Under /notes (ARCHITECTURE §14.5).
export const notesRoutes: RouteObject[] = [
  { index: true, ...view('board') },
  { path: 'archive', ...view('archive') },
  { path: 'trash', ...view('trash') },
  { path: 'label/:label', ...view('label') },
  { path: 'item/:space/:id', ...view('item') },
  {
    path: 'import',
    lazy: async () => ({ Component: (await import('./ImportKeep')).default }),
  },
]
