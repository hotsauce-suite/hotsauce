import type { RouteObject } from 'react-router'

// Under /dictate (ARCHITECTURE §9.3).
export const dictateRoutes: RouteObject[] = [
  {
    index: true,
    lazy: async () => ({ Component: (await import('./DictatePage')).default }),
  },
]
