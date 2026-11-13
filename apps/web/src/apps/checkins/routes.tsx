import type { RouteObject } from 'react-router'

// Under /checkins (ARCHITECTURE §24.6).
export const checkinsRoutes: RouteObject[] = [
  { index: true, lazy: async () => ({ Component: (await import('./CheckinsPage')).default }) },
  { path: ':id', lazy: async () => ({ Component: (await import('./CheckinPage')).default }) },
]
