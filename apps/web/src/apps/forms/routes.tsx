import type { RouteObject } from 'react-router'

const editor = async () => ({ Component: (await import('./FormEditor')).default })

// Under /forms (ARCHITECTURE §21.4). The fill page /f/:link is outside the shell (router.tsx).
export const formsRoutes: RouteObject[] = [
  { index: true, lazy: async () => ({ Component: (await import('./FormsPage')).default }) },
  { path: ':space/:id', lazy: editor },
  { path: ':space/:id/answers', lazy: editor },
  { path: ':space/:id/settings', lazy: editor },
]
