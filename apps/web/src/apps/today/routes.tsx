import type { RouteObject } from 'react-router'

export const todayRoutes: RouteObject[] = [
  { index: true, lazy: async () => ({ Component: (await import('./TodayPage')).default }) },
]
