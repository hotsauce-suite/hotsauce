import type { RouteObject } from 'react-router'

// Under /for-you (ARCHITECTURE §27.5).
export const forYouRoutes: RouteObject[] = [
  { index: true, lazy: async () => ({ Component: (await import('./ForYouPage')).default }) },
]
