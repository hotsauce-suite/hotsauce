import type { RouteObject } from 'react-router'

export type TasksRouteKind = 'inbox' | 'today' | 'upcoming' | 'all' | 'done' | 'project' | 'item'

// One component for every list, told which by the route's handle: going from a list to a task's
// detail (or back) keeps the page, its quick add and its scroll.
const list = (kind: TasksRouteKind): Pick<RouteObject, 'lazy' | 'handle'> => ({
  handle: { tasksKind: kind },
  lazy: async () => ({ Component: (await import('./TasksPage')).default }),
})

// Under /tasks (ARCHITECTURE §12.5).
export const tasksRoutes: RouteObject[] = [
  { index: true, ...list('inbox') },
  { path: 'today', ...list('today') },
  { path: 'upcoming', ...list('upcoming') },
  { path: 'all', ...list('all') },
  { path: 'done', ...list('done') },
  { path: 'project/:space/:name', ...list('project') },
  { path: 'item/:space/:id', ...list('item') },
  {
    path: 'import',
    lazy: async () => ({ Component: (await import('./ImportTodoist')).default }),
  },
]
