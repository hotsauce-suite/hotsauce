import { lazy, Suspense, useEffect, useState } from 'react'
import type { PageContext } from '../../api/assistant'
import { Icon } from '../Icon'
import { closeAssistant, openAssistant, toggleAssistant, useAssistantState } from './state'

const AssistantPanel = lazy(() => import('./AssistantPanel'))

/**
 * The assistant on every page (docs/PLAN-assistant.md): ⌘J / Ctrl+J opens and closes the panel,
 * and a round button in the corner opens it. The panel's code loads on first open.
 */
export function AssistantHost({ page, compact }: { page: PageContext | null; compact: boolean }) {
  const { open } = useAssistantState()
  const [loaded, setLoaded] = useState(false)
  if (open && !loaded) setLoaded(true)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key.toLowerCase() !== 'j') return
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      event.preventDefault()
      toggleAssistant()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      {open ? null : (
        <button
          type="button"
          data-testid="assistant-open"
          aria-label="Ask the assistant (⌘J)"
          title="Ask the assistant (⌘J)"
          onClick={() => openAssistant()}
          className={`fixed right-4 z-30 flex size-11 items-center justify-center rounded-full border border-ash bg-paper-raised text-ink shadow-float hover:bg-paper-sunk ${compact ? 'bottom-[calc(4.75rem+env(safe-area-inset-bottom))]' : 'bottom-4'}`}
        >
          <Icon name="sparkle" className="size-5" />
        </button>
      )}
      {loaded ? (
        <Suspense fallback={null}>
          <AssistantPanel open={open} page={page} onClose={closeAssistant} />
        </Suspense>
      ) : null}
    </>
  )
}
