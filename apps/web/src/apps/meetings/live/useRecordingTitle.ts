import { useEffect } from 'react'
import { type LiveSnapshot, recordingTitle } from './liveState'

/**
 * While a meeting is live the tab title says so (PRD §6.9), whatever page is open. Pages set
 * their own titles as they mount, so this re-applies the label whenever `<title>` changes and
 * gives the page its last title back when recording ends.
 */
export function useRecordingTitle(live: LiveSnapshot | null): void {
  const label = live ? recordingTitle(live) : null
  useEffect(() => {
    if (!label) return
    let pageTitle = document.title
    const apply = () => {
      if (document.title === label) return
      pageTitle = document.title
      document.title = label
    }
    apply()
    const observer = new MutationObserver(apply)
    const title = document.querySelector('title')
    if (title) observer.observe(title, { childList: true, characterData: true, subtree: true })
    return () => {
      observer.disconnect()
      document.title = pageTitle
    }
  }, [label])
}
