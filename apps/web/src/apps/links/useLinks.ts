import { useEffect, useRef } from 'react'
import { HearthApiError } from '../../api/client'
import { hearthSocket } from '../../api/ws'

/** Calls `fn` (debounced) whenever a commit touches `links/`, here or from anyone else. */
export function useLinksChanged(fn: () => void, delayMs = 300): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = hearthSocket.onChanged((event) => {
      if (!event.paths.some((p) => p.startsWith('links/'))) return
      clearTimeout(timer)
      timer = setTimeout(() => ref.current(), delayMs)
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [delayMs])
}

/** Polls `fn` every `ms` while `active`: a page being fetched shows up without a reload. */
export function usePollWhile(active: boolean, fn: () => void, ms = 2500): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => ref.current(), ms)
    return () => clearInterval(timer)
  }, [active, ms])
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof HearthApiError && err.code !== 'network' && err.status < 500) {
    return err.message
  }
  return fallback
}

export const savedDay = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
