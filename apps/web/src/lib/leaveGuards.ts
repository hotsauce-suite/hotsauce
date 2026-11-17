// Work that leaving the page would cut, held outside any one page: uploads that carry on while
// the member moves around, a clip still saving, saves on their way to the server. Closing the tab
// asks first while any holds, and an update reload waits (docs/PLAN-reload-after-updates.md R4).

const guards = new Set<() => boolean>()
let writes = 0
let listening = false

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (leaveGuarded()) event.preventDefault()
}

/** Adds a check that says whether leaving now would cut something; returns its removal. */
export function registerLeaveGuard(check: () => boolean): () => void {
  guards.add(check)
  if (!listening && typeof window !== 'undefined') {
    window.addEventListener('beforeunload', onBeforeUnload)
    listening = true
  }
  return () => {
    guards.delete(check)
  }
}

/** Counts a save on its way to the server until it's answered. */
export function trackWrite<T>(pending: Promise<T>): Promise<T> {
  writes += 1
  return pending.finally(() => {
    writes -= 1
  })
}

export function leaveGuarded(): boolean {
  if (writes > 0) return true
  for (const check of guards) if (check()) return true
  return false
}
