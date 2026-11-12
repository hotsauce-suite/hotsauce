import { Navigate, useSearchParams } from 'react-router'
import { TOUCH_QUERY, useMediaQuery } from '../hooks/useMediaQuery'

/**
 * `/`: Today (the home page), except when the home-screen icon opens the app on a phone or tablet
 * (`start_url` is `/?launch=home`), which goes straight to recording a voice note.
 */
export function Launch() {
  const [params] = useSearchParams()
  const touch = useMediaQuery(TOUCH_QUERY)
  const home = params.get('launch') === 'home'
  return <Navigate to={home && touch ? '/dictate/voice' : '/today'} replace />
}
