import type { RouteObject } from 'react-router'

// Under /sign (docs/PLAN-sign.md R9).
export const signRoutes: RouteObject[] = [
  { index: true, lazy: async () => ({ Component: (await import('./SignPage')).default }) },
  {
    path: ':space/:id',
    lazy: async () => ({ Component: (await import('./EnvelopePage')).default }),
  },
]
