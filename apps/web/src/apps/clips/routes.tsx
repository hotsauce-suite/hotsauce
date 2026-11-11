import type { RouteObject } from 'react-router'

// Under /clips (ARCHITECTURE §10.3).
export const clipsRoutes: RouteObject[] = [
  {
    index: true,
    lazy: async () => ({ Component: (await import('./ClipsLibrary')).default }),
  },
  {
    path: 'new',
    lazy: async () => ({ Component: (await import('./RecordClip')).default }),
  },
  {
    path: ':id',
    lazy: async () => ({ Component: (await import('./ClipPage')).default }),
  },
]
