import { lazy, Suspense } from 'react'
import { Navigate, type RouteObject, useLocation } from 'react-router'
import { TOUCH_QUERY, useMediaQuery } from '../../hooks/useMediaQuery'

const MacPage = lazy(() => import('./DictatePage'))

/** `/dictate`: voice notes on a phone or tablet, the Mac app's page on a computer. */
function DictateIndex() {
  const touch = useMediaQuery(TOUCH_QUERY)
  const { search } = useLocation()
  if (touch) return <Navigate to={`/dictate/voice${search}`} replace />
  return (
    <Suspense fallback={null}>
      <MacPage />
    </Suspense>
  )
}

// Under /dictate (ARCHITECTURE §9.3).
export const dictateRoutes: RouteObject[] = [
  { index: true, Component: DictateIndex },
  { path: 'mac', lazy: async () => ({ Component: (await import('./DictatePage')).default }) },
  { path: 'voice', lazy: async () => ({ Component: (await import('./VoiceNotes')).default }) },
]
