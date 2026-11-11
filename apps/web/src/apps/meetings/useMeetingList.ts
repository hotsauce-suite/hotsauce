import { useEffect, useState } from 'react'
import { HearthApiError } from '../../api/client'
import { meetingsApi } from '../../api/meetings'
import type { MeetingFilters, MeetingSummary } from '../../api/types'
import { hearthSocket } from '../../api/ws'

export interface MeetingList {
  status: 'loading' | 'ready' | 'error'
  meetings: MeetingSummary[]
  error: string | null
}

/** `GET /api/meetings`, refetched when a commit touches `meetings/` (a stop, an enhance, a push). */
export function useMeetingList(filters: MeetingFilters): MeetingList {
  const [list, setList] = useState<MeetingList>({ status: 'loading', meetings: [], error: null })
  const [version, setVersion] = useState(0)
  const key = JSON.stringify(filters)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the refetch trigger.
  useEffect(() => {
    let cancelled = false
    meetingsApi.list(JSON.parse(key) as MeetingFilters).then(
      (meetings) => {
        if (!cancelled) setList({ status: 'ready', meetings, error: null })
      },
      (err: unknown) => {
        if (cancelled) return
        const error = err instanceof HearthApiError ? err.message : 'Meetings didn’t load.'
        setList((current) => ({ ...current, status: 'error', error }))
      },
    )
    return () => {
      cancelled = true
    }
  }, [key, version])

  useEffect(() => {
    const off = hearthSocket.onChanged((event) => {
      if (event.paths.some((p) => p.startsWith('meetings/'))) setVersion((v) => v + 1)
    })
    return () => {
      off()
    }
  }, [])

  return list
}
