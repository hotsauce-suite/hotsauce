import { useSyncExternalStore } from 'react'

export const MOBILE_QUERY = '(max-width: 767px)'
/**
 * Wide enough for the rail, the sidebar, a page and a side panel side by side. Narrower (an upright
 * iPad), panels float over the page (`.side-pane` in app.css) and top bars drop button labels.
 */
export const PANES_QUERY = '(min-width: 1100px)'
/**
 * A phone or tablet: the main pointer is a finger and nothing hovers. A laptop with a touch
 * screen still has a mouse or trackpad as its main pointer, so it doesn't match.
 */
export const TOUCH_QUERY = '(hover: none) and (pointer: coarse)'

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
  )
}
