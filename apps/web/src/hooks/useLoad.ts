import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Loads a page's list once, and again on `reload` (the "Try again" of `LoadError`). `failed` is
 * true from a failed request until the next one starts; the data from an earlier success stays.
 */
export function useLoad<T>(load: () => Promise<T>): {
  data: T | null
  failed: boolean
  reload: () => void
} {
  const [data, setData] = useState<T | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const loader = useRef(load)
  loader.current = load

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger.
  useEffect(() => {
    let cancelled = false
    setFailed(false)
    loader.current().then(
      (value) => {
        if (!cancelled) setData(value)
      },
      () => {
        if (!cancelled) setFailed(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [attempt])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  return { data, failed, reload }
}
