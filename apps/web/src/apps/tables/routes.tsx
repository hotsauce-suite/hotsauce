import type { RouteObject } from 'react-router'

// Under /tables (ARCHITECTURE §22.8).
export const tablesRoutes: RouteObject[] = [
  { index: true, lazy: async () => ({ Component: (await import('./TablesPage')).default }) },
  {
    path: 'form/:space/:id',
    lazy: async () => ({ Component: (await import('./FormTablePage')).default }),
  },
  {
    path: ':space/:id',
    lazy: async () => ({ Component: (await import('./TableEditor')).default }),
  },
]
