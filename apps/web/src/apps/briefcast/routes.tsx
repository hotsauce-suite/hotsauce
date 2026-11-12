import type { RouteObject } from 'react-router'

// Under /briefcast: today's episode, or a past one by date.
export const briefcastRoutes: RouteObject[] = [
  {
    index: true,
    lazy: async () => ({ Component: (await import('./BriefcastPage')).default }),
  },
  {
    path: ':date',
    lazy: async () => ({ Component: (await import('./BriefcastPage')).default }),
  },
]
