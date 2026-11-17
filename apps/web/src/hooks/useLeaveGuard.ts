import { useEffect } from 'react'

/**
 * While `active`, closing or reloading the page asks first (the browser's own "Leave site?"),
 * and Hotsauce's update reload waits (lib/safeToReload). For recordings and uploads that a
 * reload would cut off.
 */
export function useLeaveGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [active])
}
