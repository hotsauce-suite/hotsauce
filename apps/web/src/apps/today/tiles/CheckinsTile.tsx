// The Check-in tile (ARCHITECTURE §24.6): questions asked of the member that they haven't
// answered yet. Hidden when there are none.

import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { checkinsApi, type DueCheckin } from '../../../api/checkins'
import { hearthSocket } from '../../../api/ws'
import { Card } from './Card'

const REFRESH_EVERY_MS = 60_000

/** Check-ins asked of the member that they haven't answered yet (ARCHITECTURE §24.6). */
export function CheckinsTile({ editing }: { editing: boolean }) {
  const [due, setDue] = useState<DueCheckin[]>([])
  useEffect(() => {
    let cancelled = false
    const load = () =>
      checkinsApi.due().then(
        (r) => {
          if (!cancelled) setDue(r.due)
        },
        // Today still works without it.
        () => undefined,
      )
    void load()
    const off = hearthSocket.onChanged(() => void load())
    const every = setInterval(() => void load(), REFRESH_EVERY_MS)
    return () => {
      cancelled = true
      off()
      clearInterval(every)
    }
  }, [])
  if (due.length === 0)
    return editing ? (
      <Card title="Check-in" icon="checklist" testId="today-placeholder-checkins">
        <p className="text-sm text-ink-faint">Shows when a check-in is waiting for your answer.</p>
      </Card>
    ) : null
  return (
    <Card title="Check-in" icon="checklist" testId="today-checkins">
      <ul className="flex flex-col gap-2">
        {due.map((c) => (
          <li key={`${c.id}-${c.date}`}>
            <Link
              to={`/checkins/${c.id}`}
              className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-paper-sunk"
              data-testid="today-checkin"
            >
              <span className="min-w-0 flex-1 text-sm font-medium text-ink">{c.title}</span>
              <span className="shrink-0 text-sm text-ember-strong">Answer</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** This browser remembers that the member closed the Mac app card. */
